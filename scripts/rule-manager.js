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
      // top-level only
      pageRanges: "",
      targetJournal: "",
      targetCategory: "",
      categoryMode: "static",
      // shared
      createsNewPage: true,
      pattern: "",
      flags: "gi",
      captureGroup: 0,
      minFontSize: null,
      maxFontSize: null,
      fontNameContains: "",
      fontColor: "",
      outputTemplate: "{{match}}",
      outputFormat: {
        headingLevel: 0,
        asList: false,
        listType: "ul",
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
    const rule = this._makeRule();
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
    return rule.minFontSize != null || rule.maxFontSize != null || !!rule.fontNameContains || !!rule.fontColor;
  }

  /** Test whether a single PDF text item satisfies this rule's font criteria. */
  static _matchesFontCriteria(item, rule) {
    if (rule.minFontSize != null && item.fontSize < rule.minFontSize) return false;
    if (rule.maxFontSize != null && item.fontSize > rule.maxFontSize) return false;
    if (rule.fontNameContains &&
        !item.fontName?.toLowerCase().includes(rule.fontNameContains.toLowerCase())) return false;
    if (rule.fontColor && item.color !== rule.fontColor.toLowerCase()) return false;
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

    const hasFontCriteria = rule.minFontSize != null || rule.maxFontSize != null ||
                            !!rule.fontNameContains || !!rule.fontColor;
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
      // AND mode: run regex only on font-filtered text, then map matches back to
      // original text positions so body slicing still works on the full item stream.
      const filtParts = [], filtOffsets = [], origStarts = [], origEnds = [];
      let fp = 0;
      for (let i = 0; i < items.length; i++) {
        if (RuleManager._matchesFontCriteria(items[i], rule)) {
          filtOffsets.push({ start: fp, end: fp + items[i].text.length });
          origStarts.push(offsets[i].start);
          origEnds.push(offsets[i].end);
          filtParts.push(items[i].text);
          fp += items[i].text.length + 1;
        }
      }
      const filtText = filtParts.join(' ');

      let flags = rule.flags || 'g';
      if (!flags.includes('g')) flags += 'g';
      let regex;
      try { regex = new RegExp(rule.pattern, flags); } catch (e) { /* invalid */ }
      if (regex && filtText) {
        const cg = rule.captureGroup ?? 0;
        for (const m of filtText.matchAll(regex)) {
          // Find which filtered-item index this match starts in
          let fi = filtOffsets.findIndex(fo => fo.start <= m.index && m.index < fo.end);
          if (fi < 0) fi = filtOffsets.findIndex(fo => fo.start > m.index); // gap → next item
          if (fi < 0) continue;
          // Find last filtered-item index the match touches
          const mEnd = m.index + m[0].length;
          let li = fi;
          while (li + 1 < filtOffsets.length && filtOffsets[li + 1].start < mEnd) li++;
          boundaries.push({
            start: origStarts[fi],
            end: origEnds[li],
            title: (cg > 0 ? m[cg] : m[0])?.trim() ?? '',
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
      });
    }

    return sections;
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
