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
    // ── create-category: meta rule — just ensure the category exists ──────────
    if (rule.ruleType === 'create-category') {
      if (!rule.targetJournal && !rule.name) return;
      const journal = await JournalCreator._getOrCreateJournal(rule.targetJournal || rule.name);
      if (rule.targetCategory) {
        await JournalCreator._ensureCategories(journal, [rule.targetCategory]);
        console.log(`DAJB | Ensured category "${rule.targetCategory}" in "${journal.name}"`);
      }
      return;
    }

    // ── create-page / create-section: text-processing rules ──────────────────
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

    if (rule.ruleType !== 'create-page') return; // create-section at top level has no-op

    const journal = await JournalCreator._getOrCreateJournal(rule.targetJournal || rule.name);

    // Pre-create the target category once before writing any pages
    const categoryMap = new Map();
    if (rule.targetCategory) {
      await JournalCreator._ensureCategories(journal, [rule.targetCategory], categoryMap);
    }

    for (const section of namedSections) {
      const bodyHTML = await JournalCreator._buildBodyHTML(
        section.body, section.bodyItems, rule.children, pdfParser, ranges, journal
      );
      const pageData = {
        name: section.title,
        type: "text",
        text: { content: bodyHTML, format: 1 },
      };
      if (rule.targetCategory && categoryMap.has(rule.targetCategory)) {
        pageData.category = categoryMap.get(rule.targetCategory);
      }
      await journal.createEmbeddedDocuments("JournalEntryPage", [pageData]);
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
  static async _buildBodyHTML(text, bodyItems, children, pdfParser, parentRanges, journal = null, preserveFormatting = false) {
    if (!text && !bodyItems?.length) return "";

    // Apply strip rules first, then find the primary boundary child
    const cleanedItems = RuleManager.stripContent(bodyItems ?? [], children);

    const primaryChild = children?.find(c =>
      (c.ruleType === 'create-page' || c.ruleType === 'create-section') &&
      (c.pattern || c.fontSize != null || c.fontNameContains || c.fontColor)
    );
    if (!primaryChild) {
      // No child rule — render body as final content
      if (preserveFormatting && cleanedItems.length) {
        return `<p>${PDFParser.itemsToHTML(cleanedItems)}</p>`;
      }
      const cleanedText = cleanedItems.length ? cleanedItems.map(i => i.text).join(' ').trim() : text;
      return cleanedText ? `<p>${cleanedText}</p>` : "";
    }

    // Child rule's own preserveFormatting setting (inherits from parent if not set)
    const childPF = primaryChild.preserveFormatting ?? preserveFormatting;

    const sections = RuleManager.splitOnCombinedTargeting(cleanedItems, primaryChild);
    const namedSecs = sections.filter(s => s.match !== null);

    // Render a body segment (preamble or inter-section text)
    const renderBody = (seg) => {
      if (!seg.body && !seg.bodyItems?.length) return "";
      if (childPF && seg.bodyItems?.length) return `<p>${PDFParser.itemsToHTML(seg.bodyItems)}</p>`;
      return seg.body ? `<p>${seg.body}</p>` : "";
    };

    // create-page child: each match becomes its own journal page
    if (primaryChild.ruleType === 'create-page' && journal) {
      const categoryMap = new Map();
      if (primaryChild.targetCategory) {
        await JournalCreator._ensureCategories(journal, [primaryChild.targetCategory], categoryMap);
      }
      for (const sec of namedSecs) {
        const subHTML = await JournalCreator._buildBodyHTML(
          sec.body, sec.bodyItems, primaryChild.children, pdfParser, parentRanges, journal, childPF
        );
        const pageData = {
          name: sec.title,
          type: "text",
          text: { content: subHTML || renderBody(sec), format: 1 },
        };
        if (primaryChild.targetCategory && categoryMap.has(primaryChild.targetCategory)) {
          pageData.category = categoryMap.get(primaryChild.targetCategory);
        }
        await journal.createEmbeddedDocuments("JournalEntryPage", [pageData]);
      }
      return "";
    }

    // create-section child: each match becomes an inline heading or list item
    const level = +(primaryChild.outputFormat?.headingLevel ?? 3);
    const asList = primaryChild.outputFormat?.asList ?? false;
    const listType = primaryChild.outputFormat?.listType ?? 'ul';

    // Collate mode: all matches are merged under a single user-defined heading.
    // Child rules of this rule are still applied to each match's body.
    if (primaryChild.groupName) {
      const groupName = primaryChild.groupName;
      const titleHTML = level > 0 ? `<h${level}>${groupName}</h${level}>` : '';
      // When child rules produce structured HTML (headings, multiple blocks) we
      // preserve that structure. Without child rules, every body is a plain <p>
      // so we strip the wrappers and inline everything into a single paragraph.
      const hasGrandchildren = primaryChild.children?.some(c => c.ruleType !== 'strip');
      // Strip a single wrapping <p> only when the full string is one paragraph
      const inlineBody = (s) => s ? s.replace(/^<p>([\s\S]*)<\/p>$/i, '$1').trim() : '';
      let html = "";
      const collectedHTML = [];
      for (const sec of sections) {
        if (sec.match === null) { html += renderBody(sec); continue; }
        const subBody = await JournalCreator._buildBodyHTML(
          sec.body, sec.bodyItems, primaryChild.children, pdfParser, parentRanges, journal, childPF
        );
        const bodyContent = subBody || renderBody(sec);
        const titlePart = sec.title ? `<strong>${sec.title}</strong>` : '';
        if (asList) {
          const bodyInner = hasGrandchildren ? bodyContent : inlineBody(bodyContent);
          collectedHTML.push(`<li>${titlePart}${bodyInner ? ' ' + bodyInner : ''}</li>`);
        } else if (hasGrandchildren) {
          // Structured child output — keep each block intact, prefix with bold title
          collectedHTML.push((titlePart ? `<p>${titlePart}</p>` : '') + bodyContent);
        } else {
          // No child rules — strip <p> wrappers so everything flows in one paragraph
          collectedHTML.push(titlePart + (inlineBody(bodyContent) ? ' ' + inlineBody(bodyContent) : ''));
        }
      }
      if (collectedHTML.length) {
        if (asList) {
          html += titleHTML + `<${listType}>${collectedHTML.join('')}</${listType}>`;
        } else if (hasGrandchildren) {
          html += titleHTML + collectedHTML.join('');
        } else {
          html += titleHTML + `<p>${collectedHTML.join(' ')}</p>`;
        }
      }
      return html || (text ? `<p>${text}</p>` : "");
    }

    // List mode: preamble as prose, matched sections as <li> items
    if (asList) {
      let html = "";
      const liItems = [];
      for (const sec of sections) {
        if (sec.match === null) { html += renderBody(sec); continue; }
        const subBody = await JournalCreator._buildBodyHTML(
          sec.body, sec.bodyItems, primaryChild.children, pdfParser, parentRanges, journal, childPF
        );
        // Strip wrapping <p>...</p> from subBody so it flows inline with the title
        const bodyInner = subBody
          ? subBody.replace(/^<p>([\s\S]*?)<\/p>$/i, '$1').trim()
          : (sec.body?.trim() ?? '');
        if (level === 0) {
          // Title + body both go in the <li> (no heading tag)
          const content = bodyInner ? `${sec.title} ${bodyInner}` : sec.title;
          liItems.push(`<li>${content}</li>`);
        } else {
          // Heading inside the <li>
          const titleHTML = `<strong>${sec.title}</strong>`;
          const content = bodyInner ? `${titleHTML} ${bodyInner}` : titleHTML;
          liItems.push(`<li>${content}</li>`);
        }
      }
      if (liItems.length) html += `<${listType}>${liItems.join('')}</${listType}>`;
      return html || (preserveFormatting && cleanedItems.length ? `<p>${PDFParser.itemsToHTML(cleanedItems)}</p>` : (text ? `<p>${text}</p>` : ""));
    }

    // Heading mode (default): each match becomes a heading + body block
    let html = "";
    for (const sec of sections) {
      if (sec.match === null) { html += renderBody(sec); continue; }
      const subBody = await JournalCreator._buildBodyHTML(
        sec.body, sec.bodyItems, primaryChild.children, pdfParser, parentRanges, journal, childPF
      );
      const body = subBody || renderBody(sec);
      html += level === 0 ? body : `<h${level}>${sec.title}</h${level}>` + body;
    }
    return html || (preserveFormatting && cleanedItems.length ? `<p>${PDFParser.itemsToHTML(cleanedItems)}</p>` : (text ? `<p>${text}</p>` : ""));
  }

  // ── Text helpers ──────────────────────────────────────────────────────────

  static async _getTextForRule(rule, pdfParser, ranges) {
    const hasFontFilter = rule.fontSize != null || rule.fontNameContains;
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
    const hasFontFilter = rule.fontSize != null || rule.fontNameContains;
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
      // v13: categories live at journal.categories (a Collection), keyed by _id.
      // Convert to a plain array of plain objects we can serialise back.
      const raw = journal.categories ?? [];
      const existing = (typeof raw.values === 'function' ? [...raw.values()] : [...raw])
        .map(c => ({ _id: c._id ?? c.id, name: c.name, sort: c.sort ?? 100000, flags: c.flags ?? {} }));

      const toAdd = [];
      for (const name of unique) {
        const found = existing.find(c => c.name === name);
        if (found) {
          outMap.set(name, found._id);
        } else {
          const newCat = {
            _id: foundry.utils.randomID(),
            name,
            sort: (existing.length + toAdd.length + 1) * 100000,
            flags: {},
          };
          toAdd.push(newCat);
          outMap.set(name, newCat._id);
        }
      }

      if (toAdd.length) {
        // Single update — root-level "categories" array, not system.categories
        await journal.update({ categories: [...existing, ...toAdd] });
      }
    } catch (e) {
      console.warn("DAJB | Could not ensure categories:", e.message);
    }
    return outMap;
  }
}
