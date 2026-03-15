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
      "move-rule-up":     function(ev, t) { BuilderApp._onMoveRuleUp.call(this, ev, t); },
      "move-rule-down":   function(ev, t) { BuilderApp._onMoveRuleDown.call(this, ev, t); },
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
    this._selectionToolbar = null;
    this._selectionChangeBound = null;
    this._selectionDebounce = null;
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
    this._setupSelectionListener();
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
    label.dataset.action = "select-rule";
    label.dataset.ruleId = rule.id;
    const typeInfo = { "create-category": ["cat","#7ec8e3"], "create-page": ["page","#9ade9a"], "strip": ["strip","#e07878"] };
    const ti = typeInfo[rule.ruleType];
    if (ti) {
      const badge = document.createElement("span");
      badge.className = "dajb-type-badge";
      badge.style.color = ti[1];
      badge.style.borderColor = ti[1];
      badge.textContent = ti[0];
      label.appendChild(badge);
    }
    label.appendChild(document.createTextNode(rule.name || "(unnamed)"));
    item.appendChild(label);

    // Order buttons
    const orderBtns = document.createElement("span");
    orderBtns.className = "dajb-rule-order";
    const btnUp = document.createElement("button");
    btnUp.type = "button"; btnUp.textContent = "▲"; btnUp.title = "Move up";
    btnUp.dataset.action = "move-rule-up"; btnUp.dataset.ruleId = rule.id;
    const btnDown = document.createElement("button");
    btnDown.type = "button"; btnDown.textContent = "▼"; btnDown.title = "Move down";
    btnDown.dataset.action = "move-rule-down"; btnDown.dataset.ruleId = rule.id;
    orderBtns.appendChild(btnUp);
    orderBtns.appendChild(btnDown);
    item.appendChild(orderBtns);

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
    const type = rule.ruleType ?? 'create-section';
    const isCat     = type === 'create-category';
    const isPage    = type === 'create-page';
    const isSection = type === 'create-section';
    const isStrip   = type === 'strip';
    const hasTargeting = !isCat;
    const hasOutput    = isPage || isSection;

    const headerClass = isCat ? 'category-header' : isStrip ? 'strip-header' : '';
    const canHaveChildren = isPage || isSection;

    const fontTargetingFields = `
      <fieldset class="dajb-fieldset">
        <legend>Font Targeting</legend>
        <label class="dajb-field">
          <span>Font Size (pt)</span>
          <input type="number" data-field="fontSize" value="${rule.fontSize ?? ""}" min="0" step="0.5" placeholder="Any" style="width:80px" />
        </label>
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
        <em class="dajb-hint">Font + regex = AND (both must match). Use the Fonts inspector to discover values.</em>
      </fieldset>`;

    const regexFields = `
      <fieldset class="dajb-fieldset">
        <legend>Regex Pattern</legend>
        <label class="dajb-field">
          <span>Pattern</span>
          <input type="text" data-field="pattern" value="${this._esc(rule.pattern)}" placeholder="e.g. ^## (.+)$" class="dajb-monospace" />
        </label>
        <label class="dajb-field">
          <span>Flags</span>
          <input type="text" data-field="flags" value="${this._esc(rule.flags)}" placeholder="gi" style="width:60px" />
        </label>
        ${!isStrip ? `
        <label class="dajb-field">
          <span>Title Capture Group</span>
          <input type="number" data-field="captureGroup" value="${rule.captureGroup ?? 0}" min="0" style="width:60px" />
          <em class="dajb-hint">0 = full match</em>
        </label>` : ""}
      </fieldset>`;

    return `
      <div class="dajb-editor-form">
        <div class="dajb-editor-header ${headerClass}">
          <strong>${isTopLevel ? "Top-Level Rule" : "Child Rule"}</strong>
          <div class="dajb-editor-actions">
            ${canHaveChildren ? `<button type="button" data-action="add-child-rule" title="Add child rule">+ Child</button>` : ""}
            <button type="button" data-action="delete-rule" class="dajb-btn-danger">Delete</button>
          </div>
        </div>

        <label class="dajb-field">
          <span>Name</span>
          <input type="text" data-field="name" value="${this._esc(rule.name)}" />
        </label>

        <label class="dajb-field">
          <span>Rule Type</span>
          <select data-field="ruleType">
            <option value="create-category" ${isCat     ? "selected" : ""}>Create Category — meta rule, no text processing</option>
            <option value="create-page"     ${isPage    ? "selected" : ""}>Create Page — each match becomes a journal page</option>
            <option value="create-section"  ${isSection ? "selected" : ""}>Create Section — each match becomes a heading</option>
            <option value="strip"           ${isStrip   ? "selected" : ""}>Strip — removes matched text</option>
          </select>
        </label>

        ${isTopLevel ? `
        ${!isCat ? `
        <label class="dajb-field">
          <span>Page Ranges</span>
          <input type="text" data-field="pageRanges" value="${this._esc(rule.pageRanges)}" placeholder="e.g. 11-50, 61-70" />
        </label>` : ""}
        <label class="dajb-field">
          <span>Target Journal</span>
          <input type="text" data-field="targetJournal" value="${this._esc(rule.targetJournal)}" placeholder="Journal name" />
        </label>
        ` : ""}

        ${!isStrip ? `
        <label class="dajb-field">
          <span>${isCat ? "Category Name" : "Target Category"}</span>
          <input type="text" data-field="targetCategory" value="${this._esc(rule.targetCategory)}"
            placeholder="${isCat ? "Name of category to create" : "Category to place items into"}" />
        </label>
        ${isCat ? `<em class="dajb-hint" style="color:#7ec8e3;padding:0 4px 8px">Place this rule above any Create Page rules that use this category.</em>` : ""}
        ` : ""}

        ${isStrip ? `<em class="dajb-hint dajb-strip-hint">Matched text is removed before boundary rules run.</em>` : ""}

        ${hasTargeting ? fontTargetingFields : ""}
        ${hasTargeting ? regexFields : ""}

        ${hasOutput ? `
        <fieldset class="dajb-fieldset">
          <legend>Output</legend>
          <label class="dajb-field">
            <span>Template</span>
            <textarea data-field="outputTemplate" rows="2" class="dajb-monospace">${this._esc(rule.outputTemplate)}</textarea>
          </label>
          <em class="dajb-hint">{{match}}, {{group1}}, {{group2}}, …</em>
          <label class="dajb-field dajb-field-check">
            <input type="checkbox" data-field="preserveFormatting" ${rule.preserveFormatting ? "checked" : ""} />
            <span>Preserve bold / italic from PDF</span>
          </label>
          <em class="dajb-hint">Detected from font name (e.g. "Bold", "Italic"). Underline is not available from PDF text data.</em>
          ${isSection ? `
          <label class="dajb-field">
            <span>Heading Level</span>
            <select data-field="outputFormat.headingLevel">
              ${[1,2,3,4,5,6].map(n => `<option value="${n}" ${fmt.headingLevel === n ? "selected" : ""}">H${n}</option>`).join("")}
            </select>
          </label>` : ""}
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
        ` : ""}
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
      // fontSize is nullable — empty string means "no filter"
      const nullable = field === "fontSize";
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

    // Re-render editor when rule type changes (form shape differs per type)
    if (field === "ruleType") {
      this._renderRulesTree(); // update icon/style in tree
      this._renderEditor();
      if (this._inspectingFonts) this._renderFontInspector(); else this._renderPreview();
      return;
    }

    // Update rule label in tree if name changed
    if (field === "name") {
      const label = this.element.querySelector(
        `.dajb-rule-item[data-rule-id="${ruleId}"] .dajb-rule-label`
      );
      if (label) label.textContent = value || "(unnamed)";
    }

    // Refresh preview (or keep inspector open) on targeting-related changes
    if (["pattern", "flags", "pageRanges", "captureGroup", "fontSize", "fontNameContains", "fontColor"].includes(field)) {
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

    this._dismissSelectionToolbar();
    window.getSelection()?.removeAllRanges();
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
      // Preamble text — shown greyed out, rendered as item spans for selectability
      el.className = "dajb-preview-preamble";
      if (sec.bodyItems?.length) {
        const limit = 150;
        for (const item of sec.bodyItems.slice(0, limit)) {
          const span = document.createElement("span");
          span.className = "dajb-preview-item";
          span.textContent = item.text;
          span.dataset.fontSize = item.fontSize;
          span.dataset.fontName = item.fontName;
          span.dataset.color    = item.color;
          span.dataset.isBold   = item.isBold;
          span.dataset.isItalic = item.isItalic;
          el.appendChild(span);
          el.appendChild(document.createTextNode(" "));
        }
        if (sec.bodyItems.length > limit) {
          const more = document.createElement("span");
          more.className = "dajb-preview-more-inline";
          more.textContent = `… (${sec.bodyItems.length - limit} more)`;
          el.appendChild(more);
        }
      } else {
        el.textContent = sec.body.slice(0, MAX_BODY) + (sec.body.length > MAX_BODY ? "…" : "");
      }
      return el;
    }

    el.className = `dajb-preview-section depth-${depth}${isActiveLevel ? " active-rule" : ""}`;

    // Section title — render as selectable item spans when underlying items are available
    const titleEl = document.createElement("div");
    titleEl.className = "dajb-preview-section-title";
    if (sec.titleItems?.length) {
      for (const item of sec.titleItems) {
        const span = document.createElement("span");
        span.className = "dajb-preview-item";
        span.textContent = item.text;
        span.dataset.fontSize = item.fontSize;
        span.dataset.fontName = item.fontName;
        span.dataset.color    = item.color;
        span.dataset.isBold   = item.isBold;
        span.dataset.isItalic = item.isItalic;
        titleEl.appendChild(span);
        titleEl.appendChild(document.createTextNode(" "));
      }
    } else {
      titleEl.textContent = sec.title;
    }
    el.appendChild(titleEl);

    if (sec.bodyItems?.length || sec.body) {
      // 1. Apply strip rules first to clean the body items
      const strippedItems = RuleManager.stripContent(sec.bodyItems ?? [], rule.children);
      const hadStrips = rule.children?.some(c => c.ruleType === 'strip');
      if (hadStrips && strippedItems.length < (sec.bodyItems?.length ?? 0)) {
        const indicator = document.createElement("div");
        indicator.className = "dajb-preview-strip-indicator";
        const removed = (sec.bodyItems?.length ?? 0) - strippedItems.length;
        indicator.textContent = `✂ ${removed} item${removed !== 1 ? "s" : ""} stripped`;
        el.appendChild(indicator);
      }

      // 2. Find first boundary child and split the (now stripped) body
      const childRule = rule.children?.find(c => c.ruleType !== 'strip' && (c.pattern || c.fontSize != null || c.fontNameContains || c.fontColor));
      if (childRule) {
        const childSections = RuleManager.splitOnCombinedTargeting(strippedItems, childRule);
        for (const childSec of childSections) {
          el.appendChild(this._buildSectionEl(childSec, childRule, depth + 1));
        }
      } else {
        const bodyEl = document.createElement("div");
        bodyEl.className = "dajb-preview-body-text";
        // Render each item as a selectable span carrying PDF metadata
        const limit = 200;
        const shown = strippedItems.slice(0, limit);
        for (const item of shown) {
          const span = document.createElement("span");
          span.className = "dajb-preview-item";
          span.textContent = item.text;
          span.dataset.fontSize  = item.fontSize;
          span.dataset.fontName  = item.fontName;
          span.dataset.color     = item.color;
          span.dataset.isBold    = item.isBold;
          span.dataset.isItalic  = item.isItalic;
          bodyEl.appendChild(span);
          bodyEl.appendChild(document.createTextNode(" "));
        }
        if (strippedItems.length > limit) {
          const more = document.createElement("span");
          more.className = "dajb-preview-more-inline";
          more.textContent = `… (${strippedItems.length - limit} more items)`;
          bodyEl.appendChild(more);
        }
        el.appendChild(bodyEl);
      }
    }

    return el;
  }

  /** Get text for a rule, applying font criteria as a pre-filter when paired with a regex. */
  async _getTextForRule(rule, ranges) {
    const hasFontFilter = rule.fontSize != null || rule.fontNameContains;
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

  static _onMoveRuleUp(event, target) {
    event.stopPropagation();
    const ruleId = target.dataset.ruleId;
    if (!ruleId) return;
    this.ruleManager.moveRuleUp(ruleId);
    this._renderRulesTree();
    if (this._inspectingFonts) this._renderFontInspector(); else this._renderPreview();
  }

  static _onMoveRuleDown(event, target) {
    event.stopPropagation();
    const ruleId = target.dataset.ruleId;
    if (!ruleId) return;
    this.ruleManager.moveRuleDown(ruleId);
    this._renderRulesTree();
    if (this._inspectingFonts) this._renderFontInspector(); else this._renderPreview();
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
        <th></th><th>Font Name</th><th>Size (pt)</th><th>B/I</th><th>Color</th><th>Count</th><th>Sample Text</th>
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
          <td class="dajb-font-bi">${row.isBold ? '<strong>B</strong>' : ''}${row.isItalic ? '<em>I</em>' : ''}</td>
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
              fontSize: row.fontSize,
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

  // ── Preview text selection → create rule ─────────────────────────────────

  _setupSelectionListener() {
    if (this._selectionChangeBound) document.removeEventListener("selectionchange", this._selectionChangeBound);
    this._selectionChangeBound = () => this._onSelectionChange();
    document.addEventListener("selectionchange", this._selectionChangeBound);
  }

  _onSelectionChange() {
    clearTimeout(this._selectionDebounce);
    const sel = window.getSelection();

    // Collapsed or empty — hide toolbar
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      this._dismissSelectionToolbar();
      return;
    }

    // Debounce: only process once the user stops dragging
    this._selectionDebounce = setTimeout(() => {
      const sel2 = window.getSelection();
      if (!sel2 || sel2.isCollapsed || sel2.rangeCount === 0) return;

      const preview = this.element?.querySelector("#dajb-preview-content");
      if (!preview) return;

      // Ignore selections outside our preview
      if (!preview.contains(sel2.anchorNode) && !preview.contains(sel2.focusNode)) return;

      const range = sel2.getRangeAt(0);
      const spans = preview.querySelectorAll(".dajb-preview-item");
      const covered = [];
      for (const span of spans) {
        try { if (range.intersectsNode(span)) covered.push(span); } catch (_) {}
      }
      if (!covered.length) return;

      // Position the toolbar at the bottom-right of the selection range
      const rect = range.getBoundingClientRect();
      this._showSelectionToolbar(covered, rect.right, rect.bottom + 6);
    }, 250);
  }

  _showSelectionToolbar(spans, clientX, clientY) {
    this._dismissSelectionToolbar();

    // Aggregate: most-frequent value per attribute
    const freq = (arr) => {
      const counts = {};
      for (const v of arr) counts[v] = (counts[v] || 0) + 1;
      return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    };
    const fontName  = freq(spans.map(s => s.dataset.fontName));
    const fontSize  = parseFloat(freq(spans.map(s => s.dataset.fontSize))) || null;
    const color     = freq(spans.map(s => s.dataset.color));
    const sampleText = spans.map(s => s.textContent).join(" ").slice(0, 60);

    const bar = document.createElement("div");
    bar.className = "dajb-selection-toolbar";
    bar.style.left = `${clientX}px`;
    bar.style.top  = `${clientY + 12}px`;

    const colorDot = color && color !== "#000000"
      ? `<span class="dajb-color-swatch" style="background:${color};flex-shrink:0"></span>` : "";
    bar.innerHTML = `
      <div class="dajb-sel-info">
        ${colorDot}
        <span class="dajb-sel-sample">"${this._esc(sampleText)}"</span>
        <span class="dajb-sel-attrs">${fontSize ? fontSize + "pt" : ""}${fontName ? " · " + fontName : ""}${color !== "#000000" ? " · " + color : ""}</span>
      </div>
      <button type="button" class="dajb-btn dajb-sel-create-btn" title="Create a new rule targeting this text's font/size/color">+ Create Rule</button>
      <button type="button" class="dajb-icon-btn dajb-sel-dismiss-btn" title="Dismiss">×</button>
    `;

    bar.querySelector(".dajb-sel-create-btn").addEventListener("click", () => {
      this._createRuleFromSelection({ fontName, fontSize, color });
      this._dismissSelectionToolbar();
      window.getSelection()?.removeAllRanges();
    });
    bar.querySelector(".dajb-sel-dismiss-btn").addEventListener("click", () => {
      this._dismissSelectionToolbar();
      window.getSelection()?.removeAllRanges();
    });

    document.body.appendChild(bar);
    this._selectionToolbar = bar;

    // Clamp to viewport
    const rect = bar.getBoundingClientRect();
    if (rect.right > window.innerWidth - 8)  bar.style.left = `${window.innerWidth - rect.width - 8}px`;
    if (rect.bottom > window.innerHeight - 8) bar.style.top = `${clientY - rect.height - 8}px`;
  }

  _dismissSelectionToolbar() {
    if (this._selectionToolbar) {
      this._selectionToolbar.remove();
      this._selectionToolbar = null;
    }
  }

  _createRuleFromSelection({ fontName, fontSize, color }) {
    const overrides = {};
    if (fontName)              overrides.fontNameContains = fontName;
    if (fontSize != null)      overrides.fontSize = fontSize;
    if (color && color !== "#000000" && color !== "#ffffff") overrides.fontColor = color;

    let rule;
    if (this.selectedRuleId) {
      const parent = this.ruleManager.getRuleById(this.selectedRuleId);
      if (parent && (parent.ruleType === "create-page" || parent.ruleType === "create-section")) {
        // Create child under selected rule
        rule = this.ruleManager.createRule(this.selectedRuleId);
      } else {
        rule = this.ruleManager.createRule(null);
      }
    } else {
      rule = this.ruleManager.createRule(null);
    }

    this.ruleManager.updateRule(rule.id, { name: "New rule from selection", ruleType: "create-section", ...overrides });
    this.selectedRuleId = rule.id;
    this._renderRulesTree();
    this._renderEditor();
    this._renderPreview();
    ui.notifications?.info("DAJB | Rule created from selection — adjust type and pattern as needed.");
  }

  // ── Utility ───────────────────────────────────────────────────────────────

  _esc(str) {
    return (str ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}
