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
