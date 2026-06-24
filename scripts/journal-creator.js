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
    if (rule.disabled) return;

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

    const items = RuleManager.hasRegions(rule)
      ? await pdfParser.getPagesItemsForRegions(ranges, rule.regions)
      : await pdfParser.getPagesItems(ranges);
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
        section.body, section.bodyItems, rule.children, pdfParser, ranges, journal,
        rule.preserveFormatting ?? false, rule.outputFormat?.paragraphDetection ?? ""
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
  static async _buildBodyHTML(text, bodyItems, children, pdfParser, parentRanges, journal = null, preserveFormatting = false, paragraphDetection = "") {
    if (!text && !bodyItems?.length) return "";

    // Apply strip rules first, then find all qualifying boundary children
    const cleanedItems = RuleManager.stripContent(bodyItems ?? [], children);

    // Helper: strip a single wrapping <p>…</p> so content can flow inline
    const stripP = s => s ? s.replace(/^<p>([\s\S]*)<\/p>$/i, '$1').trim() : '';

    const tableChild      = children?.find(c => c.ruleType === 'create-table'       && !c.disabled) ?? null;
    const formatTextRules = children?.filter(c => c.ruleType === 'create-format-text' && !c.disabled && c.pattern) ?? [];

    const pageChild = children?.find(c =>
      c.ruleType === 'create-page' && !c.disabled &&
      (c.pattern || c.fontSize != null || c.fontNameContains)
    );
    const sectionChildren = children?.filter(c =>
      (c.ruleType === 'create-section' || c.ruleType === 'create-collated-section' || c.ruleType === 'remove-section') &&
      !c.disabled &&
      (c.pattern || c.fontSize != null || c.fontNameContains)
    ) ?? [];

    const primaryChild = pageChild ?? sectionChildren[0] ?? null;

    // Inheritable siblings: table and format-text rules carry down into
    // sub-sections so they cooperate with section-splitting children.
    const inheritableChildren = [
      ...(tableChild ? [tableChild] : []),
      ...formatTextRules,
    ];
    const mergeChildren = (ownChildren) =>
      inheritableChildren.length
        ? [...(ownChildren ?? []), ...inheritableChildren]
        : (ownChildren ?? []);

    // create-table child: parse body items geometrically into an HTML table.
    // If the table rule has font/regex targeting, use it to locate where the
    // table starts — items before the first match are emitted as preamble prose.
    if (tableChild && !primaryChild) {
      if (!cleanedItems.length) return '';
      const tableOpts = {
        firstRowHeader:      tableChild.firstRowHeader      ?? true,
        columnGapMinPt:      tableChild.columnGapMinPt      ?? 4,
        columnGapMultiplier: tableChild.columnGapMultiplier ?? 0,
        maxColumns:          tableChild.maxColumns          ?? 0,
        preserveFormatting:  tableChild.preserveFormatting  ?? preserveFormatting,
      };

      // ── Auto-detect mode ──────────────────────────────────────────────────────
      if (tableChild.autoDetect) {
        const detected = PDFParser.detectTableBoundaries(cleanedItems);
        if (!detected.length) {
          const rawText = cleanedItems.length ? cleanedItems.map(i => i.text).join(' ').trim() : text;
          if (!rawText) return '';
          const formatted = formatTextRules.length
            ? JournalCreator._applyFormatTextRules(rawText, formatTextRules)
            : rawText;
          return `<p>${formatted}</p>`;
        }

        // Build a Set for fast membership test and compute each table's Y-top
        const inTable = new Set(detected.flat());
        const tableRanges = detected.map(tItems => ({
          yMax:  Math.max(...tItems.map(i => i.y)),
          items: tItems,
        })).sort((a, b) => b.yMax - a.yMax);   // top-to-bottom

        // Walk non-table items top-to-bottom, interleaving table HTML
        const allSorted  = [...cleanedItems].sort((a, b) => b.y - a.y);
        let html         = '';
        let proseItems   = [];
        let ti           = 0;

        const flushProse = () => {
          if (!proseItems.length) return;
          const rawText = proseItems.map(i => i.text).join(' ');
          const formatted = formatTextRules.length
            ? JournalCreator._applyFormatTextRules(rawText, formatTextRules)
            : rawText;
          html += `<p>${formatted}</p>`;
          proseItems = [];
        };

        for (const item of allSorted) {
          // Emit any tables whose top (yMax) is above the current item's Y
          while (ti < tableRanges.length && tableRanges[ti].yMax >= item.y) {
            flushProse();
            const { html: tHtml } = PDFParser.parseTableRegion(tableRanges[ti].items, tableOpts);
            if (tHtml) html += tHtml;
            ti++;
          }
          if (!inTable.has(item)) proseItems.push(item);
        }
        // Flush any remaining tables (at or below the last prose item)
        while (ti < tableRanges.length) {
          flushProse();
          const { html: tHtml } = PDFParser.parseTableRegion(tableRanges[ti].items, tableOpts);
          if (tHtml) html += tHtml;
          ti++;
        }
        flushProse();
        return html;
      }

      // ── Targeted mode (existing logic) ───────────────────────────────────────
      const hasCriteria = !!(tableChild.pattern || tableChild.fontSize != null ||
                             tableChild.fontNameContains);
      if (hasCriteria) {
        const sections = RuleManager.splitOnCombinedTargeting(cleanedItems, tableChild);
        let preambleHTML = '';
        const tableItems = [];
        for (const sec of sections) {
          if (sec.match === null) { if (sec.body) preambleHTML += `<p>${sec.body}</p>`; }
          else { tableItems.push(...(sec.titleItems ?? []), ...(sec.bodyItems ?? [])); }
        }
        if (!tableItems.length) return preambleHTML || (text ? `<p>${text}</p>` : '');
        const { html } = PDFParser.parseTableRegion(tableItems, tableOpts);
        return preambleHTML + (html || '');
      }
      const { html } = PDFParser.parseTableRegion(cleanedItems, tableOpts);
      return html || (text ? `<p>${text}</p>` : '');
    }

    if (!primaryChild) {
      // No child rule — render body as final content
      if (cleanedItems.length && paragraphDetection && !formatTextRules.length) {
        return PDFParser.itemsToParagraphedHTML(cleanedItems, {
          mode: paragraphDetection,
          preserveFormatting,
        });
      }
      if (preserveFormatting && cleanedItems.length && !formatTextRules.length) {
        return `<p>${PDFParser.itemsToHTML(cleanedItems)}</p>`;
      }
      const cleanedText = cleanedItems.length ? cleanedItems.map(i => i.text).join(' ').trim() : text;
      if (!cleanedText) return "";
      const formatted = formatTextRules.length
        ? JournalCreator._applyFormatTextRules(cleanedText, formatTextRules)
        : cleanedText;
      return `<p>${formatted}</p>`;
    }

    // Child rule's own preserveFormatting / paragraphDetection settings
    const childPF = primaryChild.preserveFormatting ?? preserveFormatting;
    const childPD = primaryChild.outputFormat?.paragraphDetection ?? "";

    const sections = RuleManager.splitOnCombinedTargeting(cleanedItems, primaryChild);
    const namedSecs = sections.filter(s => s.match !== null);

    // Render a body segment (preamble or inter-section text)
    const renderBody = async (seg) => {
      if (!seg.body && !seg.bodyItems?.length) return "";
      // When inheritable siblings exist, process preamble/inter-section text
      // through _buildBodyHTML so table detection and format-text apply.
      if (inheritableChildren.length && seg.bodyItems?.length) {
        return await JournalCreator._buildBodyHTML(
          seg.body, seg.bodyItems, inheritableChildren, pdfParser, parentRanges, journal, preserveFormatting, paragraphDetection
        );
      }
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
          sec.body, sec.bodyItems, mergeChildren(primaryChild.children), pdfParser, parentRanges, journal, childPF, childPD
        );
        const pageData = {
          name: sec.title,
          type: "text",
          text: { content: subHTML || await renderBody(sec), format: 1 },
        };
        if (primaryChild.targetCategory && categoryMap.has(primaryChild.targetCategory)) {
          pageData.category = categoryMap.get(primaryChild.targetCategory);
        }
        await journal.createEmbeddedDocuments("JournalEntryPage", [pageData]);
      }
      return "";
    }

    // ── Multi-child section cooperation ──────────────────────────────────────
    // When multiple create-section children exist at the same level, combine their
    // boundaries into one pass.  Collate-group children (groupName set) accumulate
    // matches until a plain-section child fires, at which point their group is
    // flushed before the heading is written.
    if (sectionChildren.length > 1) {
      const tagged = RuleManager.splitOnMultipleRules(cleanedItems, sectionChildren);

      // Render and flush a pending collate group for one rule
      const renderCollate = async (rule, secs) => {
        if (!secs.length) return '';
        const rl    = +(rule.outputFormat?.headingLevel ?? 1);
        const af    = rule.outputFormat?.additionalFormatting
          ?? (rule.outputFormat?.asList ? (rule.outputFormat?.listType ?? 'ul') : '');
        const isList = af === 'ul' || af === 'ol';
        const hasGC = rule.children?.some(c => c.ruleType !== 'strip');
        const cPF   = rule.preserveFormatting ?? preserveFormatting;
        const cPD   = rule.outputFormat?.paragraphDetection ?? "";
        const titleHTML = rl > 0 ? `<h${rl}>${rule.groupName}</h${rl}>` : '';
        const parts = [];
        for (const s of secs) {
          const sub = await JournalCreator._buildBodyHTML(s.body, s.bodyItems, mergeChildren(rule.children), pdfParser, parentRanges, journal, cPF, cPD);
          const body = sub || (s.body ? `<p>${s.body}</p>` : '');
          const tp = s.title ? `<strong>${s.title}</strong>` : '';
          if (isList) {
            const bi = hasGC ? body : stripP(body);
            parts.push(`<li>${tp}${bi ? ' ' + bi : ''}</li>`);
          } else if (hasGC) {
            parts.push((tp ? `<p>${tp}</p>` : '') + body);
          } else {
            const bi = stripP(body);
            parts.push(tp + (bi ? ' ' + bi : ''));
          }
        }
        if (isList) return titleHTML + `<${af}>${parts.join('')}</${af}>`;
        const innerContent = hasGC ? parts.join('') : `<p>${parts.join(' ')}</p>`;
        if (af === 'blockquote') return titleHTML + `<blockquote>${innerContent}</blockquote>`;
        if (af === 'pre')        return titleHTML + `<pre><code>${innerContent.replace(/<[^>]*>/g, '')}</code></pre>`;
        if (af === 'secret')     return `<section class="secret">${titleHTML}${innerContent}</section>`;
        return titleHTML + innerContent;
      };

      let html = '';
      const pending = new Map(); // collate rule → accumulated sections

      const flushAll = async () => {
        for (const [rule, secs] of pending) html += await renderCollate(rule, secs);
        pending.clear();
      };

      for (const sec of tagged) {
        if (sec.match === null) {
          await flushAll();
          if (inheritableChildren.length && sec.bodyItems?.length) {
            html += await JournalCreator._buildBodyHTML(sec.body, sec.bodyItems, inheritableChildren, pdfParser, parentRanges, journal, preserveFormatting, paragraphDetection);
          } else if (sec.body) {
            html += `<p>${sec.body}</p>`;
          }
          continue;
        }
        const r = sec.rule;
        if (r.ruleType === 'create-collated-section') {
          if (!pending.has(r)) pending.set(r, []);
          pending.get(r).push(sec);
        } else {
          await flushAll();
          if (r.ruleType === 'remove-section') continue; // drop title + body entirely
          const rl  = +(r.outputFormat?.headingLevel ?? 3);
          const rAF = r.outputFormat?.additionalFormatting
            ?? (r.outputFormat?.asList ? (r.outputFormat?.listType ?? 'ul') : '');
          const rIsList = rAF === 'ul' || rAF === 'ol';
          const cPF = r.preserveFormatting ?? preserveFormatting;
          const rPD = r.outputFormat?.paragraphDetection ?? "";
          const sub = await JournalCreator._buildBodyHTML(sec.body, sec.bodyItems, mergeChildren(r.children), pdfParser, parentRanges, journal, cPF, rPD);
          const body = sub || (sec.body ? `<p>${sec.body}</p>` : '');
          const titleTag = rl > 0 ? `<h${rl}>${sec.title}</h${rl}>` : `<strong>${sec.title}</strong>`;
          if (rIsList) {
            const bi = body.replace(/^<p>([\s\S]*?)<\/p>$/i, '$1').trim();
            html += `${titleTag}<${rAF}><li>${bi}</li></${rAF}>`;
          } else if (rAF === 'blockquote') {
            html += `${titleTag}<blockquote>${body}</blockquote>`;
          } else if (rAF === 'pre') {
            html += `${titleTag}<pre><code>${body.replace(/<[^>]*>/g, '')}</code></pre>`;
          } else if (rAF === 'secret') {
            html += `<section class="secret">${titleTag}${body}</section>`;
          } else {
            html += rl === 0 ? body : titleTag + body;
          }
        }
      }
      await flushAll();
      return html || (text ? `<p>${text}</p>` : '');
    }

    // create-section child: each match becomes an inline heading or formatted block
    const level = +(primaryChild.outputFormat?.headingLevel ?? 3);
    const af    = primaryChild.outputFormat?.additionalFormatting
      ?? (primaryChild.outputFormat?.asList ? (primaryChild.outputFormat?.listType ?? 'ul') : '');
    const isList = af === 'ul' || af === 'ol';

    // Helper: wrap body HTML in the additional-formatting container
    const wrapBody = (bodyHTML, titleText) => {
      if (!af) return bodyHTML;
      const titleTag = level > 0 ? `<h${level}>${titleText}</h${level}>` : `<strong>${titleText}</strong>`;
      if (isList) return bodyHTML; // lists accumulate items externally
      if (af === 'blockquote') return `${titleTag}<blockquote>${bodyHTML}</blockquote>`;
      if (af === 'pre')        return `${titleTag}<pre><code>${bodyHTML.replace(/<[^>]*>/g, '')}</code></pre>`;
      if (af === 'secret')     return `<section class="secret">${titleTag}${bodyHTML}</section>`;
      return bodyHTML;
    };

    // Remove-section mode: matched sections (title + body) are dropped; preamble flows through.
    if (primaryChild.ruleType === 'remove-section') {
      let html = "";
      for (const sec of sections) {
        if (sec.match === null) html += await renderBody(sec);
        // matched sections are silently dropped
      }
      return html || (text ? `<p>${text}</p>` : "");
    }

    // Collate mode: all matches are merged under a single user-defined heading.
    if (primaryChild.ruleType === 'create-collated-section') {
      const groupName = primaryChild.groupName;
      const titleHTML = level > 0 ? `<h${level}>${groupName}</h${level}>` : '';
      const hasGrandchildren = primaryChild.children?.some(c => c.ruleType !== 'strip');
      const inlineBody = (s) => s ? s.replace(/^<p>([\s\S]*)<\/p>$/i, '$1').trim() : '';
      let html = "";
      const collectedHTML = [];
      for (const sec of sections) {
        if (sec.match === null) { html += await renderBody(sec); continue; }
        const subBody = await JournalCreator._buildBodyHTML(
          sec.body, sec.bodyItems, mergeChildren(primaryChild.children), pdfParser, parentRanges, journal, childPF, childPD
        );
        const bodyContent = subBody || await renderBody(sec);
        const titlePart = sec.title ? `<strong>${sec.title}</strong>` : '';
        if (isList) {
          const bodyInner = hasGrandchildren ? bodyContent : inlineBody(bodyContent);
          collectedHTML.push(`<li>${titlePart}${bodyInner ? ' ' + bodyInner : ''}</li>`);
        } else if (hasGrandchildren) {
          collectedHTML.push((titlePart ? `<p>${titlePart}</p>` : '') + bodyContent);
        } else {
          collectedHTML.push(titlePart + (inlineBody(bodyContent) ? ' ' + inlineBody(bodyContent) : ''));
        }
      }
      if (collectedHTML.length) {
        if (isList) {
          html += titleHTML + `<${af}>${collectedHTML.join('')}</${af}>`;
        } else {
          const innerContent = hasGrandchildren ? collectedHTML.join('') : `<p>${collectedHTML.join(' ')}</p>`;
          if (af === 'blockquote')  html += titleHTML + `<blockquote>${innerContent}</blockquote>`;
          else if (af === 'pre')    html += titleHTML + `<pre><code>${innerContent.replace(/<[^>]*>/g, '')}</code></pre>`;
          else if (af === 'secret') html += `<section class="secret">${titleHTML}${innerContent}</section>`;
          else                      html += titleHTML + innerContent;
        }
      }
      return html || (text ? `<p>${text}</p>` : "");
    }

    // Additional-formatting mode: list, blockquote, pre, or secret
    if (af) {
      let html = "";
      for (const sec of sections) {
        if (sec.match === null) { html += await renderBody(sec); continue; }
        const subBody = await JournalCreator._buildBodyHTML(
          sec.body, sec.bodyItems, mergeChildren(primaryChild.children), pdfParser, parentRanges, journal, childPF, childPD
        );
        const body = subBody || await renderBody(sec);
        if (isList) {
          const bodyInner = body.replace(/^<p>([\s\S]*?)<\/p>$/i, '$1').trim();
          const titleTag = level > 0 ? `<h${level}>${sec.title}</h${level}>` : `<strong>${sec.title}</strong>`;
          html += `${titleTag}<${af}><li>${bodyInner}</li></${af}>`;
        } else {
          html += wrapBody(body, sec.title);
        }
      }
      return html || (preserveFormatting && cleanedItems.length ? `<p>${PDFParser.itemsToHTML(cleanedItems)}</p>` : (text ? `<p>${text}</p>` : ""));
    }

    // Heading mode (default): each match becomes a heading + body block
    let html = "";
    for (const sec of sections) {
      if (sec.match === null) { html += await renderBody(sec); continue; }
      const subBody = await JournalCreator._buildBodyHTML(
        sec.body, sec.bodyItems, mergeChildren(primaryChild.children), pdfParser, parentRanges, journal, childPF, childPD
      );
      const body = subBody || await renderBody(sec);
      html += level === 0 ? body : `<h${level}>${sec.title}</h${level}>` + body;
    }
    return html || (preserveFormatting && cleanedItems.length ? `<p>${PDFParser.itemsToHTML(cleanedItems)}</p>` : (text ? `<p>${text}</p>` : ""));
  }

  // ── Format Text ───────────────────────────────────────────────────────────

  /**
   * Apply one or more create-format-text child rules to a plain-text body string.
   * Each rule's regex pattern is matched globally; every match is wrapped in the
   * configured HTML formatting (bold, underline, indent) and/or surrounded by
   * <br> line-return markers.
   */
  static _applyFormatTextRules(text, rules) {
    if (!rules?.length || !text) return text;
    let result = text;
    for (const rule of rules) {
      if (!rule.pattern) continue;
      const fo = rule.formatOptions ?? {};
      try {
        // Ensure global flag so all occurrences are replaced
        const flagStr = (rule.flags || 'g').includes('g') ? (rule.flags || 'g') : (rule.flags || '') + 'g';
        const regex = new RegExp(rule.pattern, flagStr);
        result = result.replace(regex, (match) => {
          let inner = match;
          if (fo.bold)      inner = `<strong>${inner}</strong>`;
          if (fo.underline) inner = `<u>${inner}</u>`;
          if (fo.indent)    inner = `<span style="padding-left:1.5em;">${inner}</span>`;
          const before = fo.lineReturnBefore ? '<br>' : '';
          const after  = fo.lineReturnAfter  ? '<br>'  : '';
          return `${before}${inner}${after}`;
        });
      } catch (e) {
        console.warn('DAJB | Format Text invalid regex:', rule.pattern, e);
      }
    }
    return result;
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
