import { PDFParser } from "./pdf-parser.js";

/**
 * JournalCreator — takes the rule tree and parsed PDF text and builds
 * Foundry JournalEntry documents.
 */
export class JournalCreator {
  /**
   * Entry point.
   * @param {import('./rule-manager.js').RuleManager} ruleManager
   * @param {import('./pdf-parser.js').PDFParser} pdfParser
   */
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
        console.error(`DAJB | Error processing rule "${rule.name}":`, err);
        ui.notifications.error(`DAJB | Error in rule "${rule.name}": ${err.message}`);
      }
    }

    ui.notifications.info("DAJB | Journal build complete!");
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  static async _processTopRule(rule, ruleManager, pdfParser) {
    const ranges = ruleManager.parsePageRanges(rule.pageRanges);
    const hasFontFilter = rule.minFontSize != null || rule.maxFontSize != null;
    let text;
    let pageItems = null;
    if (hasFontFilter) {
      pageItems = await pdfParser.getPagesItems(ranges);
      const filtered = PDFParser.filterByFontSize(pageItems, rule.minFontSize, rule.maxFontSize);
      text = PDFParser.itemsToText(filtered);
    } else {
      text = await pdfParser.getPagesText(ranges);
      pageItems = null; // will be fetched lazily if children need it
    }
    const matches = JournalCreator._runRegex(text, rule);

    if (!matches.length) {
      console.log(`DAJB | Rule "${rule.name}" — no matches found.`);
      return;
    }

    // Resolve/create target journal
    const journal = await JournalCreator._getOrCreateJournal(rule.targetJournal || rule.name);

    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      const title = JournalCreator._resolveTitle(match, rule);
      const content = JournalCreator._applyTemplate(match, rule);
      const htmlContent = JournalCreator._applyOutputFormat(content, rule.outputFormat);

      // Determine category
      let category = null;
      if (rule.targetCategory) {
        if (rule.categoryMode === "dynamic") {
          category = await JournalCreator._getOrCreateCategory(journal, title);
        } else {
          category = await JournalCreator._getOrCreateCategory(journal, rule.targetCategory);
        }
      }

      if (rule.createsNewPage) {
        const pageData = {
          name: title,
          type: "text",
          text: { content: htmlContent, format: 1 },
        };
        if (category) pageData.category = category;
        await journal.createEmbeddedDocuments("JournalEntryPage", [pageData]);
      }

      // Process children against the matched text (and parent page items for font size filtering)
      if (rule.children?.length) {
        const matchedText = match[0]; // full match string
        for (const child of rule.children) {
          await JournalCreator._processChildRule(child, matchedText, pageItems, pdfParser, ranges, journal, category);
        }
      }
    }
  }

  /**
   * @param {Object} rule
   * @param {string} text - the parent match text (or font-filtered text)
   * @param {Array|null} parentItems - page items from the parent's page range (for font filtering)
   * @param {Object} pdfParser
   * @param {Array} parentRanges - page ranges of the top-level ancestor
   * @param {Object} journal
   * @param {*} parentCategory
   */
  static async _processChildRule(rule, text, parentItems, pdfParser, parentRanges, journal, parentCategory) {
    const hasFontFilter = rule.minFontSize != null || rule.maxFontSize != null;
    let workingText = text;

    if (hasFontFilter) {
      // Font filter applies to the parent's page items; we further filter to text
      // that overlaps the parent match. For the prototype we filter the full page items.
      let items = parentItems;
      if (!items) {
        items = await pdfParser.getPagesItems(parentRanges);
      }
      const filtered = PDFParser.filterByFontSize(items, rule.minFontSize, rule.maxFontSize);
      workingText = PDFParser.itemsToText(filtered);
    }

    const matches = JournalCreator._runRegex(workingText, rule);
    if (!matches.length) return;

    for (const match of matches) {
      const title = JournalCreator._resolveTitle(match, rule);
      const content = JournalCreator._applyTemplate(match, rule);
      const htmlContent = JournalCreator._applyOutputFormat(content, rule.outputFormat);

      if (rule.createsNewPage) {
        const pageData = {
          name: title,
          type: "text",
          text: { content: htmlContent, format: 1 },
        };
        if (parentCategory) pageData.category = parentCategory;
        await journal.createEmbeddedDocuments("JournalEntryPage", [pageData]);
      }

      if (rule.children?.length) {
        for (const child of rule.children) {
          await JournalCreator._processChildRule(child, match[0], parentItems, pdfParser, parentRanges, journal, parentCategory);
        }
      }
    }
  }

  // ── Regex helpers ─────────────────────────────────────────────────────────

  static _runRegex(text, rule) {
    if (!rule.pattern) return [];
    let regex;
    try {
      regex = new RegExp(rule.pattern, rule.flags || "gi");
    } catch (e) {
      console.warn(`DAJB | Invalid regex in rule "${rule.name}":`, e.message);
      return [];
    }
    const matches = [];
    let m;
    // If "g" flag present iterate; otherwise single match
    if (regex.global || regex.sticky) {
      while ((m = regex.exec(text)) !== null) {
        matches.push(m);
        if (!regex.global && !regex.sticky) break;
      }
    } else {
      m = regex.exec(text);
      if (m) matches.push(m);
    }
    return matches;
  }

  static _resolveTitle(match, rule) {
    const cg = rule.captureGroup ?? 0;
    return (cg > 0 ? match[cg] : match[0]) || "Untitled";
  }

  static _applyTemplate(match, rule) {
    let tpl = rule.outputTemplate || "{{match}}";
    tpl = tpl.replace(/\{\{match\}\}/g, match[0] ?? "");
    // {{group1}}, {{group2}}, …
    for (let i = 1; i < match.length; i++) {
      tpl = tpl.replace(new RegExp(`\\{\\{group${i}\\}\\}`, "g"), match[i] ?? "");
    }
    return tpl;
  }

  static _applyOutputFormat(content, fmt) {
    if (!fmt) return `<p>${content}</p>`;
    let html = content;

    if (fmt.headingLevel && fmt.headingLevel >= 1 && fmt.headingLevel <= 6) {
      const h = fmt.headingLevel;
      html = `<h${h}>${content}</h${h}>`;
    } else if (fmt.asList) {
      const tag = fmt.listType === "ol" ? "ol" : "ul";
      html = `<${tag}><li>${content}</li></${tag}>`;
    } else {
      html = `<p>${content}</p>`;
    }
    return html;
  }

  // ── Foundry document helpers ──────────────────────────────────────────────

  static async _getOrCreateJournal(name) {
    // Look for existing journal by name
    let journal = game.journal.find((j) => j.name === name);
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
   * Get or create a category on a journal (Foundry v13 feature).
   * Returns the category id string or null if not supported.
   */
  static async _getOrCreateCategory(journal, categoryName) {
    if (!categoryName) return null;

    // v13 journals have a `categories` array in their system data
    // Access via journal.system?.categories or journal.getFlag approach
    // The v13 API uses journal.categories on the document
    try {
      const cats = journal.categories ?? journal.system?.categories ?? [];
      const existing = cats.find((c) => c.name === categoryName);
      if (existing) return existing.id ?? existing._id ?? existing.name;

      // Create new category — v13 API
      if (typeof journal.createCategory === "function") {
        const cat = await journal.createCategory({ name: categoryName });
        return cat.id ?? cat._id ?? categoryName;
      }

      // Fallback: update the journal document directly
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
