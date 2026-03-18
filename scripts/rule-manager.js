/**
 * RuleManager — manages the tree of parsing rules.
 */
export class RuleManager {
  constructor() {
    /** @type {Array<Object>} */
    this.rules = [];
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  _makeRule(overrides = {}) {
    return {
      id: foundry.utils.randomID(),
      name: "New Rule",
      // "create-category" | "create-page" | "create-section" | "create-collated-section" | "remove-section" | "strip" | "create-table"
      ruleType: "create-section",
      disabled: false,
      // top-level only
      pageRanges: "",
      targetJournal: "",
      // shared
      targetCategory: "",   // category to create (create-category) or place content into (create-page)
      // targeting
      pattern: "",
      flags: "gi",
      captureGroup: 0,
      fontSize: null,
      minFontSize: null,
      maxFontSize: null,
      fontNameContains: "",
      // output
      outputTemplate: "{{match}}",
      preserveFormatting: false,
      breakOnSentence: false, // only split at sentence boundaries (.!?)
      groupName: "",          // if non-empty: all matches are collated under this single heading
      // Table options (used when ruleType === 'create-table')
      firstRowHeader: true,
      columnGapMinPt: 4,
      outputFormat: {
        headingLevel: 2,
        additionalFormatting: "", // "" | "ul" | "ol" | "blockquote" | "pre" | "secret"
        paragraphDetection: "",   // "" | "spacing" | "indent" | "both"
      },
      children: [],
      ...overrides,
    };
  }

  /** Walk the full tree and call cb(rule, parent|null) for every node. */
  _walk(rules, cb, parent = null) {
    for (const rule of rules) {
      cb(rule, parent);
      if (rule.children?.length) this._walk(rule.children, cb, rule);
    }
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────

  /** Create a new rule. If parentId is supplied it becomes a child rule. */
  createRule(parentId = null) {
    let hasPageRule = false;
    this._walk(this.rules, (r) => { if (r.ruleType === 'create-page') hasPageRule = true; });
    const rule = this._makeRule({ ruleType: hasPageRule ? 'create-section' : 'create-page' });
    if (parentId === null) {
      this.rules.push(rule);
    } else {
      const parent = this.getRuleById(parentId);
      if (!parent) throw new Error(`Parent rule ${parentId} not found`);
      parent.children.push(rule);
    }
    return rule;
  }

  deleteRule(id) {
    // Try top-level first
    const topIdx = this.rules.findIndex((r) => r.id === id);
    if (topIdx !== -1) {
      this.rules.splice(topIdx, 1);
      return;
    }
    // Search children
    let deleted = false;
    this._walk(this.rules, (rule) => {
      if (deleted) return;
      const idx = rule.children?.findIndex((c) => c.id === id);
      if (idx !== undefined && idx !== -1) {
        rule.children.splice(idx, 1);
        deleted = true;
      }
    });
  }

  updateRule(id, data) {
    const rule = this.getRuleById(id);
    if (!rule) throw new Error(`Rule ${id} not found`);
    // Merge top-level keys; handle nested outputFormat separately
    const { outputFormat, children, ...rest } = data;
    Object.assign(rule, rest);
    if (outputFormat) Object.assign(rule.outputFormat, outputFormat);
    return rule;
  }

  /**
   * Move rule `id` to a new parent (null = top level) at the given index.
   */
  moveRule(id, newParentId, index = null) {
    // Remove from current location
    let target = null;
    const topIdx = this.rules.findIndex((r) => r.id === id);
    if (topIdx !== -1) {
      [target] = this.rules.splice(topIdx, 1);
    } else {
      this._walk(this.rules, (rule) => {
        if (target) return;
        const idx = rule.children?.findIndex((c) => c.id === id);
        if (idx !== undefined && idx !== -1) {
          [target] = rule.children.splice(idx, 1);
        }
      });
    }
    if (!target) throw new Error(`Rule ${id} not found`);

    // Insert at new location
    const container =
      newParentId === null
        ? this.rules
        : this.getRuleById(newParentId)?.children;
    if (!container) throw new Error(`Parent ${newParentId} not found`);
    if (index === null || index >= container.length) {
      container.push(target);
    } else {
      container.splice(index, 0, target);
    }
  }

  /** Returns [containerArray, index] for the rule, or [null, -1] if not found. */
  _getContainer(id) {
    const topIdx = this.rules.findIndex(r => r.id === id);
    if (topIdx !== -1) return [this.rules, topIdx];
    let result = [null, -1];
    this._walk(this.rules, (rule) => {
      if (result[0]) return;
      const idx = rule.children?.findIndex(c => c.id === id) ?? -1;
      if (idx !== -1) result = [rule.children, idx];
    });
    return result;
  }

  moveRuleUp(id) {
    const [container, idx] = this._getContainer(id);
    if (!container || idx <= 0) return;
    [container[idx - 1], container[idx]] = [container[idx], container[idx - 1]];
  }

  moveRuleDown(id) {
    const [container, idx] = this._getContainer(id);
    if (!container || idx === -1 || idx >= container.length - 1) return;
    [container[idx], container[idx + 1]] = [container[idx + 1], container[idx]];
  }

  getRuleById(id) {
    let found = null;
    this._walk(this.rules, (rule) => {
      if (!found && rule.id === id) found = rule;
    });
    return found;
  }

  getTopLevelRules() {
    return this.rules;
  }

  // ── Serialisation ─────────────────────────────────────────────────────────

  saveToJSON() {
    return JSON.stringify({ rules: this.rules }, null, 2);
  }

  loadFromJSON(json) {
    let data;
    try {
      data = typeof json === "string" ? JSON.parse(json) : json;
    } catch (e) {
      throw new Error("Invalid JSON: " + e.message);
    }
    if (!Array.isArray(data.rules))
      throw new Error('JSON must have a top-level "rules" array');
    this.rules = data.rules;
    this._walk(this.rules, (rule) => {
      // Ensure font size fields exist (min/max are now intentional advanced fields)
      if (rule.fontSize    === undefined) rule.fontSize    = null;
      if (rule.minFontSize === undefined) rule.minFontSize = null;
      if (rule.maxFontSize === undefined) rule.maxFontSize = null;
      // Migrate asList/listType → additionalFormatting
      if (rule.outputFormat && rule.outputFormat.additionalFormatting === undefined) {
        rule.outputFormat.additionalFormatting = rule.outputFormat.asList
          ? (rule.outputFormat.listType ?? 'ul')
          : '';
        delete rule.outputFormat.asList;
        delete rule.outputFormat.listType;
      }
      // Ensure paragraphDetection field exists
      if (rule.outputFormat && rule.outputFormat.paragraphDetection === undefined) {
        rule.outputFormat.paragraphDetection = '';
      }
      // Ensure table-specific fields exist on loaded rules
      if (rule.ruleType === 'create-table') {
        if (rule.firstRowHeader === undefined) rule.firstRowHeader = true;
        if (rule.columnGapMinPt === undefined) rule.columnGapMinPt = 4;
      }
    });
  }

  // ── Page-range parser ─────────────────────────────────────────────────────

  /**
   * "11-50, 61-70, 80" → [{start:11,end:50},{start:61,end:70},{start:80,end:80}]
   */
  parsePageRanges(str) {
    if (!str || !str.trim()) return [];
    return str
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((segment) => {
        const parts = segment.split("-").map((p) => parseInt(p.trim(), 10));
        if (parts.length === 1) return { start: parts[0], end: parts[0] };
        return { start: parts[0], end: parts[1] };
      })
      .filter((r) => !isNaN(r.start) && !isNaN(r.end));
  }

  // ── Text splitting ─────────────────────────────────────────────────────────

  /**
   * Split `text` into sections based on `rule`'s pattern.
   * Each regex match is a section boundary; the body is the text that follows it
   * up to the next match (or end of text).
   *
   * Returns Array<{ match: RegExpMatchArray|null, title: string|null, body: string }>
   * The first element may have match=null when text exists before the first match (preamble).
   */
  static splitOnPattern(text, rule) {
    if (!text) return [];
    if (!rule.pattern) return [{ match: null, title: null, body: text }];

    let flags = rule.flags || 'g';
    if (!flags.includes('g')) flags += 'g';

    let regex;
    try {
      regex = new RegExp(rule.pattern, flags);
    } catch (e) {
      console.warn(`DAJB | Invalid regex in rule "${rule.name}":`, e.message);
      return [{ match: null, title: null, body: text }];
    }

    const allMatches = [...text.matchAll(regex)];
    if (!allMatches.length) return [{ match: null, title: null, body: text }];

    const sections = [];
    const cg = rule.captureGroup ?? 0;

    // Preamble — text before the first match
    if (allMatches[0].index > 0) {
      const pre = text.slice(0, allMatches[0].index).trim();
      if (pre) sections.push({ match: null, title: null, body: pre });
    }

    for (let i = 0; i < allMatches.length; i++) {
      const m = allMatches[i];
      const next = allMatches[i + 1];
      const bodyStart = m.index + m[0].length;
      const bodyEnd = next ? next.index : text.length;

      sections.push({
        match: m,
        title: ((cg > 0 ? m[cg] : m[0]) ?? '').trim(),
        body: text.slice(bodyStart, bodyEnd).trim(),
      });
    }

    return sections;
  }

  /**
   * Returns true when font criteria (size / name) alone define section boundaries.
   * This is the case when there is no regex pattern but at least one font criterion.
   */
  static hasFontTargeting(rule) {
    if (!rule || rule.pattern) return false;
    return rule.fontSize != null || !!rule.fontNameContains;
  }

  /** Test whether a single PDF text item satisfies this rule's font criteria. */
  static _matchesFontCriteria(item, rule) {
    if (rule.fontSize != null || rule.maxFontSize != null) {
      if (rule.maxFontSize != null) {
        // Range mode: fontSize is lower bound (0 if unset), maxFontSize is upper bound
        const min = rule.fontSize ?? 0;
        if (item.fontSize < min || item.fontSize > rule.maxFontSize) return false;
      } else {
        // Decimal-range mode: match any size sharing the same integer part (10 matches 10.0–10.9)
        if (Math.floor(item.fontSize) !== Math.floor(rule.fontSize)) return false;
      }
    }
    if (rule.fontNameContains &&
        !item.fontName?.toLowerCase().includes(rule.fontNameContains.toLowerCase())) return false;
    return true;
  }

  /**
   * Split an array of PDF text items into sections using font criteria as boundaries.
   * Consecutive items that match the font criteria are merged into a section title.
   * Items between boundaries become the section body.
   *
   * Returns Array<{ match: Array|null, title: string|null, body: string, bodyItems: Array }>
   */
  static splitItemsByFont(items, rule) {
    if (!items?.length) return [];

    // Group consecutive items into boundary (b) or body (x) runs
    const runs = [];
    for (const item of items) {
      const type = RuleManager._matchesFontCriteria(item, rule) ? 'b' : 'x';
      if (!runs.length || runs[runs.length - 1].type !== type) {
        runs.push({ type, items: [item] });
      } else {
        runs[runs.length - 1].items.push(item);
      }
    }

    const sections = [];
    let i = 0;

    // Leading preamble (body before first boundary)
    if (runs[0]?.type === 'x') {
      const pre = runs[0].items;
      sections.push({ match: null, title: null, bodyItems: pre, body: pre.map(it => it.text).join(' ').trim() });
      i = 1;
    }

    // Boundary → body pairs
    while (i < runs.length) {
      if (runs[i].type === 'b') {
        const bItems = runs[i].items;
        const title = bItems.map(it => it.text).join(' ').trim();
        i++;
        let bodyItems = [];
        if (i < runs.length && runs[i].type === 'x') {
          bodyItems = runs[i].items;
          i++;
        }
        sections.push({
          match: bItems,
          title,
          bodyItems,
          body: bodyItems.map(it => it.text).join(' ').trim(),
        });
      } else {
        i++;
      }
    }

    return sections;
  }

  /**
   * Unified split: finds section boundaries from font criteria, regex pattern, or both.
   * Font matches and regex matches are each collected as boundaries, then merged by
   * position and deduplicated — so a rule can use regex for numbered headers and font
   * criteria for styled headers simultaneously.  Everything between boundaries becomes
   * the section body, and each section carries its bodyItems for child rules to use.
   *
   * Returns Array<{ match, title: string|null, body: string, bodyItems: Array }>
   * Elements with match === null are preamble (text before the first boundary).
   */
  static splitOnCombinedTargeting(items, rule) {
    if (!items?.length) return [];

    const hasFontCriteria = rule.fontSize != null || rule.minFontSize != null || rule.maxFontSize != null || !!rule.fontNameContains;
    const hasPattern = !!rule.pattern;

    // No targeting at all: everything is body
    if (!hasFontCriteria && !hasPattern) {
      const body = items.map(i => i.text).join(' ').trim();
      return body ? [{ match: null, title: null, body, bodyItems: items }] : [];
    }

    // Build a flat text string and record each item's character range within it
    const offsets = [];
    const parts = [];
    let pos = 0;
    for (const item of items) {
      offsets.push({ start: pos, end: pos + item.text.length });
      parts.push(item.text);
      pos += item.text.length + 1; // +1 for the space separator
    }
    const text = parts.join(' ');

    // Items whose start offset falls in [from, to)
    const sliceItems = (from, to) =>
      offsets.reduce((acc, o, i) => { if (o.start >= from && o.start < to) acc.push(items[i]); return acc; }, []);

    const boundaries = [];

    if (hasFontCriteria && hasPattern) {
      // AND mode: run regex on the full text so mixed-font matches like
      // "4 WORM HOLE" (digit at 8.5pt, title at 13pt) are found.
      // Boundary START = first font-qualifying item in the match (not raw regex
      // match start) — this prevents non-font interstitial text like a page
      // footer between a digit and the actual heading from being swept into
      // titleItems.  Boundary END = last font-qualifying item (prevents greedy
      // regex from pulling in the first capital of the following body word).
      let flags = rule.flags || 'g';
      if (!flags.includes('g')) flags += 'g';
      let regex;
      try { regex = new RegExp(rule.pattern, flags); } catch (e) { /* invalid */ }
      if (regex) {
        for (const m of text.matchAll(regex)) {
          const matchStart = m.index;
          const matchEnd   = m.index + m[0].length;
          let firstFontStart = null, lastFontEnd = null;
          const fontItems = [];
          for (let i = 0; i < items.length; i++) {
            const o = offsets[i];
            if (o.start >= matchStart && o.start < matchEnd &&
                RuleManager._matchesFontCriteria(items[i], rule)) {
              if (firstFontStart === null) firstFontStart = o.start;
              lastFontEnd = o.end;
              fontItems.push(items[i]);
            }
          }
          if (firstFontStart === null) continue; // no font-qualifying items → skip
          // Title is built from font-qualifying items only — the raw regex match
          // may be greedy and consume body text or non-font interstitial text.
          boundaries.push({
            start: firstFontStart,
            end: lastFontEnd,
            title: fontItems.map(i => i.text).join(' ').trim(),
            source: 'both',
            match: m,
          });
        }
      }

    } else if (hasFontCriteria) {
      // Font-only: each run of consecutive matching items is one boundary
      let runStart = null, runEnd = null, runItems = [];
      const flush = () => {
        if (runItems.length) {
          boundaries.push({ start: runStart, end: runEnd, title: runItems.map(i => i.text).join(' ').trim(), source: 'font' });
          runItems = []; runStart = runEnd = null;
        }
      };
      for (let i = 0; i < items.length; i++) {
        if (RuleManager._matchesFontCriteria(items[i], rule)) {
          if (!runItems.length) runStart = offsets[i].start;
          runEnd = offsets[i].end;
          runItems.push(items[i]);
        } else { flush(); }
      }
      flush();

    } else {
      // Regex-only: match against the full text
      let flags = rule.flags || 'g';
      if (!flags.includes('g')) flags += 'g';
      let regex;
      try { regex = new RegExp(rule.pattern, flags); } catch (e) { /* invalid */ }
      if (regex) {
        const cg = rule.captureGroup ?? 0;
        for (const m of text.matchAll(regex)) {
          boundaries.push({ start: m.index, end: m.index + m[0].length, title: (cg > 0 ? m[cg] : m[0])?.trim() ?? '', source: 'regex', match: m });
        }
      }
    }

    // Sentence-boundary filter: discard any boundary not preceded by .!?
    // This prevents mid-sentence bold/formatted text from creating false splits.
    if (rule.breakOnSentence && boundaries.length) {
      const sentenceEnd = /[.!?]$/;
      boundaries.splice(0, boundaries.length,
        ...boundaries.filter(b => {
          if (b.start === 0) return true;
          return sentenceEnd.test(text.slice(0, b.start).trimEnd());
        })
      );
    }

    if (!boundaries.length) {
      return [{ match: null, title: null, body: text.trim(), bodyItems: items }];
    }

    // Sort and deduplicate (first wins on overlap)
    boundaries.sort((a, b) => a.start - b.start);
    const merged = [];
    let lastEnd = 0;
    for (const b of boundaries) {
      if (b.start >= lastEnd) { merged.push(b); lastEnd = b.end; }
    }

    const sections = [];

    // Preamble
    if (merged[0].start > 0) {
      const pre = text.slice(0, merged[0].start).trim();
      if (pre) sections.push({ match: null, title: null, body: pre, bodyItems: sliceItems(0, merged[0].start) });
    }

    for (let i = 0; i < merged.length; i++) {
      const b = merged[i];
      const next = merged[i + 1];
      const bodyStart = b.end;
      const bodyEnd = next ? next.start : text.length;
      sections.push({
        match: b.match ?? b,
        title: b.title,
        body: text.slice(bodyStart, bodyEnd).trim(),
        bodyItems: sliceItems(bodyStart, bodyEnd),
        titleItems: sliceItems(b.start, b.end),
      });
    }

    return sections;
  }

  /**
   * Split items cooperatively across multiple child rules.
   * Each child rule contributes its own boundaries; all boundaries are merged by
   * position and deduplicated (earlier boundary wins on overlap).  Each returned
   * section is tagged with the child rule that owns its boundary so the caller
   * can render it appropriately (e.g. flush a collate group when a plain section fires).
   *
   * Returns Array<{ match, title, titleItems, body, bodyItems, rule: childRule|null }>
   * where rule===null means a preamble/gap segment claimed by no rule.
   */
  static splitOnMultipleRules(items, childRules) {
    if (!items?.length || !childRules?.length) return [];

    // Skip disabled rules and table rules (tables are terminal renderers, not boundary producers)
    childRules = childRules.filter(r => !r.disabled && r.ruleType !== 'create-table');
    if (!childRules.length) {
      const body = items.map(i => i.text).join(' ').trim();
      return body ? [{ match: null, title: null, body, bodyItems: items, rule: null }] : [];
    }

    // Map each item object → its index for O(1) lookup
    const itemToIdx = new Map(items.map((item, i) => [item, i]));

    // Collect all boundaries from all child rules, tagged with the source rule
    const allBoundaries = [];
    for (const rule of childRules) {
      const sections = RuleManager.splitOnCombinedTargeting(items, rule);
      for (const sec of sections) {
        if (sec.match === null || !sec.titleItems?.length) continue;
        const firstIdx = itemToIdx.get(sec.titleItems[0]);
        if (firstIdx === undefined) continue;
        const lastIdx = itemToIdx.get(sec.titleItems[sec.titleItems.length - 1]) ?? firstIdx;
        allBoundaries.push({ itemStart: firstIdx, itemEnd: lastIdx + 1, title: sec.title, titleItems: sec.titleItems, rule });
      }
    }

    if (!allBoundaries.length) {
      const body = items.map(i => i.text).join(' ').trim();
      return body ? [{ match: null, title: null, body, bodyItems: items, rule: null }] : [];
    }

    const isCollated = (r) => r?.ruleType === 'create-collated-section';

    // Sort by position; plain sections beat collate sections at the same position
    // so an explicit create-section rule always wins over a collate rule on the same text.
    allBoundaries.sort((a, b) => {
      if (a.itemStart !== b.itemStart) return a.itemStart - b.itemStart;
      const aC = a.rule?.ruleType === 'create-collated-section' ? 1 : 0;
      const bC = b.rule?.ruleType === 'create-collated-section' ? 1 : 0;
      return aC - bC;
    });
    const merged = [];
    let lastEnd = 0;
    for (const b of allBoundaries) {
      if (b.itemStart >= lastEnd) {
        merged.push(b);
        lastEnd = b.itemEnd;
      } else if (isCollated(merged[merged.length - 1]?.rule) && !isCollated(b.rule)) {
        // A plain-section boundary falls inside a collate boundary (font-only collates produce
        // wide spans).  Truncate the collate to end at the plain section's start so the
        // plain section can claim its text instead of being silently dropped.
        const prev = merged[merged.length - 1];
        const trimmedItems = prev.titleItems.filter(item => (itemToIdx.get(item) ?? Infinity) < b.itemStart);
        if (trimmedItems.length) {
          prev.titleItems = trimmedItems;
          prev.itemEnd   = b.itemStart;
          prev.title     = trimmedItems.map(i => i.text).join(' ').trim();
        } else {
          merged.pop(); // collate had no items before the plain section — drop it
        }
        merged.push(b);
        lastEnd = b.itemEnd;
      }
      // else: skip — a higher-priority boundary already claimed this range
    }

    // Plain-section boundaries "own" all items from their end to the next plain
    // section's start.  Any collate-rule boundaries that land inside that owned
    // span are removed so those items become body text of the plain section
    // instead of spawning a new collate group.
    for (let i = 0; i < merged.length; i++) {
      if (isCollated(merged[i].rule)) continue; // only plain sections claim body
      // Find where this plain section's ownership ends (next plain section start)
      let nextPlainStart = items.length;
      for (let k = i + 1; k < merged.length; k++) {
        if (!isCollated(merged[k].rule)) { nextPlainStart = merged[k].itemStart; break; }
      }
      const bodyStart = merged[i].itemEnd;
      // Remove collate boundaries whose start falls inside [bodyStart, nextPlainStart)
      let j = i + 1;
      while (j < merged.length) {
        if (isCollated(merged[j].rule) &&
            merged[j].itemStart >= bodyStart &&
            merged[j].itemStart < nextPlainStart) {
          merged.splice(j, 1);
        } else {
          j++;
        }
      }
    }

    const toText = (arr) => arr.map(i => i.text).join(' ').trim();
    const result = [];

    // Preamble before first boundary
    if (merged[0].itemStart > 0) {
      const bodyItems = items.slice(0, merged[0].itemStart);
      result.push({ match: null, title: null, body: toText(bodyItems), bodyItems, rule: null });
    }

    for (let i = 0; i < merged.length; i++) {
      const b = merged[i];
      const next = merged[i + 1];
      const bodyItems = items.slice(b.itemEnd, next ? next.itemStart : items.length);
      result.push({ match: b, title: b.title, titleItems: b.titleItems, body: toText(bodyItems), bodyItems, rule: b.rule });
    }

    return result;
  }

  /**
   * Apply all strip-type children to an items array, returning the cleaned result.
   * Strip rules are processed before boundary children split the body.
   */
  static stripContent(items, children) {
    const strips = children?.filter(c => c.ruleType === 'strip' && !c.disabled) ?? [];
    if (!strips.length) return items;
    let current = items;
    for (const rule of strips) {
      current = RuleManager._applyStrip(current, rule);
      // Recursively apply any strip children of this strip rule
      if (rule.children?.length) current = RuleManager.stripContent(current, rule.children);
    }
    return current;
  }

  static _applyStrip(items, rule) {
    const hasFontCriteria = rule.fontSize != null || rule.minFontSize != null || rule.maxFontSize != null || !!rule.fontNameContains;
    const hasPattern = !!rule.pattern;
    if (!hasFontCriteria && !hasPattern) return items;

    // Build per-item offsets in the joined text (used by regex path)
    let pos = 0;
    const itemRanges = items.map(item => {
      const r = { start: pos, end: pos + item.text.length };
      pos += item.text.length + 1;
      return r;
    });

    const buildRegex = () => {
      let flags = rule.flags || 'g';
      if (!flags.includes('g')) flags += 'g';
      try { return new RegExp(rule.pattern, flags); } catch (e) { return null; }
    };

    if (hasFontCriteria && !hasPattern) {
      // Font-only: drop all font-matching items
      return items.filter(item => !RuleManager._matchesFontCriteria(item, rule));
    }

    if (hasFontCriteria && hasPattern) {
      // AND: drop items that match font criteria AND whose text falls within a regex match
      // on the font-filtered sub-text
      const regex = buildRegex();
      if (!regex) return items;

      // Build filtered text from font-matching items with their positions in the original array
      let fp = 0;
      const fontIdxs = [], filtRanges = [];
      items.forEach((item, i) => {
        if (RuleManager._matchesFontCriteria(item, rule)) {
          filtRanges.push({ start: fp, end: fp + item.text.length });
          fontIdxs.push(i);
          fp += item.text.length + 1;
        }
      });
      const filtText = fontIdxs.map(i => items[i].text).join(' ');

      const toRemove = new Set();
      for (const m of filtText.matchAll(regex)) {
        const mEnd = m.index + m[0].length;
        filtRanges.forEach((fr, fi) => {
          if (fr.start >= m.index && fr.end <= mEnd) toRemove.add(fontIdxs[fi]);
        });
      }
      return items.filter((_, i) => !toRemove.has(i));
    }

    // Regex-only: remove items that lie entirely within a regex match range
    const text = items.map(i => i.text).join(' ');
    const regex = buildRegex();
    if (!regex) return items;
    const stripRanges = [...text.matchAll(regex)].map(m => ({ start: m.index, end: m.index + m[0].length }));
    if (!stripRanges.length) return items;
    return items.filter((_, i) => {
      const r = itemRanges[i];
      return !stripRanges.some(sr => r.start >= sr.start && r.end <= sr.end);
    });
  }

  /**
   * Walk the rule tree and return the path [ancestor, ..., rule] for the given id.
   * Returns [] if not found.
   */
  getPathToRule(id) {
    const path = [];
    const search = (rules, currentPath) => {
      for (const rule of rules) {
        const p = [...currentPath, rule];
        if (rule.id === id) { path.push(...p); return true; }
        if (rule.children?.length && search(rule.children, p)) return true;
      }
      return false;
    };
    search(this.rules, []);
    return path;
  }

  /** Returns the top-level rule that contains the given rule id (or the rule itself). */
  getTopLevelAncestor(id) {
    return this.getPathToRule(id)[0] ?? null;
  }
}
