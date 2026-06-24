import { RuleManager } from "./rule-manager.js";
import { PDFParser } from "./pdf-parser.js";
import { JournalCreator } from "./journal-creator.js";
import { RegionSelector } from "./region-selector.js";

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
      "add-child-rule":   function(ev, t) { BuilderApp._onAddChildRule.call(this, ev, t); },
      "add-sibling-rule": function(ev, t) { BuilderApp._onAddSiblingRule.call(this, ev, t); },
      "delete-rule":   function(ev, t) { BuilderApp._onDeleteRule.call(this, ev, t); },
      "select-rule":   function(ev, t) { BuilderApp._onSelectRule.call(this, ev, t); },
      "collapse-rule":    function(ev, t) { BuilderApp._onCollapseRule.call(this, ev, t); },
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
    this.regionSelector = new RegionSelector(this);
    this.activeTab = "preview";
    this.selectedRuleId = null;
    this._pdfFileName = null;
    this._collapsedIds = new Set();
    this._selectionToolbar = null;
    this._selectionChangeBound = null;
    this._selectionDebounce = null;
    this._previewRefreshTimer = null;
    this._regionRefreshTimer = null;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async _prepareContext(options) {
    return {
      pdfLoaded: this.pdfParser.totalPages > 0,
      pdfFileName: this._pdfFileName,
      pdfPages: this.pdfParser.totalPages,
    };
  }

  /** Refresh all three panels. Call after any rule/state change. */
  _refreshAllPanels() {
    this._renderRulesTree();
    this._renderEditor();
    this._renderPreview();
  }

  _onRender(context, options) {
    // ApplicationV2: super._onRender may not exist on all versions; call safely
    if (typeof super._onRender === "function") super._onRender(context, options);
    this._refreshAllPanels();
    this._setupSelectionListener();
    this._setupTabs();
    this.regionSelector.onRender();
  }

  /** Wire the Live Preview / Select Regions tab switcher. */
  _setupTabs() {
    const tabs = this.element.querySelectorAll(".dajb-preview-tab");
    if (!tabs.length) return;
    tabs.forEach((btn) => {
      btn.addEventListener("click", () => this._switchTab(btn.dataset.tab));
    });
    this._switchTab(this.activeTab);
  }

  _switchTab(tab) {
    this.activeTab = tab;
    this.element.querySelectorAll(".dajb-preview-tab").forEach((b) =>
      b.classList.toggle("active", b.dataset.tab === tab));
    this.element.querySelectorAll(".dajb-tab-content").forEach((c) =>
      c.hidden = c.dataset.tab !== tab);
    if (tab === "regions") this.regionSelector.activate();
  }

  /** Clean up global listeners and pending timers when the window closes. */
  _onClose(options) {
    if (this._selectionChangeBound) {
      document.removeEventListener("selectionchange", this._selectionChangeBound);
      this._selectionChangeBound = null;
    }
    if (this._previewClickBound) {
      this.element?.removeEventListener("click", this._previewClickBound);
      this._previewClickBound = null;
    }
    this._dismissSelectionToolbar();
    if (this._selectionDebounce) { clearTimeout(this._selectionDebounce); this._selectionDebounce = null; }
    if (this._previewRefreshTimer) { clearTimeout(this._previewRefreshTimer); this._previewRefreshTimer = null; }
    if (this._regionRefreshTimer) { clearTimeout(this._regionRefreshTimer); this._regionRefreshTimer = null; }
    if (typeof super._onClose === "function") super._onClose(options);
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
      container.appendChild(this._buildRuleNode(rule, 0, false));
    }
    this._setupRuleDragDrop(container);
  }

  // ── Rules Tree drag & drop ──────────────────────────────────────────────────

  /** Allowed top-level rule types; everything else is child-only. */
  static TOP_LEVEL_TYPES = ["create-category", "create-page"];

  /**
   * Validate a prospective drop.  `destParentId === null` means top level.
   * Returns true when the dragged rule's type is allowed at the destination level
   * and the move would not create a cycle.
   */
  _canDropRule(draggedId, destParentId) {
    const dragged = this.ruleManager.getRuleById(draggedId);
    if (!dragged) return false;
    if (destParentId && this.ruleManager.isDescendant(draggedId, destParentId)) return false;
    const isTopLevel = destParentId === null;
    if (isTopLevel) return BuilderApp.TOP_LEVEL_TYPES.includes(dragged.ruleType);
    return dragged.ruleType !== "create-category"; // any child type
  }

  _clearDropIndicators() {
    this.element?.querySelectorAll(".dajb-drop-before, .dajb-drop-after, .dajb-drop-child")
      .forEach((el) => el.classList.remove("dajb-drop-before", "dajb-drop-after", "dajb-drop-child"));
  }

  /**
   * Resolve the drop target under the cursor into a concrete destination.
   * Returns { parentId, index, zone, item } or null when the drop is invalid.
   */
  _resolveDropTarget(ev) {
    const item = ev.target.closest(".dajb-rule-item");
    const tree = this.element.querySelector("#dajb-rules-tree");

    // Dropping onto empty tree space → append at top level.
    if (!item) {
      if (!this._canDropRule(this._dragRuleId, null)) return null;
      return { parentId: null, index: null, zone: "after", item: null };
    }

    const targetId = item.dataset.ruleId;
    if (targetId === this._dragRuleId) return null;

    const rect = item.getBoundingClientRect();
    const rel = (ev.clientY - rect.top) / rect.height;
    const path = this.ruleManager.getPathToRule(targetId);
    const targetParentId = path.length > 1 ? path[path.length - 2].id : null;

    let zone;
    if (rel < 0.25) zone = "before";
    else if (rel > 0.75) zone = "after";
    else zone = "child";

    if (zone === "child") {
      if (!this._canDropRule(this._dragRuleId, targetId)) return null;
      return { parentId: targetId, index: null, zone, item };
    }

    // Sibling of the target — same parent/level.
    if (!this._canDropRule(this._dragRuleId, targetParentId)) return null;
    const siblings = targetParentId === null
      ? this.ruleManager.getTopLevelRules()
      : this.ruleManager.getRuleById(targetParentId).children;
    let index = siblings.findIndex((r) => r.id === targetId);
    if (zone === "after") index += 1;
    return { parentId: targetParentId, index, zone, item };
  }

  _setupRuleDragDrop(container) {
    container.addEventListener("dragstart", (ev) => {
      const item = ev.target.closest(".dajb-rule-item");
      if (!item) return;
      this._dragRuleId = item.dataset.ruleId;
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("text/plain", this._dragRuleId);
      item.classList.add("dajb-dragging");
    });

    container.addEventListener("dragover", (ev) => {
      if (!this._dragRuleId) return;
      ev.preventDefault();
      this._clearDropIndicators();
      const target = this._resolveDropTarget(ev);
      if (!target) { ev.dataTransfer.dropEffect = "none"; return; }
      ev.dataTransfer.dropEffect = "move";
      if (target.item) {
        const cls = target.zone === "before" ? "dajb-drop-before"
                  : target.zone === "after"  ? "dajb-drop-after"
                  : "dajb-drop-child";
        target.item.classList.add(cls);
      }
    });

    container.addEventListener("drop", (ev) => {
      if (!this._dragRuleId) return;
      ev.preventDefault();
      const target = this._resolveDropTarget(ev);
      this._clearDropIndicators();
      if (target) {
        try {
          // moveRule removes the rule before inserting, so a downward move within
          // the same container needs its index decremented by one.
          let index = target.index;
          if (index != null) {
            const path = this.ruleManager.getPathToRule(this._dragRuleId);
            const srcParentId = path.length > 1 ? path[path.length - 2].id : null;
            if (srcParentId === target.parentId) {
              const siblings = target.parentId === null
                ? this.ruleManager.getTopLevelRules()
                : this.ruleManager.getRuleById(target.parentId).children;
              const srcIndex = siblings.findIndex((r) => r.id === this._dragRuleId);
              if (srcIndex !== -1 && srcIndex < index) index -= 1;
            }
          }
          this.ruleManager.moveRule(this._dragRuleId, target.parentId, index);
          if (target.zone === "child" && target.parentId) this._collapsedIds.delete(target.parentId);
        } catch (e) {
          console.warn("DAJB | Move failed:", e.message);
        }
        this._renderRulesTree();
        this._schedulePreviewRefresh(true);
      }
      this._dragRuleId = null;
    });

    const cleanup = () => { this._clearDropIndicators(); this._dragRuleId = null;
      container.querySelectorAll(".dajb-dragging").forEach(el => el.classList.remove("dajb-dragging")); };
    container.addEventListener("dragend", cleanup);
    container.addEventListener("dragleave", (ev) => {
      if (!container.contains(ev.relatedTarget)) this._clearDropIndicators();
    });
  }

  _buildRuleNode(rule, depth, parentDisabled = false) {
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
    const typeInfo = { "create-category": ["cat","#7ec8e3"], "create-page": ["page","#9ade9a"], "strip": ["strip","#e07878"], "create-collated-section": ["collate","#e8a838"], "remove-section": ["remove","#c87878"], "create-table": ["table","#a78bfa"], "create-format-text": ["fmt","#6ee7b7"] };
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

    // Enable/disable checkbox — bound directly so opacity on parent can't block it
    const enableCheck = document.createElement("input");
    enableCheck.type = "checkbox";
    enableCheck.className = "dajb-rule-enable-check";
    enableCheck.checked = !rule.disabled;
    enableCheck.title = "Enable / disable this rule";
    enableCheck.addEventListener("change", (e) => {
      e.stopPropagation();
      this.ruleManager.updateRule(rule.id, { disabled: !enableCheck.checked });
      item.classList.toggle("dajb-disabled", !enableCheck.checked);
      this._renderRulesTree();
      this._schedulePreviewRefresh(true);
    });
    item.appendChild(enableCheck);

    const effectivelyDisabled = rule.disabled || parentDisabled;
    if (effectivelyDisabled) item.classList.add("dajb-disabled");

    // Drag handle / draggable item (reorder + reparent via drag-and-drop)
    item.draggable = true;
    item.dataset.depth = String(depth);
    const grip = document.createElement("span");
    grip.className = "dajb-rule-grip";
    grip.textContent = "⠿";
    grip.title = "Drag to reorder or reparent";
    item.appendChild(grip);

    const wrapper = document.createElement("div");
    wrapper.appendChild(item);

    // Children
    if (hasChildren && !isCollapsed) {
      const childContainer = document.createElement("div");
      childContainer.className = "dajb-rule-children";
      for (const child of rule.children) {
        childContainer.appendChild(this._buildRuleNode(child, depth + 1, effectivelyDisabled));
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
      const evt = (el.type === "checkbox" || el.tagName === "SELECT") ? "change" : "input";
      el.addEventListener(evt, (e) => this._onFieldChange(e, rule.id));
    });
  }

  _buildEditorHTML(rule, isTopLevel) {
    const fmt = rule.outputFormat;
    const type = rule.ruleType ?? 'create-section';
    const isCat       = type === 'create-category';
    const isPage      = type === 'create-page';
    const isSection   = type === 'create-section';
    const isCollated  = type === 'create-collated-section';
    const isRemove    = type === 'remove-section';
    const isStrip     = type === 'strip';
    const isTable      = type === 'create-table';
    const isFormatText = type === 'create-format-text';
    const hasTargeting = !isCat && !isFormatText;
    const hasOutput    = isPage || isSection || isCollated;

    const headerClass = isCat ? 'category-header' : (isStrip || isRemove) ? 'strip-header' : '';
    const canHaveChildren = isPage || isSection || isCollated;

    const fontTargetingFields = `
      <fieldset class="dajb-fieldset">
        <legend>Font Targeting</legend>
        <label class="dajb-field">
          <span>Font Size (pt)</span>
          <div class="dajb-font-size-group">
            <input type="number" data-field="fontSize" value="${rule.fontSize ?? ""}" min="0" step="0.5" placeholder="Any" class="dajb-font-size-input" />
            <input type="checkbox" data-field="maxFontSizeEnabled" ${rule.maxFontSize != null ? 'checked' : ''} title="Enable max font size (range match)" />
            ${rule.maxFontSize != null ? `<span class="dajb-font-size-max-label">max</span><input type="number" data-field="maxFontSize" value="${rule.maxFontSize}" min="0" step="0.5" class="dajb-font-size-input" />` : ''}
          </div>
        </label>
        <label class="dajb-field">
          <span>Font Name</span>
          <input type="text" data-field="fontNameContains" value="${this._esc(rule.fontNameContains ?? "")}" placeholder="e.g. g_d0_f6" class="dajb-monospace" style="width:120px" />
        </label>
        <em class="dajb-hint">Font size + regex = AND (both must match).</em>
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
            ${!isTopLevel ? `<button type="button" data-action="add-sibling-rule" title="Add a new rule at the same level as this one">+ Sibling</button>` : ""}
            <button type="button" data-action="delete-rule" class="dajb-btn-danger">Delete</button>
          </div>
        </div>

        <label class="dajb-field">
          <span>Name</span>
          <input type="text" data-field="name" value="${this._esc(rule.name)}" />
        </label>

        <label class="dajb-field">
          <span>Rule Type</span>
          <div class="dajb-rule-type-row">
            <select data-field="ruleType">
              ${isTopLevel ? `<option value="create-category"          ${isCat      ? "selected" : ""}>New Category</option>` : ""}
              <option value="create-page"             ${isPage     ? "selected" : ""}>New Page</option>
              ${!isTopLevel ? `<option value="create-section"          ${isSection  ? "selected" : ""}>New Section</option>` : ""}
              ${!isTopLevel ? `<option value="create-collated-section" ${isCollated ? "selected" : ""}>New Collated Section</option>` : ""}
              ${!isTopLevel ? `<option value="create-format-text"      ${isFormatText ? "selected" : ""}>Format Text</option>` : ""}
              ${!isTopLevel ? `<option value="create-table"            ${isTable      ? "selected" : ""}>Table</option>` : ""}
              ${!isTopLevel ? `<option value="remove-section"          ${isRemove   ? "selected" : ""}>Remove Section</option>` : ""}
              ${!isTopLevel ? `<option value="strip"                   ${isStrip    ? "selected" : ""}>Remove Text</option>` : ""}
            </select>
            ${(() => {
              const levelMap = {
                'create-category': ['top', 'Top Level Only'],
                'create-page':     ['both', 'Both'],
              };
              const [cls, label] = levelMap[type] ?? ['child', 'Child Only'];
              return `<span class="dajb-rule-level-badge dajb-level-${cls}" title="Where this rule type can be used">${label}</span>`;
            })()}
          </div>
        </label>

        ${isTopLevel ? `
        ${!isCat ? `
        <label class="dajb-field">
          <span>Page Ranges</span>
          <input type="text" data-field="pageRanges" value="${this._esc(rule.pageRanges)}" placeholder="e.g. 11-50, 61-70" />
        </label>
` : ""}
        <label class="dajb-field">
          <span>Target Journal</span>
          <input type="text" data-field="targetJournal" value="${this._esc(rule.targetJournal)}" placeholder="Journal name" />
        </label>
        ` : ""}

        ${isCat ? `
        <label class="dajb-field">
          <span>Category Name</span>
          <input type="text" data-field="targetCategory" value="${this._esc(rule.targetCategory)}" placeholder="Name of category to create" />
        </label>
        <em class="dajb-hint" style="color:#7ec8e3;padding:0 4px 8px">Place this rule above any Create Page rules that use this category.</em>
        ` : ""}
        ${isPage ? `
        <label class="dajb-field">
          <span>Target Category</span>
          <input type="text" data-field="targetCategory" value="${this._esc(rule.targetCategory)}" placeholder="Category to place pages into" />
        </label>
        <em class="dajb-hint" style="color:#9ade9a;padding:0 4px 8px">The target journal and category are created automatically if they don't exist — a separate New Category rule is optional.</em>
        ` : ""}

        ${isStrip  ? `<em class="dajb-hint dajb-strip-hint">Matched text is removed before boundary rules run.</em>` : ""}
        ${isRemove ? `<em class="dajb-hint dajb-strip-hint">Matched section boundaries and their entire body are removed from the output.</em>` : ""}
        ${isTable  ? `
        <fieldset class="dajb-fieldset">
          <legend>Table Options</legend>
          <label class="dajb-field dajb-field-check">
            <input type="checkbox" data-field="importTableRegions" ${rule.importTableRegions ? "checked" : ""} />
            <span>Import Table Regions</span>
          </label>
          <em class="dajb-hint">Use the Table Override regions drawn on the Select Regions tab as the table locations. When on, this overrides Auto-detect and font/regex targeting.</em>
          <label class="dajb-field dajb-field-check">
            <input type="checkbox" data-field="autoDetect" ${rule.autoDetect ? "checked" : ""} />
            <span>Auto-detect tables</span>
          </label>
          <em class="dajb-hint">Scan body items geometrically for numbered tables (d6/d8/numbered rows). Use when the table appears anywhere in the section body without fixed font targeting.</em>
          <label class="dajb-field dajb-field-check">
            <input type="checkbox" data-field="firstRowHeader" ${rule.firstRowHeader !== false ? "checked" : ""} />
            <span>First row is header</span>
          </label>
          <em class="dajb-hint">Wraps the first row in &lt;thead&gt; with &lt;th&gt; cells.</em>
          <label class="dajb-field">
            <span>Column gap threshold (pt)</span>
            <input type="number" data-field="columnGapMinPt" value="${rule.columnGapMinPt ?? 4}" min="1" step="0.5" style="width:70px" />
          </label>
          <em class="dajb-hint">Minimum x-gap between text runs to detect a column boundary. Increase if columns are merging; decrease if too many columns appear.</em>
          <label class="dajb-field">
            <span>Max columns</span>
            <input type="number" data-field="maxColumns" value="${rule.maxColumns ?? 0}" min="0" step="1" style="width:70px" />
          </label>
          <em class="dajb-hint">Cap the number of columns. 0 = auto-detect all. Set to 2 for simple two-column tables (number + description) where gap noise creates phantom columns.</em>
          <label class="dajb-field">
            <span>Gap noise filter (×median)</span>
            <input type="number" data-field="columnGapMultiplier" value="${rule.columnGapMultiplier ?? 0}" min="0" step="0.5" style="width:70px" />
          </label>
          <em class="dajb-hint">0 = off. If set (e.g. 3), gaps smaller than this multiple of the median gap are ignored. Useful when wrapped cell text creates small phantom gaps.</em>
          <label class="dajb-field dajb-field-check">
            <input type="checkbox" data-field="preserveFormatting" ${rule.preserveFormatting ? "checked" : ""} />
            <span>Preserve bold / italic in cells</span>
          </label>
        </fieldset>
        <em class="dajb-hint dajb-strip-hint">Geometrically parses body items into rows and columns using x/y positions from the PDF.</em>
        ` : ""}

        ${isFormatText ? `
        <fieldset class="dajb-fieldset">
          <legend>Regex Pattern</legend>
          <label class="dajb-field">
            <span>Pattern</span>
            <input type="text" data-field="pattern" value="${this._esc(rule.pattern)}" placeholder="e.g. [A-Za-z/]+:" class="dajb-monospace" />
          </label>
          <label class="dajb-field">
            <span>Flags</span>
            <input type="text" data-field="flags" value="${this._esc(rule.flags)}" placeholder="gi" style="width:60px" />
          </label>
          <em class="dajb-hint">Each match within the parent section's body text will have the formatting below applied to it.</em>
        </fieldset>
        <fieldset class="dajb-fieldset">
          <legend>Formatting Options</legend>
          <div class="dajb-format-options">
            <label class="dajb-field dajb-field-check">
              <input type="checkbox" data-field="formatOptions.bold" ${rule.formatOptions?.bold ? 'checked' : ''} />
              <span>Bold</span>
            </label>
            <label class="dajb-field dajb-field-check">
              <input type="checkbox" data-field="formatOptions.underline" ${rule.formatOptions?.underline ? 'checked' : ''} />
              <span>Underline</span>
            </label>
            <label class="dajb-field dajb-field-check">
              <input type="checkbox" data-field="formatOptions.indent" ${rule.formatOptions?.indent ? 'checked' : ''} />
              <span>Indent</span>
            </label>
            <label class="dajb-field dajb-field-check">
              <input type="checkbox" data-field="formatOptions.lineReturnBefore" ${rule.formatOptions?.lineReturnBefore ? 'checked' : ''} />
              <span>Line Return Before</span>
            </label>
            <label class="dajb-field dajb-field-check">
              <input type="checkbox" data-field="formatOptions.lineReturnAfter" ${rule.formatOptions?.lineReturnAfter ? 'checked' : ''} />
              <span>Line Return After</span>
            </label>
          </div>
        </fieldset>
        ` : ""}

        ${hasTargeting ? fontTargetingFields : ""}
        ${hasTargeting ? regexFields : ""}

        ${hasOutput ? `
        <fieldset class="dajb-fieldset">
          <legend>Output Formatting</legend>
          ${(isSection || isCollated) ? `
          ${isCollated ? `
          <label class="dajb-field">
            <span>Group Heading</span>
            <input type="text" data-field="groupName" value="${this._esc(rule.groupName ?? '')}" placeholder="e.g. Description" />
          </label>
          <em class="dajb-hint">All matches are merged under this single heading.</em>
          ` : ""}
          <label class="dajb-field">
            <span>Heading Level</span>
            <select data-field="outputFormat.headingLevel">
              <option value="0"${fmt.headingLevel === 0 ? ' selected' : ''}>H0 — No heading (body only)</option>
              ${[1,2,3,4,5,6].map(n => `<option value="${n}"${fmt.headingLevel === n ? ' selected' : ''}>H${n}</option>`).join("")}
            </select>
          </label>
          <label class="dajb-field">
            <span>Additional Formatting</span>
            <select data-field="outputFormat.additionalFormatting">
              <option value=""${(fmt.additionalFormatting ?? '') === '' ? ' selected' : ''}>(none)</option>
              <option value="ul"${fmt.additionalFormatting === 'ul' ? ' selected' : ''}>List, Unordered</option>
              <option value="ol"${fmt.additionalFormatting === 'ol' ? ' selected' : ''}>List, Ordered</option>
              <option value="blockquote"${fmt.additionalFormatting === 'blockquote' ? ' selected' : ''}>Block Quote</option>
              <option value="pre"${fmt.additionalFormatting === 'pre' ? ' selected' : ''}>Code Block</option>
              <option value="secret"${fmt.additionalFormatting === 'secret' ? ' selected' : ''}>Secret</option>
            </select>
          </label>
          <label class="dajb-field dajb-field-check">
            <input type="checkbox" data-field="breakOnSentence" ${rule.breakOnSentence ? "checked" : ""} />
            <span>Only break on sentence boundary (.!?)</span>
          </label>
          <em class="dajb-hint">Ignores matches that don't follow a sentence-ending character. Prevents mid-sentence bold text from splitting into its own section.</em>
          ` : ""}
          <label class="dajb-field">
            <span>Paragraph Detection</span>
            <select data-field="outputFormat.paragraphDetection">
              <option value=""${(fmt.paragraphDetection ?? '') === '' ? ' selected' : ''}>(none)</option>
              <option value="spacing"${fmt.paragraphDetection === 'spacing' ? ' selected' : ''}>Spacing (Y-gap)</option>
              <option value="indent"${fmt.paragraphDetection === 'indent' ? ' selected' : ''}>Indent</option>
              <option value="both"${fmt.paragraphDetection === 'both' ? ' selected' : ''}>Both</option>
            </select>
          </label>
          <em class="dajb-hint">Splits large text blocks into &lt;p&gt; paragraphs using line-gap analysis. "Spacing" uses Y-gap between lines; "Indent" uses first-line indentation; "Both" uses either signal.</em>
          <label class="dajb-field dajb-field-check">
            <input type="checkbox" data-field="preserveFormatting" ${rule.preserveFormatting ? "checked" : ""} />
            <span>Preserve bold / italic from PDF</span>
          </label>
          <em class="dajb-hint">Detected from font name (e.g. "Bold", "Italic").</em>
        </fieldset>
        ` : ""}
      </div>
    `;
  }

  _onFieldChange(event, ruleId) {
    const el = event.currentTarget;
    const field = el.dataset.field;
    let value;

    // Synthetic field: toggles maxFontSize on/off, re-renders editor
    if (field === "maxFontSizeEnabled") {
      const rule = this.ruleManager.getRuleById(ruleId);
      if (!rule) return;
      const initMax = el.checked ? (rule.fontSize != null ? rule.fontSize + 2 : 12) : null;
      this.ruleManager.updateRule(ruleId, { maxFontSize: initMax });
      this._renderEditor();
      this._schedulePreviewRefresh(true);
      return;
    }

    if (el.type === "checkbox") {
      value = el.checked;
    } else if (el.type === "number") {
      // nullable number fields: empty string means "no filter"
      const nullable = ["fontSize", "minFontSize", "maxFontSize", "xMin", "xMax"].includes(field);
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
      this._schedulePreviewRefresh(true);
      return;
    }

    // Update rule label in tree if name changed
    if (field === "name") {
      const label = this.element.querySelector(
        `.dajb-rule-item[data-rule-id="${ruleId}"] .dajb-rule-label`
      );
      if (label) label.textContent = value || "(unnamed)";
    }

    // Refresh preview on targeting-related changes — debounced for text fields
    // so typing doesn't steal focus by re-rendering on every character.
    if (["pattern", "flags", "pageRanges", "captureGroup", "fontSize", "minFontSize", "maxFontSize",
         "groupName", "breakOnSentence",
         "outputFormat.headingLevel", "outputFormat.additionalFormatting", "outputFormat.paragraphDetection",
         "firstRowHeader", "columnGapMinPt", "columnGapMultiplier", "maxColumns", "autoDetect", "importTableRegions",
         "formatOptions.bold", "formatOptions.underline", "formatOptions.indent",
         "formatOptions.lineReturnBefore", "formatOptions.lineReturnAfter"].includes(field)) {
      const isTextInput = ["pattern", "flags", "pageRanges", "groupName", "fontSize", "minFontSize", "maxFontSize", "columnGapMinPt", "columnGapMultiplier", "maxColumns"].includes(field);
      const isFontSizeRange = field === "minFontSize" || field === "maxFontSize";
      this._schedulePreviewRefresh(!isTextInput, isFontSizeRange ? 4000 : undefined);
    }

    // Page-range changes alter the Select Regions page list — refresh that tab too
    // (debounced so typing a range doesn't re-render the PDF on every keystroke).
    if (field === "pageRanges" && this.activeTab === "regions") {
      clearTimeout(this._regionRefreshTimer);
      this._regionRefreshTimer = setTimeout(() => this.regionSelector.activate(), 600);
    }
  }

  // ── Preview Panel ─────────────────────────────────────────────────────────

  /**
   * Schedule a preview refresh after a short debounce so rapid keystrokes
   * (e.g. typing a pattern) don't steal focus by re-rendering on every character.
   * Pass immediate=true to skip the delay (e.g. after a select/checkbox change).
   */
  _schedulePreviewRefresh(immediate = false, delay = 2000) {
    clearTimeout(this._previewRefreshTimer);
    const refresh = () => {
      // Capture editor focus state before any render that might disturb DOM
      const active = document.activeElement;
      const editorPanel = this.element?.querySelector("#dajb-editor-panel");
      let savedField = null, savedStart = null, savedEnd = null;
      if (active && editorPanel?.contains(active) && active.dataset.field) {
        savedField = active.dataset.field;
        if (active.selectionStart != null) {
          savedStart = active.selectionStart;
          savedEnd   = active.selectionEnd;
        }
      }

      this._renderPreview();

      // Restore focus to the editor field that was active before the refresh
      if (savedField && editorPanel) {
        const target = editorPanel.querySelector(`[data-field="${savedField}"]`);
        if (target) {
          target.focus({ preventScroll: true });
          if (savedStart != null && target.setSelectionRange) {
            try { target.setSelectionRange(savedStart, savedEnd); } catch (_) {}
          }
        }
      }
    };
    if (immediate) {
      refresh();
    } else {
      this._previewRefreshTimer = setTimeout(refresh, delay);
    }
  }

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

      const items = RuleManager.hasRegions(topRule)
        ? await this.pdfParser.getPagesItemsForRegions(ranges, topRule.regions)
        : await this.pdfParser.getPagesItems(ranges, {});
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
      const items = sec.bodyItems ?? [];

      // Inherited table / format-text rules apply to unmatched (preamble) content
      // too — so a Table Override region that falls inside otherwise-unstructured
      // text still renders as a table instead of greyed-out prose.
      const inhTable = rule?.children?.find(c =>
        c.ruleType === 'create-table' && !c.disabled && (c.importTableRegions || c.autoDetect)) ?? null;
      const inhFormat = rule?.children?.filter(c =>
        c.ruleType === 'create-format-text' && !c.disabled && c.pattern) ?? [];
      const hasTaggedTable = inhTable && (
        inhTable.importTableRegions
          ? items.some(it => it.tableRegionId != null)
          : PDFParser.detectTableBoundaries(items).length > 0);

      if (items.length && hasTaggedTable) {
        el.className = "dajb-preview-section depth-" + depth;
        this._appendDetectedTables(el, items, inhTable, inhFormat);
        return el;
      }
      if (items.length && inhFormat.length) {
        el.className = "dajb-preview-body-text";
        const rawText = items.map(i => i.text).join(' ').trim();
        el.innerHTML = `<p>${JournalCreator._applyFormatTextRules(rawText, inhFormat)}</p>`;
        return el;
      }

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

      // 2. Find all qualifying create-section/collated-section children; use multi-child mode when >1
      const sectionChildRules = rule.children?.filter(c =>
        (c.ruleType === 'create-section' || c.ruleType === 'create-collated-section' || c.ruleType === 'remove-section') &&
        !c.disabled &&
        (c.pattern || c.fontSize != null)
      ) ?? [];
      const childRule = sectionChildRules[0]
        ?? rule.children?.find(c => c.ruleType === 'create-table' && !c.disabled)
        ?? null;

      // Inheritable siblings: table and format-text rules carry down into
      // sub-sections so they cooperate with section-splitting children.
      const inheritableChildren = rule.children?.filter(c =>
        !c.disabled &&
        (c.ruleType === 'create-table' || c.ruleType === 'create-format-text') &&
        c !== childRule
      ) ?? [];
      const mergeRule = (r) =>
        inheritableChildren.length
          ? { ...r, children: [...(r.children ?? []), ...inheritableChildren] }
          : r;

      if (sectionChildRules.length > 1) {
        // Multi-child mode: boundaries from all rules merged in position order
        const tagged = RuleManager.splitOnMultipleRules(strippedItems, sectionChildRules);
        const pendingCollate = new Map(); // rule → [sections]

        const flushCollate = () => {
          for (const [cr, secs] of pendingCollate) {
            if (!secs.length) continue;
            const level = +(cr.outputFormat?.headingLevel ?? 1);
            const groupEl = document.createElement('div');
            groupEl.className = 'dajb-preview-collate-group';
            if (level > 0) {
              const hdr = document.createElement(`h${level}`);
              hdr.className = 'dajb-preview-collate-heading';
              hdr.textContent = cr.groupName;
              groupEl.appendChild(hdr);
            }
            const hasGC = cr.children?.some(c => c.ruleType !== 'strip');
            if (hasGC) {
              for (const s of secs) groupEl.appendChild(this._buildSectionEl(s, mergeRule(cr), depth + 1));
            } else {
              const crAF   = cr.outputFormat?.additionalFormatting ?? '';
              const isList = crAF === 'ul' || crAF === 'ol';
              const contentEl = document.createElement(isList ? crAF : 'p');
              contentEl.className = 'dajb-preview-collate-body';
              for (const s of secs) {
                const container = isList ? document.createElement('li') : contentEl;
                this._appendItemSpans(container, s.titleItems ?? [], { bold: true });
                this._appendItemSpans(container, s.bodyItems ?? []);
                if (isList) contentEl.appendChild(container);
              }
              groupEl.appendChild(contentEl);
            }
            const badge = document.createElement('span');
            badge.className = 'dajb-preview-collate-badge';
            badge.textContent = `${secs.length} match${secs.length !== 1 ? 'es' : ''} collated`;
            groupEl.appendChild(badge);
            el.appendChild(groupEl);
          }
          pendingCollate.clear();
        };

        for (const sec of tagged) {
          if (sec.match === null) {
            flushCollate();
            if (sec.body) el.appendChild(this._buildSectionEl(sec, { children: [...inheritableChildren] }, depth + 1));
            continue;
          }
          const r = sec.rule;
          if (r.ruleType === 'create-collated-section') {
            if (!pendingCollate.has(r)) pendingCollate.set(r, []);
            pendingCollate.get(r).push(sec);
          } else if (r.ruleType === 'remove-section') {
            flushCollate();
            const removedEl = document.createElement('div');
            removedEl.className = 'dajb-preview-removed-section';
            removedEl.title = 'This section and its body are removed from output';
            const label = document.createElement('span');
            label.className = 'dajb-preview-removed-label';
            label.textContent = '✂ removed: ';
            removedEl.appendChild(label);
            this._appendItemSpans(removedEl, sec.titleItems ?? []);
            this._appendItemSpans(removedEl, sec.bodyItems ?? [], { limit: 30 });
            el.appendChild(removedEl);
          } else {
            flushCollate();
            el.appendChild(this._buildSectionEl(sec, mergeRule(r), depth + 1));
          }
        }
        flushCollate();

      } else if (childRule && childRule.ruleType === 'create-collated-section') {
        // Collate mode: all matches merged under one named heading.
        // Each match's body is still passed through any grandchild rules.
        const childSections = RuleManager.splitOnCombinedTargeting(strippedItems, childRule);
        const matches = childSections.filter(s => s.match !== null);
        const level = +(childRule.outputFormat?.headingLevel ?? 1);
        const hasGrandchildren = childRule.children?.some(c => c.ruleType !== 'strip');
        // preamble prose
        const preamble = childSections.find(s => s.match === null);
        if (preamble?.body) el.appendChild(this._buildSectionEl(preamble, mergeRule(childRule), depth + 1));
        if (matches.length) {
          const groupEl = document.createElement('div');
          groupEl.className = 'dajb-preview-collate-group';
          if (level > 0) {
            const hdr = document.createElement(`h${level}`);
            hdr.className = 'dajb-preview-collate-heading';
            hdr.textContent = childRule.groupName;
            groupEl.appendChild(hdr);
          }
          if (hasGrandchildren) {
            // Show each match as its own section so grandchild previews render
            for (const childSec of matches) {
              groupEl.appendChild(this._buildSectionEl(childSec, mergeRule(childRule), depth + 1));
            }
          } else {
            // No grandchildren — compact inline rendering with selectable spans
            const crAF   = childRule.outputFormat?.additionalFormatting
              ?? (childRule.outputFormat?.asList ? (childRule.outputFormat?.listType ?? 'ul') : '');
            const isList = crAF === 'ul' || crAF === 'ol';
            const contentEl = document.createElement(isList ? crAF : 'p');
            contentEl.className = 'dajb-preview-collate-body';
            for (const childSec of matches) {
              const container = isList ? document.createElement('li') : contentEl;
              this._appendItemSpans(container, childSec.titleItems ?? [], { bold: true });
              this._appendItemSpans(container, childSec.bodyItems ?? []);
              if (isList) contentEl.appendChild(container);
            }
            groupEl.appendChild(contentEl);
          }
          const badge = document.createElement('span');
          badge.className = 'dajb-preview-collate-badge';
          badge.textContent = `${matches.length} match${matches.length !== 1 ? 'es' : ''} collated`;
          groupEl.appendChild(badge);
          el.appendChild(groupEl);
        }
      } else if (childRule && childRule.ruleType === 'remove-section') {
        const childSections = RuleManager.splitOnCombinedTargeting(strippedItems, childRule);
        for (const childSec of childSections) {
          if (childSec.match === null) {
            el.appendChild(this._buildSectionEl(childSec, childRule, depth + 1));
          } else {
            const removedEl = document.createElement('div');
            removedEl.className = 'dajb-preview-removed-section';
            removedEl.title = 'This section and its body are removed from output';
            const label = document.createElement('span');
            label.className = 'dajb-preview-removed-label';
            label.textContent = '✂ removed: ';
            removedEl.appendChild(label);
            this._appendItemSpans(removedEl, childSec.titleItems ?? []);
            this._appendItemSpans(removedEl, childSec.bodyItems ?? [], { limit: 30 });
            el.appendChild(removedEl);
          }
        }
      } else if (childRule && childRule.ruleType === 'create-section' && (childRule.outputFormat?.additionalFormatting === 'ul' || childRule.outputFormat?.additionalFormatting === 'ol')) {
        // List mode: render matched sections as bullet items
        const childSections = RuleManager.splitOnCombinedTargeting(strippedItems, childRule);
        const listType = childRule.outputFormat?.additionalFormatting ?? 'ul';
        const listEl = document.createElement(listType);
        listEl.className = 'dajb-preview-section-list';
        let hasItems = false;
        for (const childSec of childSections) {
          if (childSec.match === null) {
            // Preamble rendered as prose before the list
            if (hasItems) {
              el.appendChild(listEl.cloneNode(true));
              listEl.innerHTML = '';
              hasItems = false;
            }
            el.appendChild(this._buildSectionEl(childSec, childRule, depth + 1));
            continue;
          }
          const li = document.createElement('li');
          li.className = 'dajb-preview-section-list-item';
          const titleSpan = document.createElement('strong');
          titleSpan.textContent = childSec.title;
          li.appendChild(titleSpan);
          if (childSec.body) {
            li.appendChild(document.createTextNode(' ' + childSec.body.slice(0, 120) + (childSec.body.length > 120 ? '…' : '')));
          }
          listEl.appendChild(li);
          hasItems = true;
        }
        if (hasItems) el.appendChild(listEl);
      } else if (childRule && childRule.ruleType === 'create-table') {
        // Table mode: geometrically parse body items into an HTML table preview.
        // If the table rule has targeting, use it to split preamble from table items.
        const tableChild = childRule;
        const tableOpts = {
          firstRowHeader:      tableChild.firstRowHeader      ?? true,
          columnGapMinPt:      tableChild.columnGapMinPt      ?? 4,
          columnGapMultiplier: tableChild.columnGapMultiplier ?? 0,
          maxColumns:          tableChild.maxColumns          ?? 0,
          preserveFormatting:  tableChild.preserveFormatting  ?? false,
        };
        if (tableChild.importTableRegions || tableChild.autoDetect) {
          const ftRules = rule.children?.filter(c =>
            c.ruleType === 'create-format-text' && !c.disabled && c.pattern
          ) ?? [];
          this._appendDetectedTables(el, strippedItems, tableChild, ftRules);
          return el; // early return — we've fully rendered the body
        }

        const hasCriteria = !!(tableChild.pattern || tableChild.fontSize != null);
        let tableItems = strippedItems;
        if (hasCriteria && strippedItems.length) {
          const sections = RuleManager.splitOnCombinedTargeting(strippedItems, tableChild);
          const preamble = sections.find(s => s.match === null);
          if (preamble?.bodyItems?.length) {
            const pre = document.createElement('div');
            pre.className = 'dajb-preview-body-text';
            this._appendItemSpans(pre, preamble.bodyItems, { limit: 100 });
            el.appendChild(pre);
          }
          tableItems = sections
            .filter(s => s.match !== null)
            .flatMap(s => [...(s.titleItems ?? []), ...(s.bodyItems ?? [])]);
        }
        if (tableItems.length) {
          const { html, rowCount, colCount } = PDFParser.parseTableRegion(tableItems, tableOpts);
          const wrapper = document.createElement('div');
          wrapper.className = 'dajb-preview-table-wrapper';
          wrapper.innerHTML = html;
          const badge = document.createElement('div');
          badge.className = 'dajb-preview-table-badge';
          badge.textContent = `${rowCount} rows × ${colCount} col${colCount !== 1 ? 's' : ''} (table)`;
          wrapper.appendChild(badge);
          el.appendChild(wrapper);
        }
      } else if (childRule) {
        const childSections = RuleManager.splitOnCombinedTargeting(strippedItems, childRule);
        for (const childSec of childSections) {
          el.appendChild(this._buildSectionEl(childSec, mergeRule(childRule), depth + 1));
        }
      } else {
        const bodyEl = document.createElement("div");
        bodyEl.className = "dajb-preview-body-text";

        const formatTextRules = rule.children?.filter(c =>
          c.ruleType === 'create-format-text' && !c.disabled && c.pattern
        ) ?? [];

        if (formatTextRules.length) {
          // Format Text rules present — render as formatted HTML so the user
          // can see bold, underline, line-break effects in the preview.
          const rawText = strippedItems.map(i => i.text).join(' ').trim();
          const formattedHTML = JournalCreator._applyFormatTextRules(rawText, formatTextRules);
          bodyEl.innerHTML = `<p>${formattedHTML}</p>`;
        } else {
          // Render each item as a selectable span carrying PDF metadata
          const limit = 200;
          const shown = strippedItems.slice(0, limit);
          for (const item of shown) {
            const span = document.createElement("span");
            span.className = "dajb-preview-item";
            span.textContent = item.text;
            span.dataset.fontSize  = item.fontSize;
            span.dataset.fontName  = item.fontName;
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
        }
        el.appendChild(bodyEl);
      }
    }

    return el;
  }

  /**
   * Render a create-table child's importTableRegions / autoDetect output into `el`,
   * interleaving detected tables with surrounding prose (top-to-bottom by Y).
   * Shared by the table child branch and the preamble branch (inherited tables).
   * @returns {boolean} true if at least one table was rendered.
   */
  _appendDetectedTables(el, items, tableChild, formatTextRules = []) {
    if (!(tableChild.importTableRegions || tableChild.autoDetect)) return false;
    const tableOpts = {
      firstRowHeader:      tableChild.firstRowHeader      ?? true,
      columnGapMinPt:      tableChild.columnGapMinPt      ?? 4,
      columnGapMultiplier: tableChild.columnGapMultiplier ?? 0,
      maxColumns:          tableChild.maxColumns          ?? 0,
      preserveFormatting:  tableChild.preserveFormatting  ?? false,
    };
    const detected = tableChild.importTableRegions
      ? PDFParser.groupItemsByTableRegion(items)
      : PDFParser.detectTableBoundaries(items);
    const detectLabel = tableChild.importTableRegions ? "table region" : "auto-detected";

    if (!detected.length) {
      const noTbl = document.createElement('div');
      noTbl.className = 'dajb-preview-body-text';
      if (formatTextRules.length && items.length) {
        const rawText = items.map(i => i.text).join(' ').trim();
        noTbl.innerHTML = `<p>${JournalCreator._applyFormatTextRules(rawText, formatTextRules)}</p>`;
      } else {
        this._appendItemSpans(noTbl, items, { limit: 100 });
      }
      el.appendChild(noTbl);
      return false;
    }

    const inTable = new Set(detected.flat());
    const tableRanges = detected.map(tItems => ({
      yMax: Math.max(...tItems.map(i => i.y)),
      items: tItems,
    })).sort((a, b) => b.yMax - a.yMax);

    const allSorted = [...items].sort((a, b) => b.y - a.y);
    let ti = 0;
    let proseItems = [];

    const flushProse = () => {
      if (!proseItems.length) return;
      const p = document.createElement('div');
      p.className = 'dajb-preview-body-text';
      this._appendItemSpans(p, proseItems, { limit: 60 });
      el.appendChild(p);
      proseItems = [];
    };
    const emitTable = (rangeItems) => {
      const { html: tHtml, rowCount, colCount } = PDFParser.parseTableRegion(rangeItems, tableOpts);
      const wrapper = document.createElement('div');
      wrapper.className = 'dajb-preview-table-wrapper';
      wrapper.innerHTML = tHtml || '';
      const badge = document.createElement('div');
      badge.className = 'dajb-preview-table-badge';
      badge.textContent = `${rowCount} rows × ${colCount} col${colCount !== 1 ? 's' : ''} (${detectLabel})`;
      wrapper.appendChild(badge);
      el.appendChild(wrapper);
    };

    for (const item of allSorted) {
      while (ti < tableRanges.length && tableRanges[ti].yMax >= item.y) { flushProse(); emitTable(tableRanges[ti].items); ti++; }
      if (!inTable.has(item)) proseItems.push(item);
    }
    while (ti < tableRanges.length) { flushProse(); emitTable(tableRanges[ti].items); ti++; }
    flushProse();
    return true;
  }

  /** Get text for a rule, applying font criteria as a pre-filter when paired with a regex. */
  async _getTextForRule(rule, ranges) {
    const hasFontFilter = rule.fontSize != null;
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
        if (this.activeTab === "regions") this.regionSelector.activate();
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
        this._refreshAllPanels();
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
    this._refreshAllPanels();
  }

  static _onAddChildRule(event, target) {
    if (!this.selectedRuleId) {
      ui.notifications.warn("DAJB | Select a rule first.");
      return;
    }
    const child = this.ruleManager.createRule(this.selectedRuleId);
    this.selectedRuleId = child.id;
    this._refreshAllPanels();
  }

  static _onAddSiblingRule(event, target) {
    if (!this.selectedRuleId) return;
    const path = this.ruleManager.getPathToRule(this.selectedRuleId);
    const parentId = path.length > 1 ? path[path.length - 2].id : null;
    const sibling = this.ruleManager.createRule(parentId);
    this.selectedRuleId = sibling.id;
    this._refreshAllPanels();
  }

  static _onDeleteRule(event, target) {
    if (!this.selectedRuleId) return;
    const rule = this.ruleManager.getRuleById(this.selectedRuleId);
    if (!rule) return;
    this.ruleManager.deleteRule(this.selectedRuleId);
    this.selectedRuleId = null;
    this._refreshAllPanels();
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
    if (this.activeTab === "regions") this.regionSelector.activate();
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

  // ── Preview text selection → create rule ─────────────────────────────────

  _setupSelectionListener() {
    if (this._selectionChangeBound) document.removeEventListener("selectionchange", this._selectionChangeBound);
    this._selectionChangeBound = () => this._onSelectionChange();
    document.addEventListener("selectionchange", this._selectionChangeBound);

    // Single-click on a preview item: auto-select it and show toolbar immediately.
    if (this._previewClickBound && this._previewClickTarget) {
      this._previewClickTarget.removeEventListener("click", this._previewClickBound);
    }
    this._previewClickBound  = (e) => this._onPreviewItemClick(e);
    this._previewClickTarget = this.element;
    this.element?.addEventListener("click", this._previewClickBound);
  }

  _onPreviewItemClick(e) {
    const span = e.target.closest(".dajb-preview-item");
    if (!span) return;

    // Programmatically select the span text.
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    // Show toolbar immediately — skip the selectionchange debounce that will
    // fire as a side-effect of setting the selection above.
    clearTimeout(this._selectionDebounce);
    this._skipNextSelectionChange = true;

    this._showSelectionToolbar([span], e.clientX, e.clientY);
  }

  _onSelectionChange() {
    clearTimeout(this._selectionDebounce);

    // Ignore the selectionchange that fires from our own programmatic selection
    // inside _onPreviewItemClick — the toolbar is already shown.
    if (this._skipNextSelectionChange) {
      this._skipNextSelectionChange = false;
      return;
    }

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
    const sampleText = spans.map(s => s.textContent).join(" ").slice(0, 60);

    const bar = document.createElement("div");
    bar.className = "dajb-selection-toolbar";
    bar.style.left = `${clientX}px`;
    bar.style.top  = `${clientY + 12}px`;

    const canAddToCurrent = !!this.selectedRuleId &&
      this.ruleManager.getRuleById(this.selectedRuleId)?.ruleType !== 'create-category';

    bar.innerHTML = `
      <div class="dajb-sel-info">
        <span class="dajb-sel-sample">"${this._esc(sampleText)}"</span>
        <span class="dajb-sel-attrs">${fontSize ? fontSize + "pt" : ""}${fontName ? " · " + fontName : ""}</span>
      </div>
      ${canAddToCurrent ? `<button type="button" class="dajb-btn dajb-sel-add-btn" title="Apply these font properties to the currently selected rule's targeting">+ Add to Rule</button>` : ""}
      <button type="button" class="dajb-btn dajb-sel-create-btn" title="Create a new rule targeting this text's font/size">+ Create Rule</button>
      <button type="button" class="dajb-icon-btn dajb-sel-dismiss-btn" title="Dismiss">×</button>
    `;

    if (canAddToCurrent) {
      bar.querySelector(".dajb-sel-add-btn").addEventListener("click", () => {
        this._addToCurrentRule({ fontName, fontSize });
        this._dismissSelectionToolbar();
        window.getSelection()?.removeAllRanges();
      });
    }
    bar.querySelector(".dajb-sel-create-btn").addEventListener("click", () => {
      this._createRuleFromSelection({ fontName, fontSize });
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

  _addToCurrentRule({ fontName, fontSize }) {
    if (!this.selectedRuleId) return;
    const updates = {};
    if (fontSize != null) updates.fontSize = fontSize;
    if (fontName)         updates.fontNameContains = fontName;
    if (!Object.keys(updates).length) return;
    this.ruleManager.updateRule(this.selectedRuleId, updates);
    this._renderEditor();
    this._schedulePreviewRefresh(true);
    ui.notifications?.info("DAJB | Font properties applied to current rule.");
  }

  _createRuleFromSelection({ fontName, fontSize }) {
    const overrides = {};
    if (fontSize != null) overrides.fontSize = fontSize;
    if (fontName)         overrides.fontNameContains = fontName;

    let rule;
    if (this.selectedRuleId) {
      const parent = this.ruleManager.getRuleById(this.selectedRuleId);
      if (parent && ["create-page", "create-section", "create-collated-section"].includes(parent.ruleType)) {
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
    this._refreshAllPanels();
    ui.notifications?.info("DAJB | Rule created from selection — adjust type and pattern as needed.");
  }

  // ── Utility ───────────────────────────────────────────────────────────────

  /** Append PDF item objects as selectable .dajb-preview-item spans into `container`. */
  _appendItemSpans(container, items, { bold = false, limit = 150 } = {}) {
    const shown = items.slice(0, limit);
    for (const item of shown) {
      const span = document.createElement('span');
      span.className = 'dajb-preview-item';
      span.textContent = item.text;
      span.dataset.fontSize = item.fontSize;
      span.dataset.fontName = item.fontName;
      span.dataset.color    = item.color;
      span.dataset.isBold   = item.isBold;
      span.dataset.isItalic = item.isItalic;
      if (bold) span.style.fontWeight = 'bold';
      container.appendChild(span);
      container.appendChild(document.createTextNode(' '));
    }
    if (items.length > limit) {
      const more = document.createElement('span');
      more.className = 'dajb-preview-more-inline';
      more.textContent = `… (${items.length - limit} more)`;
      container.appendChild(more);
    }
  }

  _esc(str) {
    return (str ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

}
