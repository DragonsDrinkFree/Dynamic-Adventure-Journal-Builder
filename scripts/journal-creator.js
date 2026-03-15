import { PDFParser } from "./pdf-parser.js";
import { RuleManager } from "./rule-manager.js";

/**
 * JournalCreator — builds Foundry JournalEntry documents from the rule tree
 * using the "split-on-match" paradigm: each regex match is a section boundary,
 * and the body content is all text between consecutive boundaries.
 */
export class JournalCreator {
  static async build(ruleManager, pdfParser) {
    if (!pdfParser.totalPages) {
      ui.notifications.warn("DAJB | No PDF loaded — cannot build journal.");
      return;
    }
    const topRules = ruleManager.getTopLevelRules();
    if (!topRules.length) {
      ui.notifications.warn("DAJB | No rules defined.");
      return;
    }

    ui.notifications.info("DAJB | Building adventure journal…");

    for (const rule of topRules) {
      try {
        await JournalCreator._processTopRule(rule, ruleManager, pdfParser);
      } catch (err) {
        console.error(`DAJB | Error in rule "${rule.name}":`, err);
        ui.notifications.error(`DAJB | Error in rule "${rule.name}": ${err.message}`);
      }
    }

    ui.notifications.info("DAJB | Build complete!");
  }

  // ── Top-level rule ────────────────────────────────────────────────────────

  static async _processTopRule(rule, ruleManager, pdfParser) {
    const ranges = ruleManager.parsePageRanges(rule.pageRanges);
    if (!ranges.length) {
      console.warn(`DAJB | Rule "${rule.name}" has no valid page ranges.`);
      return;
    }

    const items = await pdfParser.getPagesItems(ranges);
    const sections = RuleManager.splitOnCombinedTargeting(items, rule);
    const namedSections = sections.filter(s => s.match !== null);

    if (!namedSections.length) {
      console.log(`DAJB | Rule "${rule.name}" — no matches found.`);
      return;
    }

    const journal = await JournalCreator._getOrCreateJournal(rule.targetJournal || rule.name);

    // Pre-create all categories in one batch before any pages are written.
    // This prevents the race where a page is created before its category exists.
    const categoryMap = new Map(); // catName → id
    if (rule.targetCategory) {
      const needed = rule.categoryMode === "dynamic"
        ? namedSections.map(s => s.title)
        : [rule.targetCategory];
      await JournalCreator._ensureCategories(journal, needed, categoryMap);
    }

    for (const section of namedSections) {
      const catName = rule.targetCategory
        ? (rule.categoryMode === "dynamic" ? section.title : rule.targetCategory)
        : null;

      const bodyHTML = await JournalCreator._buildBodyHTML(
        section.body, section.bodyItems, rule.children, pdfParser, ranges, journal
      );

      if (rule.createsNewPage) {
        const pageData = {
          name: section.title,
          type: "text",
          text: { content: bodyHTML, format: 1 },
        };
        if (catName && categoryMap.has(catName)) pageData.category = categoryMap.get(catName);
        await journal.createEmbeddedDocuments("JournalEntryPage", [pageData]);
      }
    }
  }

  // ── Recursive body builder ────────────────────────────────────────────────

  /**
   * Build HTML for section body text, applying child rules recursively.
   * The first child rule with a pattern acts as the primary splitter.
   * Text between child matches is output as paragraphs.
   * If no child rules, the raw text is wrapped in <p>.
   */
  /**
   * Build the HTML body for a section, applying child rules recursively.
   * If a child rule has createsNewPage=true it creates actual journal pages (and
   * returns "" so nothing is inlined into the parent).  Otherwise sections are
   * rendered as headings inside the parent page's HTML.
   * `journal` is the parent JournalEntry; required when any child creates pages.
   */
  static async _buildBodyHTML(text, bodyItems, children, pdfParser, parentRanges, journal = null) {
    if (!text && !bodyItems?.length) return "";

    // Apply strip rules first, then find the primary boundary child
    const cleanedItems = RuleManager.stripContent(bodyItems ?? [], children);

    const primaryChild = children?.find(c => c.ruleType !== 'strip' && (c.pattern || c.minFontSize != null || c.maxFontSize != null || c.fontNameContains || c.fontColor));
    if (!primaryChild) {
      const cleanedText = cleanedItems.length ? cleanedItems.map(i => i.text).join(' ').trim() : text;
      return cleanedText ? `<p>${cleanedText}</p>` : "";
    }

    const sections = RuleManager.splitOnCombinedTargeting(cleanedItems, primaryChild);

    // If this child rule creates pages, build them as journal pages (not inline HTML)
    if (primaryChild.createsNewPage && journal) {
      const namedSecs = sections.filter(s => s.match !== null);

      // Pre-create all categories before writing pages
      const categoryMap = new Map();
      if (primaryChild.targetCategory) {
        const needed = primaryChild.categoryMode === "dynamic"
          ? namedSecs.map(s => s.title)
          : [primaryChild.targetCategory];
        await JournalCreator._ensureCategories(journal, needed, categoryMap);
      }

      for (const sec of namedSecs) {
        const catName = primaryChild.targetCategory
          ? (primaryChild.categoryMode === "dynamic" ? sec.title : primaryChild.targetCategory)
          : null;
        const subHTML = await JournalCreator._buildBodyHTML(
          sec.body, sec.bodyItems, primaryChild.children, pdfParser, parentRanges, journal
        );
        const pageData = {
          name: sec.title,
          type: "text",
          text: { content: subHTML || (sec.body ? `<p>${sec.body}</p>` : ""), format: 1 },
        };
        if (catName && categoryMap.has(catName)) pageData.category = categoryMap.get(catName);
        await journal.createEmbeddedDocuments("JournalEntryPage", [pageData]);
      }
      return ""; // parent page body gets nothing; child pages hold the content
    }

    // Otherwise render as inline headings inside the parent page
    let html = "";
    for (const sec of sections) {
      if (sec.match === null) {
        if (sec.body) html += `<p>${sec.body}</p>`;
        continue;
      }
      const level = primaryChild.outputFormat?.headingLevel || 3;
      const titleHTML = `<h${level}>${sec.title}</h${level}>`;
      const subBody = await JournalCreator._buildBodyHTML(
        sec.body, sec.bodyItems, primaryChild.children, pdfParser, parentRanges, journal
      );
      html += titleHTML + (subBody || (sec.body ? `<p>${sec.body}</p>` : ""));
    }

    return html || (text ? `<p>${text}</p>` : "");
  }

  // ── Text helpers ──────────────────────────────────────────────────────────

  static async _getTextForRule(rule, pdfParser, ranges) {
    const hasFontFilter = rule.minFontSize != null || rule.maxFontSize != null || rule.fontNameContains;
    if (hasFontFilter) {
      const items = await pdfParser.getPagesItems(ranges);
      const filtered = PDFParser.filterByCriteria(items, rule);
      return PDFParser.itemsToText(filtered);
    }
    return pdfParser.getPagesText(ranges);
  }

  /**
   * For child rules: if the child has a font size filter, apply it to the
   * parent page items (not the already-filtered child text).
   * Otherwise return the text as-is.
   */
  static async _getFilteredText(text, rule, pdfParser, parentRanges) {
    const hasFontFilter = rule.minFontSize != null || rule.maxFontSize != null || rule.fontNameContains;
    if (hasFontFilter && parentRanges && pdfParser) {
      const items = await pdfParser.getPagesItems(parentRanges);
      const filtered = PDFParser.filterByCriteria(items, rule);
      return PDFParser.itemsToText(filtered);
    }
    return text;
  }

  // ── Foundry document helpers ──────────────────────────────────────────────

  static async _getOrCreateJournal(name) {
    let journal = game.journal.find(j => j.name === name);
    if (!journal) {
      journal = await JournalEntry.create({
        name,
        ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
      });
      console.log(`DAJB | Created journal: ${name}`);
    }
    return journal;
  }

  /**
   * Ensure all named categories exist on the journal in a single update.
   * Populates `outMap` (name → id) for every name in `names`.
   * Calling this once before page creation avoids the race where pages are
   * written before their category exists in the journal document.
   */
  static async _ensureCategories(journal, names, outMap = new Map()) {
    const unique = [...new Set(names.filter(Boolean))];
    if (!unique.length) return outMap;
    try {
      // Re-read live categories from the document each time
      const cats = foundry.utils.deepClone(
        journal.categories ?? journal.system?.categories ?? []
      );
      const toAdd = [];
      for (const name of unique) {
        const existing = cats.find(c => c.name === name);
        if (existing) {
          outMap.set(name, existing.id ?? existing._id ?? name);
        } else {
          const newCat = { id: foundry.utils.randomID(), name };
          cats.push(newCat);
          toAdd.push(newCat);
          outMap.set(name, newCat.id);
        }
      }
      if (toAdd.length) {
        // One update — all new categories land in the journal simultaneously
        await journal.update({ "system.categories": cats });
      }
    } catch (e) {
      console.warn("DAJB | Could not ensure categories:", e.message);
    }
    return outMap;
  }
}
