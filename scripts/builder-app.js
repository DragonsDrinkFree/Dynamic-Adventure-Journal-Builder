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
      "collapse-rule": function(ev, t) { BuilderApp._onCollapseRule.call(this, ev, t); },
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
          <legend>Font Size Filter</legend>
          <div class="dajb-field-row">
            <label class="dajb-field">
              <span>Min (pt)</span>
              <input type="number" data-field="minFontSize" value="${rule.minFontSize ?? ""}" min="0" step="0.5" placeholder="Any" style="width:70px" />
            </label>
            <label class="dajb-field">
              <span>Max (pt)</span>
              <input type="number" data-field="maxFontSize" value="${rule.maxFontSize ?? ""}" min="0" step="0.5" placeholder="Any" style="width:70px" />
            </label>
          </div>
          <em class="dajb-hint">Pre-filters text by font size before regex runs. Leave blank to match all sizes.</em>
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

    // Refresh preview on pattern/flags/pageRanges/fontSize changes
    if (["pattern", "flags", "pageRanges", "captureGroup", "minFontSize", "maxFontSize"].includes(field)) {
      this._renderPreview();
    }
  }

  // ── Preview Panel ─────────────────────────────────────────────────────────

  async _renderPreview() {
    const container = this.element.querySelector("#dajb-preview-content");
    if (!container) return;

    if (!this.selectedRuleId) {
      container.textContent = "Select a rule to see matches.";
      return;
    }

    const rule = this.ruleManager.getRuleById(this.selectedRuleId);
    if (!rule) return;

    if (!this.pdfParser.totalPages) {
      container.textContent = "Load a PDF to see matches.";
      return;
    }

    const hasFontFilter = rule.minFontSize != null || rule.maxFontSize != null;
    if (!rule.pattern && !hasFontFilter) {
      container.textContent = "Enter a regex pattern or font size filter to see matches.";
      return;
    }

    container.textContent = "Computing…";

    try {
      const isTopLevel = this.ruleManager.getTopLevelRules().some((r) => r.id === rule.id);
      let text;
      if (isTopLevel) {
        const ranges = this.ruleManager.parsePageRanges(rule.pageRanges);
        if (!ranges.length) {
          container.textContent = "Enter page ranges to see matches.";
          return;
        }
        if (hasFontFilter) {
          const items = await this.pdfParser.getPagesItems(ranges);
          const filtered = PDFParser.filterByFontSize(items, rule.minFontSize, rule.maxFontSize);
          text = PDFParser.itemsToText(filtered);
          // If no regex, show filtered text directly as the "match"
          if (!rule.pattern) {
            const escFn = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            container.innerHTML =
              `<div class="dajb-preview-stats">${filtered.length} item${filtered.length !== 1 ? "s" : ""} after font filter</div>` +
              `<pre class="dajb-preview-text">${escFn(text)}</pre>`;
            return;
          }
        } else {
          text = await this.pdfParser.getPagesText(ranges);
        }
      } else {
        // Child rule: preview against first portion of PDF, with optional font filter
        const allRanges = [{ start: 1, end: Math.min(20, this.pdfParser.totalPages) }];
        if (hasFontFilter) {
          const items = await this.pdfParser.getPagesItems(allRanges);
          const filtered = PDFParser.filterByFontSize(items, rule.minFontSize, rule.maxFontSize);
          text = PDFParser.itemsToText(filtered);
          if (!rule.pattern) {
            const escFn = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            container.innerHTML =
              `<div class="dajb-preview-stats">${filtered.length} item${filtered.length !== 1 ? "s" : ""} after font filter (child rule — preview scope: first 20 pages)</div>` +
              `<pre class="dajb-preview-text">${escFn(text)}</pre>`;
            return;
          }
        } else {
          text = await this.pdfParser.getPagesText(allRanges);
        }
      }

      // Validate regex first
      let flags = rule.flags || "gi";
      // Ensure "g" flag so we can iterate all matches
      if (!flags.includes("g")) flags += "g";
      let gRegex;
      try {
        gRegex = new RegExp(rule.pattern, flags);
      } catch (e) {
        container.textContent = `Invalid regex: ${e.message}`;
        return;
      }

      // Collect all match positions
      const simpleMatches = [];
      let sm;
      gRegex.lastIndex = 0;
      while ((sm = gRegex.exec(text)) !== null) {
        simpleMatches.push({ index: sm.index, length: sm[0].length, text: sm[0] });
      }

      // Build highlighted HTML by slicing the original text
      const parts = [];
      let lastIdx = 0;

      const escFn = (s) =>
        s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

      for (const sm2 of simpleMatches) {
        parts.push(escFn(text.slice(lastIdx, sm2.index)));
        parts.push(`<mark class="dajb-match">${escFn(sm2.text)}</mark>`);
        lastIdx = sm2.index + sm2.length;
      }
      parts.push(escFn(text.slice(lastIdx)));

      container.innerHTML =
        `<div class="dajb-preview-stats">${simpleMatches.length} match${simpleMatches.length !== 1 ? "es" : ""}</div>` +
        `<pre class="dajb-preview-text">${parts.join("")}</pre>`;
    } catch (err) {
      container.textContent = `Error: ${err.message}`;
    }
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

  // ── Utility ───────────────────────────────────────────────────────────────

  _esc(str) {
    return (str ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}
