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

    for (const section of namedSections) {
      let category = null;
      if (rule.targetCategory) {
        const catName = rule.categoryMode === "dynamic" ? section.title : rule.targetCategory;
        category = await JournalCreator._getOrCreateCategory(journal, catName);
      }

      const bodyHTML = await JournalCreator._buildBodyHTML(
        section.body, section.bodyItems, rule.children, pdfParser, ranges
      );

      if (rule.createsNewPage) {
        const pageData = {
          name: section.title,
          type: "text",
          text: { content: bodyHTML, format: 1 },
        };
        if (category) pageData.category = category;
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
  static async _buildBodyHTML(text, bodyItems, children, pdfParser, parentRanges) {
    if (!text && !bodyItems?.length) return "";

    const primaryChild = children?.find(c => c.pattern || c.minFontSize != null || c.maxFontSize != null || c.fontNameContains || c.fontColor);
    if (!primaryChild) {
      return text ? `<p>${text}</p>` : "";
    }

    const sections = RuleManager.splitOnCombinedTargeting(bodyItems ?? [], primaryChild);

    let html = "";

    for (const sec of sections) {
      if (sec.match === null) {
        if (sec.body) html += `<p>${sec.body}</p>`;
        continue;
      }

      const level = primaryChild.outputFormat?.headingLevel || 3;
      const titleHTML = `<h${level}>${sec.title}</h${level}>`;
      const subBody = await JournalCreator._buildBodyHTML(
        sec.body, sec.bodyItems, primaryChild.children, pdfParser, parentRanges
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

  static async _getOrCreateCategory(journal, categoryName) {
    if (!categoryName) return null;
    try {
      const cats = journal.categories ?? journal.system?.categories ?? [];
      const existing = cats.find(c => c.name === categoryName);
      if (existing) return existing.id ?? existing._id ?? existing.name;

      if (typeof journal.createCategory === "function") {
        const cat = await journal.createCategory({ name: categoryName });
        return cat.id ?? cat._id ?? categoryName;
      }

      const existingCats = foundry.utils.deepClone(cats);
      const newCat = { id: foundry.utils.randomID(), name: categoryName };
      existingCats.push(newCat);
      await journal.update({ "system.categories": existingCats });
      return newCat.id;
    } catch (e) {
      console.warn("DAJB | Could not create category:", e.message);
      return null;
    }
  }
}
