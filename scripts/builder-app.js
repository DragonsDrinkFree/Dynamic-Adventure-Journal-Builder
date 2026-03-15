import { RuleManager } from "./rule-manager.js";
import { PDFParser } from "./pdf-parser.js";
import { JournalCreator } from "./journal-creator.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class BuilderApp extends HandlebarsApplicationMixin(ApplicationV2) {
  // ── ApplicationV2 config ─────────────────────────────────────────────────

  static DEFAULT_OPTIONS = {
    id: "dajb-builder",
    window: {
      title: "Adventure Journal Builder",
      resizable: true,
    },
    position: {
      width: 1100,
      height: 700,
    },
    classes: ["dajb-builder"],
    actions: {
      "load-pdf":      function(ev, t) { BuilderApp._onLoadPDF.call(this, ev, t); },
      "load-rules":    function(ev, t) { BuilderApp._onLoadRules.call(this, ev, t); },
      "save-rules":    function(ev, t) { BuilderApp._onSaveRules.call(this, ev, t); },
      "build-journal": function(ev, t) { BuilderApp._onBuildJournal.call(this, ev, t); },
      "add-top-rule":  function(ev, t) { BuilderApp._onAddTopRule.call(this, ev, t); },
      "add-child-rule":function(ev, t) { BuilderApp._onAddChildRule.call(this, ev, t); },
      "delete-rule":   function(ev, t) { BuilderApp._onDeleteRule.call(this, ev, t); },
      "select-rule":   function(ev, t) { BuilderApp._onSelectRule.call(this, ev, t); },
      "collapse-rule":    function(ev, t) { BuilderApp._onCollapseRule.call(this, ev, t); },
      "inspect-fonts":    function(ev, t) { BuilderApp._onInspectFonts.call(this, ev, t); },
    },
  };

  static PARTS = {
    main: {
      template:
        "modules/dynamic-adventure-journal-builder/templates/builder-app.hbs",
    },
  };

  // ── Constructor ───────────────────────────────────────────────────────────

  constructor(options = {}) {
    super(options);
    this.ruleManager = new RuleManager();
    this.pdfParser = new PDFParser();
    this.selectedRuleId = null;
    this._pdfFileName = null;
    this._collapsedIds = new Set();
    this._inspectingFonts = false;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async _prepareContext(options) {
    return {
      pdfLoaded: this.pdfParser.totalPages > 0,
      pdfFileName: this._pdfFileName,
      pdfPages: this.pdfParser.totalPages,
    };
  }

  _onRender(context, options) {
    // ApplicationV2: super._onRender may not exist on all versions; call safely
    if (typeof super._onRender === "function") super._onRender(context, options);
    this._renderRulesTree();
    this._renderEditor();
    this._renderPreview();
  }

  // ── Rules Tree ────────────────────────────────────────────────────────────

  _renderRulesTree() {
    const container = this.element.querySelector("#dajb-rules-tree");
    if (!container) return;
    container.innerHTML = "";
    const rules = this.ruleManager.getTopLevelRules();
    if (!rules.length) {
      container.innerHTML = '<div class="dajb-empty">No rules yet. Click + to add one.</div>';
      return;
    }
    for (const rule of rules) {
      container.appendChild(this._buildRuleNode(rule, 0));
    }
  }

  _buildRuleNode(rule, depth) {
    const isSelected = rule.id === this.selectedRuleId;
    const isCollapsed = this._collapsedIds.has(rule.id);
    const hasChildren = rule.children?.length > 0;

    const item = document.createElement("div");
    item.className = "dajb-rule-item" + (isSelected ? " selected" : "");
    item.dataset.ruleId = rule.id;
    item.style.paddingLeft = `${depth * 16 + 8}px`;

    // Collapse toggle
    const toggle = document.createElement("span");
    toggle.className = "dajb-rule-toggle";
    if (hasChildren) {
      toggle.textContent = isCollapsed ? "▶" : "▼";
      toggle.dataset.action = "collapse-rule";
      toggle.dataset.ruleId = rule.id;
      toggle.title = isCollapsed ? "Expand" : "Collapse";
    } else {
      toggle.textContent = "•";
      toggle.style.opacity = "0.3";
    }
    item.appendChild(toggle);

    // Label
    const label = document.createElement("span");
    label.className = "dajb-rule-label";
    label.textContent = rule.name || "(unnamed)";
    label.dataset.action = "select-rule";
    label.dataset.ruleId = rule.id;
    item.appendChild(label);

    const wrapper = document.createElement("div");
    wrapper.appendChild(item);

    // Children
    if (hasChildren && !isCollapsed) {
      const childContainer = document.createElement("div");
      childContainer.className = "dajb-rule-children";
      for (const child of rule.children) {
        childContainer.appendChild(this._buildRuleNode(child, depth + 1));
      }
      wrapper.appendChild(childContainer);
    }

    return wrapper;
  }

  // ── Editor Panel ──────────────────────────────────────────────────────────

  _renderEditor() {
    const panel = this.element.querySelector("#dajb-editor-panel");
    if (!panel) return;

    if (!this.selectedRuleId) {
      panel.innerHTML = '<div class="dajb-no-selection">Select a rule to edit</div>';
      return;
    }

    const rule = this.ruleManager.getRuleById(this.selectedRuleId);
    if (!rule) {
      panel.innerHTML = '<div class="dajb-no-selection">Rule not found</div>';
      return;
    }

    const isTopLevel = this.ruleManager.getTopLevelRules().some((r) => r.id === rule.id);
    panel.innerHTML = this._buildEditorHTML(rule, isTopLevel);

    // Attach live-update listeners
    panel.querySelectorAll("[data-field]").forEach((el) => {
      const evt = el.type === "checkbox" ? "change" : "input";
      el.addEventListener(evt, (e) => this._onFieldChange(e, rule.id));
    });
  }

  _buildEditorHTML(rule, isTopLevel) {
    const fmt = rule.outputFormat;
    return `
      <div class="dajb-editor-form">
        <div class="dajb-editor-header">
          <strong>${isTopLevel ? "Section Rule" : "Child Rule"}</strong>
          <div class="dajb-editor-actions">
            ${isTopLevel ? `<button type="button" data-action="add-child-rule" title="Add child rule">+ Child</button>` : ""}
            <button type="button" data-action="delete-rule" class="dajb-btn-danger" title="Delete this rule">Delete</button>
          </div>
        </div>

        <label class="dajb-field">
          <span>Name</span>
          <input type="text" data-field="name" value="${this._esc(rule.name)}" />
        </label>

        ${isTopLevel ? `
        <label class="dajb-field">
          <span>Page Ranges</span>
          <input type="text" data-field="pageRanges" value="${this._esc(rule.pageRanges)}" placeholder="e.g. 11-50, 61-70" />
        </label>
        <label class="dajb-field">
          <span>Target Journal</span>
          <input type="text" data-field="targetJournal" value="${this._esc(rule.targetJournal)}" placeholder="Journal name" />
        </label>
        <label class="dajb-field">
          <span>Target Category</span>
          <input type="text" data-field="targetCategory" value="${this._esc(rule.targetCategory)}" placeholder="Category name" />
        </label>
        <label class="dajb-field">
          <span>Category Mode</span>
          <select data-field="categoryMode">
            <option value="static" ${rule.categoryMode === "static" ? "selected" : ""}>Static (one category)</option>
            <option value="dynamic" ${rule.categoryMode === "dynamic" ? "selected" : ""}>Dynamic (one per match)</option>
          </select>
        </label>
        ` : ""}

        <label class="dajb-field dajb-field-check">
          <input type="checkbox" data-field="createsNewPage" ${rule.createsNewPage ? "checked" : ""} />
          <span>Each match creates a new page</span>
        </label>

        <fieldset class="dajb-fieldset">
          <legend>Font Targeting</legend>
          <div class="dajb-field-row">
            <label class="dajb-field">
              <span>Min Size (pt)</span>
              <input type="number" data-field="minFontSize" value="${rule.minFontSize ?? ""}" min="0" step="0.5" placeholder="Any" style="width:70px" />
            </label>
            <label class="dajb-field">
              <span>Max Size (pt)</span>
              <input type="number" data-field="maxFontSize" value="${rule.maxFontSize ?? ""}" min="0" step="0.5" placeholder="Any" style="width:70px" />
            </label>
          </div>
          <label class="dajb-field">
            <span>Font Name Contains</span>
            <input type="text" data-field="fontNameContains" value="${this._esc(rule.fontNameContains ?? '')}" placeholder="e.g. Bold, Garamond" />
          </label>
          <label class="dajb-field">
            <span>Font Color</span>
            <div class="dajb-color-field">
              ${rule.fontColor ? `<span class="dajb-color-swatch" style="background:${this._esc(rule.fontColor)}"></span>` : ''}
              <input type="text" data-field="fontColor" value="${this._esc(rule.fontColor ?? '')}" placeholder="#rrggbb (from Inspector)" class="dajb-monospace" style="width:140px" />
            </div>
          </label>
          <em class="dajb-hint">Use the Fonts inspector to discover font names and colors. With no regex pattern, font criteria alone defines section boundaries — each matching run becomes the section title.</em>
        </fieldset>

        <fieldset class="dajb-fieldset">
          <legend>Regex Pattern</legend>
          <label class="dajb-field">
            <span>Pattern</span>
            <input type="text" data-field="pattern" value="${this._esc(rule.pattern)}" placeholder="e.g. ^## (.+)$  (leave blank to match all font-filtered text)" class="dajb-monospace" />
          </label>
          <label class="dajb-field">
            <span>Flags</span>
            <input type="text" data-field="flags" value="${this._esc(rule.flags)}" placeholder="gi" style="width:60px" />
          </label>
          <label class="dajb-field">
            <span>Title Capture Group</span>
            <input type="number" data-field="captureGroup" value="${rule.captureGroup ?? 0}" min="0" style="width:60px" />
            <em class="dajb-hint">0 = full match</em>
          </label>
        </fieldset>

        <fieldset class="dajb-fieldset">
          <legend>Output</legend>
          <label class="dajb-field">
            <span>Template</span>
            <textarea data-field="outputTemplate" rows="3" class="dajb-monospace">${this._esc(rule.outputTemplate)}</textarea>
          </label>
          <em class="dajb-hint">Use {{match}}, {{group1}}, {{group2}}, …</em>
          <label class="dajb-field">
            <span>Heading Level</span>
            <select data-field="outputFormat.headingLevel">
              ${[0,1,2,3,4,5,6].map(n => `<option value="${n}" ${fmt.headingLevel === n ? "selected" : ""}>${n === 0 ? "None" : `H${n}`}</option>`).join("")}
            </select>
          </label>
          <label class="dajb-field dajb-field-check">
            <input type="checkbox" data-field="outputFormat.asList" ${fmt.asList ? "checked" : ""} />
            <span>Wrap in list</span>
          </label>
          <label class="dajb-field">
            <span>List Type</span>
            <select data-field="outputFormat.listType">
              <option value="ul" ${fmt.listType === "ul" ? "selected" : ""}>Unordered (ul)</option>
              <option value="ol" ${fmt.listType === "ol" ? "selected" : ""}>Ordered (ol)</option>
            </select>
          </label>
        </fieldset>
      </div>
    `;
  }

  _onFieldChange(event, ruleId) {
    const el = event.currentTarget;
    const field = el.dataset.field;
    let value;

    if (el.type === "checkbox") {
      value = el.checked;
    } else if (el.type === "number") {
      // minFontSize / maxFontSize are nullable — empty string means "no filter"
      const nullable = field === "minFontSize" || field === "maxFontSize";
      value = (nullable && el.value === "") ? null : Number(el.value);
    } else if (el.tagName === "SELECT" && field === "outputFormat.headingLevel") {
      value = Number(el.value);
    } else {
      value = el.value;
    }

    // Handle nested fields like "outputFormat.headingLevel"
    if (field.includes(".")) {
      const [parent, child] = field.split(".");
      const rule = this.ruleManager.getRuleById(ruleId);
      if (!rule) return;
      const nested = { ...rule[parent], [child]: value };
      this.ruleManager.updateRule(ruleId, { [parent]: nested });
    } else {
      this.ruleManager.updateRule(ruleId, { [field]: value });
    }

    // Update rule label in tree if name changed
    if (field === "name") {
      const label = this.element.querySelector(
        `.dajb-rule-item[data-rule-id="${ruleId}"] .dajb-rule-label`
      );
      if (label) label.textContent = value || "(unnamed)";
    }

    // Refresh preview (or keep inspector open) on targeting-related changes
    if (["pattern", "flags", "pageRanges", "captureGroup", "minFontSize", "maxFontSize", "fontNameContains", "fontColor"].includes(field)) {
      if (this._inspectingFonts) {
        this._renderFontInspector();
      } else {
        this._renderPreview();
      }
    }
  }

  // ── Preview Panel ─────────────────────────────────────────────────────────

  async _renderPreview() {
    const container = this.element?.querySelector("#dajb-preview-content");
    if (!container) return;

    if (!this.selectedRuleId) {
      container.innerHTML = '<div class="dajb-preview-empty">Select a rule to see the document structure.</div>';
      return;
    }
    if (!this.pdfParser.totalPages) {
      container.innerHTML = '<div class="dajb-preview-empty">Load a PDF to see the document structure.</div>';
      return;
    }

    const topRule = this.ruleManager.getTopLevelAncestor(this.selectedRuleId);
    if (!topRule) return;

    container.innerHTML = '<div class="dajb-preview-empty">Building preview…</div>';

    try {
      const ranges = this.ruleManager.parsePageRanges(topRule.pageRanges);
      if (!ranges.length) {
        container.innerHTML = '<div class="dajb-preview-empty">Set page ranges on the top-level rule to see structure.</div>';
        return;
      }

      const items = await this.pdfParser.getPagesItems(ranges);
      const sections = RuleManager.splitOnCombinedTargeting(items, topRule);
      const named = sections.filter(s => s.match);

      const wrap = document.createElement("div");
      wrap.className = "dajb-preview-doc";

      const stats = document.createElement("div");
      stats.className = "dajb-preview-stats";
      stats.textContent = `${named.length} section${named.length !== 1 ? "s" : ""} — ${topRule.name}`;
      wrap.appendChild(stats);

      let shown = 0;
      for (const sec of sections) {
        if (sec.match && shown >= 20) {
          const more = document.createElement("div");
          more.className = "dajb-preview-more";
          more.textContent = `… ${named.length - 20} more sections not shown`;
          wrap.appendChild(more);
          break;
        }
        if (sec.match) shown++;
        wrap.appendChild(this._buildSectionEl(sec, topRule, 0));
      }

      container.innerHTML = "";
      container.appendChild(wrap);
    } catch (err) {
      container.innerHTML = `<div class="dajb-preview-empty">Error: ${err.message}</div>`;
      console.error("DAJB preview error", err);
    }
  }

  /**
   * Build a DOM element representing one section (or preamble) of the document.
   * Recursively applies child rules to the section body.
   */
  _buildSectionEl(sec, rule, depth) {
    const MAX_BODY = 500;
    const isActiveLevel = rule.id === this.selectedRuleId;

    const el = document.createElement("div");

    if (sec.match === null) {
      // Preamble text — shown greyed out
      el.className = "dajb-preview-preamble";
      const preview = sec.body.slice(0, MAX_BODY);
      el.textContent = preview + (sec.body.length > MAX_BODY ? "…" : "");
      return el;
    }

    el.className = `dajb-preview-section depth-${depth}${isActiveLevel ? " active-rule" : ""}`;

    // Section title
    const titleEl = document.createElement("div");
    titleEl.className = "dajb-preview-section-title";
    titleEl.textContent = sec.title;
    el.appendChild(titleEl);

    if (sec.bodyItems?.length || sec.body) {
      const childRule = rule.children?.find(c => c.pattern || c.minFontSize != null || c.maxFontSize != null || c.fontNameContains || c.fontColor);
      if (childRule) {
        const childSections = RuleManager.splitOnCombinedTargeting(sec.bodyItems ?? [], childRule);
        for (const childSec of childSections) {
          el.appendChild(this._buildSectionEl(childSec, childRule, depth + 1));
        }
      } else {
        // No child rule — show raw body text
        const bodyEl = document.createElement("div");
        bodyEl.className = "dajb-preview-body-text";
        const preview = sec.body.slice(0, MAX_BODY);
        bodyEl.textContent = preview + (sec.body.length > MAX_BODY ? "…" : "");
        el.appendChild(bodyEl);
      }
    }

    return el;
  }

  /** Get text for a rule, applying font criteria as a pre-filter when paired with a regex. */
  async _getTextForRule(rule, ranges) {
    const hasFontFilter = rule.minFontSize != null || rule.maxFontSize != null || rule.fontNameContains;
    if (hasFontFilter) {
      const items = await this.pdfParser.getPagesItems(ranges);
      const filtered = PDFParser.filterByCriteria(items, rule);
      return PDFParser.itemsToText(filtered);
    }
    return this.pdfParser.getPagesText(ranges);
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  static async _onLoadPDF(event, target) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".pdf,application/pdf";
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        await this.pdfParser.loadPDF(file);
        this._pdfFileName = file.name;
        // Update status bar without full re-render
        const status = this.element.querySelector("#dajb-pdf-status");
        if (status) status.textContent = `${file.name} (${this.pdfParser.totalPages} pages)`;
        const loadBtn = this.element.querySelector("[data-action='load-pdf']");
        if (loadBtn) loadBtn.textContent = "Change PDF";
        ui.notifications.info(`DAJB | Loaded: ${file.name}`);
        this._renderPreview();
      } catch (e) {
        ui.notifications.error(`DAJB | Failed to load PDF: ${e.message}`);
        console.error(e);
      }
    };
    input.click();
  }

  static async _onLoadRules(event, target) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        this.ruleManager.loadFromJSON(text);
        this.selectedRuleId = null;
        this._renderRulesTree();
        this._renderEditor();
        this._renderPreview();
        ui.notifications.info("DAJB | Rules loaded.");
      } catch (e) {
        ui.notifications.error(`DAJB | Failed to load rules: ${e.message}`);
      }
    };
    input.click();
  }

  static _onSaveRules(event, target) {
    const json = this.ruleManager.saveToJSON();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "dajb-rules.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  static async _onBuildJournal(event, target) {
    await JournalCreator.build(this.ruleManager, this.pdfParser);
  }

  static _onAddTopRule(event, target) {
    const rule = this.ruleManager.createRule(null);
    this.selectedRuleId = rule.id;
    this._renderRulesTree();
    this._renderEditor();
    this._renderPreview();
  }

  static _onAddChildRule(event, target) {
    if (!this.selectedRuleId) {
      ui.notifications.warn("DAJB | Select a rule first.");
      return;
    }
    const child = this.ruleManager.createRule(this.selectedRuleId);
    this.selectedRuleId = child.id;
    this._renderRulesTree();
    this._renderEditor();
    this._renderPreview();
  }

  static _onDeleteRule(event, target) {
    if (!this.selectedRuleId) return;
    const rule = this.ruleManager.getRuleById(this.selectedRuleId);
    if (!rule) return;
    this.ruleManager.deleteRule(this.selectedRuleId);
    this.selectedRuleId = null;
    this._renderRulesTree();
    this._renderEditor();
    this._renderPreview();
  }

  static _onSelectRule(event, target) {
    const ruleId = target.dataset.ruleId ?? target.closest("[data-rule-id]")?.dataset.ruleId;
    if (!ruleId) return;
    this.selectedRuleId = ruleId;
    // Update selection highlight without full re-render
    this.element.querySelectorAll(".dajb-rule-item").forEach((el) => {
      el.classList.toggle("selected", el.dataset.ruleId === ruleId);
    });
    this._renderEditor();
    this._renderPreview();
  }

  static _onCollapseRule(event, target) {
    event.stopPropagation();
    const ruleId = target.dataset.ruleId;
    if (!ruleId) return;
    if (this._collapsedIds.has(ruleId)) this._collapsedIds.delete(ruleId);
    else this._collapsedIds.add(ruleId);
    this._renderRulesTree();
  }

  // ── Font Inspector ────────────────────────────────────────────────────────

  static _onInspectFonts(event, target) {
    this._inspectingFonts = !this._inspectingFonts;
    const btn = this.element.querySelector("[data-action='inspect-fonts']");
    if (btn) btn.classList.toggle("active", this._inspectingFonts);
    if (this._inspectingFonts) {
      this._renderFontInspector();
    } else {
      this._renderPreview();
    }
  }

  async _renderFontInspector() {
    const container = this.element?.querySelector("#dajb-preview-content");
    if (!container) return;

    if (!this.pdfParser.totalPages) {
      container.innerHTML = '<div class="dajb-preview-empty">Load a PDF first.</div>';
      return;
    }

    const topRule = this.selectedRuleId
      ? this.ruleManager.getTopLevelAncestor(this.selectedRuleId)
      : this.ruleManager.getTopLevelRules()[0];

    if (!topRule) {
      container.innerHTML = '<div class="dajb-preview-empty">Select or create a rule with page ranges set.</div>';
      return;
    }

    const ranges = this.ruleManager.parsePageRanges(topRule.pageRanges);
    if (!ranges.length) {
      container.innerHTML = '<div class="dajb-preview-empty">Set page ranges on the top-level rule first.</div>';
      return;
    }

    container.innerHTML = '<div class="dajb-preview-empty">Scanning fonts…</div>';

    try {
      const items = await this.pdfParser.getPagesItems(ranges);
      const summary = PDFParser.getFontSummary(items);

      const wrap = document.createElement('div');
      wrap.className = 'dajb-font-inspector';

      const hdr = document.createElement('div');
      hdr.className = 'dajb-font-inspector-header';
      hdr.textContent = `${summary.length} font/size combinations — ${items.length} total items — pages ${topRule.pageRanges}`;
      wrap.appendChild(hdr);

      const table = document.createElement('table');
      table.className = 'dajb-font-table';
      table.innerHTML = `<thead><tr>
        <th></th><th>Font Name</th><th>Size (pt)</th><th>Color</th><th>Count</th><th>Sample Text</th>
      </tr></thead>`;

      const canApply = !!this.selectedRuleId;
      const tbody = document.createElement('tbody');
      for (const row of summary) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="dajb-font-apply-cell">
            ${canApply ? `<button type="button" class="dajb-icon-btn dajb-font-apply-btn" title="Apply to selected rule">+</button>` : ''}
          </td>
          <td class="dajb-monospace dajb-font-name">${this._esc(row.fontName || '(unknown)')}</td>
          <td class="dajb-font-size">${row.fontSize}</td>
          <td class="dajb-font-color">
            <span class="dajb-color-swatch" style="background:${this._esc(row.color)}"></span>
            <span class="dajb-monospace">${this._esc(row.color)}</span>
          </td>
          <td class="dajb-font-count">${row.count}</td>
          <td class="dajb-font-sample">${this._esc(row.sample)}</td>
        `;
        if (canApply) {
          tr.querySelector('.dajb-font-apply-btn').addEventListener('click', () => {
            this.ruleManager.updateRule(this.selectedRuleId, {
              fontNameContains: row.fontName,
              fontColor: row.color !== '#000000' ? row.color : '',
              minFontSize: row.fontSize,
              maxFontSize: row.fontSize,
            });
            this._renderEditor();
            this._renderFontInspector();
          });
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      wrap.appendChild(table);

      container.innerHTML = '';
      container.appendChild(wrap);
    } catch (err) {
      container.innerHTML = `<div class="dajb-preview-empty">Error: ${err.message}</div>`;
      console.error('DAJB font inspector error', err);
    }
  }

  // ── Utility ───────────────────────────────────────────────────────────────

  _esc(str) {
    return (str ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}
