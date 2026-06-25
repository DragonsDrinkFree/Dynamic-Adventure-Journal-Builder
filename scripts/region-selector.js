import { RuleManager } from "./rule-manager.js";
import { PDFParser } from "./pdf-parser.js";

/**
 * RegionSelector — drives the "Select Regions" tab.
 *
 * Renders the loaded PDF (page by page, across the active top-level rule's page
 * range) onto a canvas with a transparent overlay for drawing bounding boxes.
 * Tools produce regions stored on the top-level page rule's `regions` object in
 * PDF user units:
 *
 *   • Default   — green; applied at the same coordinates on every page in range.
 *   • Exclusion — red; current-page-only carve-outs subtracted from the defaults.
 *   • Override  — blue; current-page-only regions that replace the defaults.
 *   • Edit      — select a region, drag corner handles to resize, drag body to move.
 *
 * The right side panel lists regions for the current page and gives an overview
 * of every page that has exceptions.  Default and Override rows can be dragged to
 * reorder (which sets the stitch `order`).
 */
export class RegionSelector {
  constructor(app) {
    this.app = app;
    this.tool = null;            // "default" | "exclusion" | "override" | "edit" | null
    this.scale = 1.3;
    this.zoom = 1;               // user zoom multiplier relative to fit-to-width (1 = fit)
    this.currentPage = null;     // actual PDF page number
    this.viewport = null;        // pdf.js PageViewport for the rendered page
    this.dragStart = null;       // { x, y } in canvas buffer px
    this.currentRect = null;     // rubber-band rect in canvas buffer px
    this._ruleId = null;         // top-level rule id this tab is bound to

    // Side panel
    this.sidePanelTab = "thispage"; // "thispage" | "exceptions"
    this.sideCollapsed = false;
    this._resizeObs = null;

    // Edit-tool state
    this.selectedRegion = null;  // { kind: "default"|"override"|"exclusion", ref }
    this.editMode = null;        // "move" | "resize" | null
    this.resizeCorner = null;    // "nw" | "ne" | "sw" | "se"
    this.editStartRect = null;   // selected region's rect (canvas px) at drag start

    // List drag-reorder state
    this._listDrag = null;       // { kind, index }
  }

  get pdfParser()   { return this.app.pdfParser; }
  get ruleManager() { return this.app.ruleManager; }

  /** The top-level rule that owns page ranges + regions (may be an ancestor). */
  get rule() {
    const id = this.app.selectedRuleId;
    if (!id) return null;
    return this.ruleManager.getTopLevelAncestor(id);
  }

  /** Ordered list of PDF page numbers covered by the rule's page ranges. */
  get pages() {
    const rule = this.rule;
    if (!rule) return [];
    const ranges = this.ruleManager.parsePageRanges(rule.pageRanges);
    const out = [];
    for (const { start, end } of ranges) {
      for (let p = start; p <= Math.min(end, this.pdfParser.totalPages); p++) out.push(p);
    }
    return out;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /** Called from BuilderApp._onRender — DOM was rebuilt, so re-attach listeners. */
  onRender() {
    this._dismissOverrideMenu();
    this._attachListeners();
    this._setupResizeObserver();
    const tab = this.app.element?.querySelector("#dajb-tab-regions");
    if (tab && !tab.hidden) this.activate();
  }

  /** Re-fit the PDF when the canvas area resizes (window resize, panel collapse). */
  _setupResizeObserver() {
    this._resizeObs?.disconnect();
    const wrap = this.app.element?.querySelector(".dajb-region-canvas-wrap");
    if (!wrap || typeof ResizeObserver === "undefined") return;
    let timer = null;
    this._resizeObs = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const tab = this.app.element?.querySelector("#dajb-tab-regions");
        if (tab && !tab.hidden && this.viewport) this._renderCurrentPage();
      }, 150);
    });
    this._resizeObs.observe(wrap);
  }

  /** Called when the user switches to the Select Regions tab. */
  async activate() {
    this._syncToolButtons();
    this._syncAlternatingUI();
    const rule = this.rule;
    const pages = this.pages;

    if (rule?.id !== this._ruleId) {
      this._ruleId = rule?.id ?? null;
      this.currentPage = null;
      this.selectedRegion = null;
    }
    if (!pages.includes(this.currentPage)) this.currentPage = pages[0] ?? null;

    await this._renderCurrentPage();
  }

  // ── Listeners ────────────────────────────────────────────────────────────────

  _attachListeners() {
    const tab = this.app.element?.querySelector("#dajb-tab-regions");
    if (!tab) return;

    // Toolbar / nav / list buttons + side sub-tabs (delegated)
    tab.addEventListener("click", (ev) => {
      const subtab = ev.target.closest("[data-region-tab]");
      if (subtab) { ev.preventDefault(); this._switchSidePanel(subtab.dataset.regionTab); return; }
      const btn = ev.target.closest("[data-region-action]");
      if (!btn) return;
      ev.preventDefault();
      this._onAction(btn.dataset.regionAction, btn);
    });

    const overlay = tab.querySelector("#dajb-region-canvas");
    if (overlay) {
      overlay.addEventListener("mousedown", (ev) => this._onMouseDown(ev, overlay));
      overlay.addEventListener("mousemove", (ev) => this._onMouseMove(ev, overlay));
      overlay.addEventListener("mouseup",   (ev) => this._onMouseUp(ev, overlay));
      overlay.addEventListener("mouseleave", () => {
        if (this.editMode) { this.editMode = null; this._persist(); }
        this.dragStart = null; this.currentRect = null; this._redrawOverlay();
      });
    }

    const zoomSel = tab.querySelector(".dajb-region-zoom-select");
    zoomSel?.addEventListener("change", () => this._setZoom(parseFloat(zoomSel.value)));

    const list = tab.querySelector("#dajb-region-list");
    this._attachListDragDrop(list);

    // Per-region table column-count edits (delegated; survives innerHTML rebuilds).
    list?.addEventListener("change", (ev) => {
      const inp = ev.target.closest(".dajb-region-maxcols");
      if (inp) this._onMaxColsChange(inp);
    });
  }

  _onMaxColsChange(inp) {
    const rule = this.rule;
    if (!rule) return;
    const cfg = this._pageCfg(rule, this.currentPage);
    const t = cfg.tables.find(x => x.id === inp.dataset.id);
    if (!t) return;
    let v = parseInt(inp.value, 10);
    if (!Number.isFinite(v) || v < 1) v = 1;
    t.maxColumns = v;
    inp.value = String(v);
    this._persist();
  }

  _onAction(action, btn) {
    switch (action) {
      case "tool-default":   this._toggleTool("default");   break;
      case "tool-defaultB":  this._toggleTool("defaultB");  break;
      case "toggle-alternating": this._toggleAlternating(); break;
      case "tool-exclusion": this._toggleTool("exclusion"); break;
      case "tool-override":  this._openOverrideMenu(btn);   break;
      case "save-override-template": this._saveOverrideTemplate(); break;
      case "tool-table":     this._toggleTool("table");     break;
      case "tool-edit":      this._toggleTool("edit");      break;
      case "prev-page":      this._stepPage(-1); break;
      case "next-page":      this._stepPage(1);  break;
      case "delete-region":  this._deleteRegion(btn); break;
      case "goto-page":      this._gotoPage(Number(btn.dataset.page)); break;
      case "toggle-side":    this._toggleSide(); break;
    }
  }

  /** Set the zoom multiplier (relative to fit-to-width) and re-render the page. */
  _setZoom(z) {
    this.zoom = Math.max(0.25, Math.min(4, z));
    this._renderCurrentPage();
  }

  _toggleSide() {
    this.sideCollapsed = !this.sideCollapsed;
    const body = this.app.element?.querySelector(".dajb-region-body");
    const btn  = this.app.element?.querySelector(".dajb-region-collapse");
    if (body) body.classList.toggle("dajb-side-collapsed", this.sideCollapsed);
    if (btn) {
      btn.textContent = this.sideCollapsed ? "⟨" : "⟩";
      btn.title = this.sideCollapsed ? "Show region list" : "Hide region list";
    }
    this._renderCurrentPage();
  }

  _toggleTool(tool) {
    this.tool = this.tool === tool ? null : tool;
    if (this.tool !== "edit") this.selectedRegion = null;
    this._syncToolButtons();
    this._redrawOverlay();
    const overlay = this.app.element?.querySelector("#dajb-region-canvas");
    if (overlay) overlay.style.cursor = this.tool ? "crosshair" : "default";
  }

  /** Which default group applies to the current page: 'A' (even index) or 'B' (odd). */
  _currentPageGroup() {
    const regions = this.rule?.regions;
    if (!regions?.alternating) return "A";
    const idx = this.pages.indexOf(this.currentPage);
    return idx % 2 === 0 ? "A" : "B";
  }

  _toggleAlternating() {
    const rule = this.rule;
    if (!rule) return;
    const regions = RuleManager.normalizeRegions(rule);
    regions.alternating = !regions.alternating;
    if (!regions.alternating && this.tool === "defaultB") this.tool = null;
    this._syncAlternatingUI();
    this._syncToolButtons();
    this._persist();
    this._renderCurrentPage();
  }

  /** Reflect alternating state into the toolbar (toggle state, B button, A label). */
  _syncAlternatingUI() {
    const tab = this.app.element?.querySelector("#dajb-tab-regions");
    if (!tab) return;
    const alt = !!this.rule?.regions?.alternating;
    tab.querySelector('[data-region-action="toggle-alternating"]')?.classList.toggle("dajb-active", alt);
    const bBtn = tab.querySelector('[data-region-action="tool-defaultB"]');
    if (bBtn) bBtn.hidden = !alt;
    const aLabel = tab.querySelector('[data-region-action="tool-default"] .dajb-rtool-label');
    if (aLabel) aLabel.textContent = alt ? "Default A" : "Default";
  }

  _syncToolButtons() {
    const tab = this.app.element?.querySelector("#dajb-tab-regions");
    if (!tab) return;
    for (const t of ["default", "defaultB", "exclusion", "override", "table", "edit"]) {
      tab.querySelector(`[data-region-action="tool-${t}"]`)
        ?.classList.toggle("dajb-active", this.tool === t);
    }
    const overlay = tab.querySelector("#dajb-region-canvas");
    if (overlay) overlay.style.cursor = this.tool ? "crosshair" : "default";
  }

  _switchSidePanel(tab) {
    this.sidePanelTab = tab;
    const root = this.app.element?.querySelector("#dajb-tab-regions");
    if (!root) return;
    root.querySelectorAll("[data-region-tab]").forEach((b) =>
      b.classList.toggle("active", b.dataset.regionTab === tab));
    this._renderSidePanel();
  }

  async _stepPage(delta) {
    const pages = this.pages;
    const idx = pages.indexOf(this.currentPage);
    const next = pages[idx + delta];
    if (next == null) return;
    this.currentPage = next;
    this.selectedRegion = null;
    await this._renderCurrentPage();
  }

  async _gotoPage(page) {
    if (!page) return;
    this.currentPage = page;
    this.selectedRegion = null;
    this._switchSidePanel("thispage");
    await this._renderCurrentPage();
  }

  // ── Page rendering ────────────────────────────────────────────────────────────

  async _renderCurrentPage() {
    const tab = this.app.element?.querySelector("#dajb-tab-regions");
    if (!tab) return;
    const pdfCanvas = tab.querySelector("#dajb-pdf-canvas");
    const overlay   = tab.querySelector("#dajb-region-canvas");
    const label     = tab.querySelector(".dajb-region-pagelabel");
    const wrap      = tab.querySelector(".dajb-region-canvas-wrap");
    if (!pdfCanvas || !overlay) return;

    const rule = this.rule;
    const pages = this.pages;

    if (!this.pdfParser.totalPages) { this._setCanvasMessage(wrap, "Load a PDF to draw regions."); this._renderSidePanel(); return; }
    if (!rule)         { this._setCanvasMessage(wrap, "Select a rule to draw regions."); this._renderSidePanel(); return; }
    if (!pages.length) { this._setCanvasMessage(wrap, "Set page ranges on the top-level rule to draw regions."); this._renderSidePanel(); return; }

    this._clearCanvasMessage(wrap);
    if (!pages.includes(this.currentPage)) this.currentPage = pages[0];

    try {
      const availWidth = Math.max(120, (wrap?.clientWidth ?? 0) - 16); // minus 8px padding each side
      this.viewport = await this.pdfParser.renderPageToCanvas(this.currentPage, pdfCanvas, { fitWidth: availWidth, zoom: this.zoom });
      overlay.width        = pdfCanvas.width;
      overlay.height       = pdfCanvas.height;
      overlay.style.width  = pdfCanvas.style.width;
      overlay.style.height = pdfCanvas.style.height;
    } catch (err) {
      this._setCanvasMessage(wrap, `Error rendering page: ${err.message}`);
      console.error("DAJB region render error", err);
      return;
    }

    if (label) {
      const idx = pages.indexOf(this.currentPage);
      const cfg = this._pageCfgRead(rule, this.currentPage);
      const marked = (cfg.overrides.length || cfg.exclusions.length || cfg.tables.length) ? " ●" : "";
      const pos = idx >= 0 ? ` (${idx + 1}/${pages.length})` : "";
      const grp = rule.regions?.alternating ? ` [${this._currentPageGroup()}]` : "";
      label.textContent = `p. ${this.currentPage}${pos}${grp}${marked}`;
      label.classList.toggle("dajb-has-exceptions", !!marked);
    }

    const zoomSel = tab.querySelector(".dajb-region-zoom-select");
    if (zoomSel) zoomSel.value = String(this.zoom);

    this._redrawOverlay();
    this._renderSidePanel();
  }

  _setCanvasMessage(wrap, msg) {
    if (!wrap) return;
    let el = wrap.querySelector(".dajb-region-msg");
    if (!el) { el = document.createElement("div"); el.className = "dajb-region-msg"; wrap.appendChild(el); }
    el.textContent = msg;
    el.hidden = false;
  }

  _clearCanvasMessage(wrap) {
    const el = wrap?.querySelector(".dajb-region-msg");
    if (el) el.hidden = true;
  }

  // ── Overlay drawing ───────────────────────────────────────────────────────────

  _redrawOverlay() {
    const overlay = this.app.element?.querySelector("#dajb-region-canvas");
    if (!overlay || !this.viewport) return;
    const ctx = overlay.getContext("2d");
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const dpr = window.devicePixelRatio || 1;

    const rule = this.rule;
    if (!rule) return;
    const regions = RuleManager.normalizeRegions(rule);
    const cfg = this._pageCfgRead(rule, this.currentPage);
    const pageOverridden = cfg.overrides.length > 0;

    const drawRect = (r, stroke, fill, label, dashed = false) => {
      const c = this._pdfRectToCanvas(r);
      ctx.fillStyle = fill; ctx.strokeStyle = stroke; ctx.lineWidth = 2;
      ctx.setLineDash(dashed ? [6 * dpr, 4 * dpr] : []);
      ctx.fillRect(c.x, c.y, c.w, c.h);
      ctx.strokeRect(c.x, c.y, c.w, c.h);
      ctx.setLineDash([]);
      if (label) {
        ctx.fillStyle = stroke;
        ctx.font = `${11 * dpr}px sans-serif`;
        ctx.fillText(label, c.x + 4 * dpr, c.y + 13 * dpr);
      }
    };

    // Active default group for this page (A on even index, B on odd) when alternating.
    const group = this._currentPageGroup();
    const activeDefaults = (regions.alternating && group === "B") ? regions.defaultsB : regions.defaults;
    const defLabel = regions.alternating ? `default ${group}` : "default";
    const defStroke = (regions.alternating && group === "B") ? "rgba(64,196,196,0.85)" : "rgba(100,200,100,0.85)";
    const defFill   = (regions.alternating && group === "B") ? "rgba(64,196,196,0.12)" : "rgba(100,200,100,0.12)";
    for (const r of activeDefaults) {
      drawRect(r,
        pageOverridden ? "rgba(150,170,170,0.4)" : defStroke,
        pageOverridden ? "rgba(150,170,170,0.05)" : defFill,
        pageOverridden ? `${defLabel} (inactive)` : defLabel, pageOverridden);
    }
    for (const r of cfg.overrides)  drawRect(r, "rgba(100,160,255,0.9)", "rgba(100,160,255,0.15)", "override");
    for (const r of cfg.exclusions) drawRect(r, "rgba(224,120,120,0.9)", "rgba(224,120,120,0.18)", "exclude");
    for (const r of cfg.tables)     drawRect(r, "rgba(167,139,250,0.9)", "rgba(167,139,250,0.18)", "table");

    // Selected-region handles (edit tool)
    if (this.tool === "edit" && this.selectedRegion) {
      const c = this._pdfRectToCanvas(this.selectedRegion.ref);
      ctx.strokeStyle = "rgba(255,210,80,0.95)";
      ctx.lineWidth = 2;
      ctx.setLineDash([4 * dpr, 3 * dpr]);
      ctx.strokeRect(c.x, c.y, c.w, c.h);
      ctx.setLineDash([]);
      const hs = 8 * dpr;
      ctx.fillStyle = "rgba(255,210,80,0.95)";
      for (const [hx, hy] of this._handlePoints(c)) ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
    }

    // Active rubber-band (draw tools)
    if (this.tool && this.tool !== "edit" && this.currentRect) {
      const r = this.currentRect;
      const colour = this.tool === "exclusion" ? "rgba(224,120,120,0.9)"
                   : this.tool === "override"  ? "rgba(100,160,255,0.9)"
                   : "rgba(100,200,100,0.9)";
      ctx.strokeStyle = colour;
      ctx.fillStyle = colour.replace("0.9", "0.15");
      ctx.lineWidth = 2;
      ctx.setLineDash([4 * dpr, 3 * dpr]);
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.setLineDash([]);
    }
  }

  _handlePoints(c) {
    return [[c.x, c.y], [c.x + c.w, c.y], [c.x, c.y + c.h], [c.x + c.w, c.y + c.h]];
  }

  // ── Mouse handlers ────────────────────────────────────────────────────────────

  _bufferCoords(ev, overlay) {
    return {
      x: ev.offsetX * (overlay.width / overlay.clientWidth),
      y: ev.offsetY * (overlay.height / overlay.clientHeight),
    };
  }

  _onMouseDown(ev, overlay) {
    if (!this.viewport) return;
    const pt = this._bufferCoords(ev, overlay);

    if (this.tool === "edit") {
      // Resize if grabbing a handle of the already-selected region.
      if (this.selectedRegion) {
        const corner = this._hitTestHandle(pt, this.selectedRegion.ref);
        if (corner) {
          this.editMode = "resize";
          this.resizeCorner = corner;
          this.editStartRect = this._pdfRectToCanvas(this.selectedRegion.ref);
          this.dragStart = pt;
          return;
        }
      }
      // Otherwise select the region under the cursor and start a move.
      const hit = this._hitTestRegion(pt);
      this.selectedRegion = hit;
      if (hit) {
        this.editMode = "move";
        this.editStartRect = this._pdfRectToCanvas(hit.ref);
        this.dragStart = pt;
      }
      this._redrawOverlay();
      return;
    }

    if (!this.tool) return;
    this.dragStart = pt;
    this.currentRect = null;
  }

  _onMouseMove(ev, overlay) {
    if (!this.tool) return;
    const pt = this._bufferCoords(ev, overlay);

    if (this.tool === "edit") {
      if (!this.editMode || !this.dragStart || !this.selectedRegion) return;
      const dx = pt.x - this.dragStart.x;
      const dy = pt.y - this.dragStart.y;
      const start = this.editStartRect;
      let canvasRect;
      if (this.editMode === "move") {
        canvasRect = { x: start.x + dx, y: start.y + dy, w: start.w, h: start.h };
      } else {
        canvasRect = this._resizeRect(start, this.resizeCorner, dx, dy);
      }
      Object.assign(this.selectedRegion.ref, this._canvasRectToPdf(canvasRect));
      this._redrawOverlay();
      return;
    }

    if (!this.dragStart) return;
    this.currentRect = normalizeRect(this.dragStart.x, this.dragStart.y, pt.x, pt.y);
    this._redrawOverlay();
  }

  _onMouseUp(ev, overlay) {
    if (this.tool === "edit") {
      if (this.editMode) {
        this.editMode = null;
        this.resizeCorner = null;
        this.dragStart = null;
        this.editStartRect = null;
        this._persist();
        this._renderSidePanel();
      }
      return;
    }

    if (!this.tool || !this.dragStart) return;
    const rect = this.currentRect;
    this.dragStart = null;
    this.currentRect = null;
    if (rect && rect.w > 8 && rect.h > 8) this._finalizeRegion(rect);
    else this._redrawOverlay();
  }

  _resizeRect(start, corner, dx, dy) {
    let left = start.x, top = start.y, right = start.x + start.w, bottom = start.y + start.h;
    if (corner.includes("w")) left += dx;
    if (corner.includes("e")) right += dx;
    if (corner.includes("n")) top += dy;
    if (corner.includes("s")) bottom += dy;
    const MIN = 8;
    let x = Math.min(left, right), y = Math.min(top, bottom);
    let w = Math.max(MIN, Math.abs(right - left)), h = Math.max(MIN, Math.abs(top - bottom));
    return { x, y, w, h };
  }

  // ── Hit testing ───────────────────────────────────────────────────────────────

  /** Regions visible on the current page, top-most last (draw order). */
  _regionsOnPage() {
    const rule = this.rule;
    if (!rule) return [];
    const regions = RuleManager.normalizeRegions(rule);
    const cfg = this._pageCfgRead(rule, this.currentPage);
    const out = [];
    // Only the default group active for this page is editable here.
    const group = this._currentPageGroup();
    const activeDefaults = (regions.alternating && group === "B") ? regions.defaultsB : regions.defaults;
    const defKind = (regions.alternating && group === "B") ? "defaultB" : "default";
    for (const ref of activeDefaults) out.push({ kind: defKind, ref });
    for (const ref of cfg.overrides)    out.push({ kind: "override", ref });
    for (const ref of cfg.exclusions)   out.push({ kind: "exclusion", ref });
    for (const ref of cfg.tables)       out.push({ kind: "table", ref });
    return out;
  }

  _hitTestRegion(pt) {
    const list = this._regionsOnPage();
    // Iterate in reverse so the top-most drawn region wins.
    for (let i = list.length - 1; i >= 0; i--) {
      const c = this._pdfRectToCanvas(list[i].ref);
      if (pt.x >= c.x && pt.x <= c.x + c.w && pt.y >= c.y && pt.y <= c.y + c.h) return list[i];
    }
    return null;
  }

  _hitTestHandle(pt, ref) {
    const c = this._pdfRectToCanvas(ref);
    const hs = 10 * (window.devicePixelRatio || 1);
    const corners = { nw: [c.x, c.y], ne: [c.x + c.w, c.y], sw: [c.x, c.y + c.h], se: [c.x + c.w, c.y + c.h] };
    for (const [name, [hx, hy]] of Object.entries(corners)) {
      if (Math.abs(pt.x - hx) <= hs && Math.abs(pt.y - hy) <= hs) return name;
    }
    return null;
  }

  // ── Region creation / deletion ──────────────────────────────────────────────

  async _finalizeRegion(canvasRect) {
    const rule = this.rule;
    if (!rule) return;
    const pdfRect = this._canvasRectToPdf(canvasRect);
    const regions = RuleManager.normalizeRegions(rule);

    if (this.tool === "default") {
      regions.defaults.push({ id: foundry.utils.randomID(), order: regions.defaults.length, ...pdfRect });
    } else if (this.tool === "defaultB") {
      regions.defaultsB.push({ id: foundry.utils.randomID(), order: regions.defaultsB.length, ...pdfRect });
    } else {
      const cfg = this._pageCfg(rule, this.currentPage);
      if (this.tool === "exclusion") cfg.exclusions.push({ ...pdfRect });
      else if (this.tool === "override") cfg.overrides.push({ id: foundry.utils.randomID(), order: cfg.overrides.length, ...pdfRect });
      else if (this.tool === "table") cfg.tables.push({ id: foundry.utils.randomID(), maxColumns: await this._detectColumns(pdfRect), ...pdfRect });
    }

    this._persist();
    this._redrawOverlay();
    this._renderSidePanel();
  }

  /** Best-effort column count for a freshly drawn table region (defaults to 2). */
  async _detectColumns(pdfRect) {
    try {
      const pageItems = await this.pdfParser.getPageItems(this.currentPage);
      const within = PDFParser.filterItemsToRegion(pageItems, pdfRect);
      if (!within.length) return 2;
      const { colCount } = PDFParser.parseTableRegion(within, { columnGapMinPt: 4, maxColumns: 0 });
      return Math.max(1, colCount || 2);
    } catch (_) {
      return 2;
    }
  }

  _pageCfg(rule, page) {
    const regions = RuleManager.normalizeRegions(rule);
    const key = String(page);
    if (!regions.pages[key]) regions.pages[key] = { exclusions: [], overrides: [], tables: [] };
    const cfg = regions.pages[key];
    if (!Array.isArray(cfg.tables)) cfg.tables = [];
    return cfg;
  }

  /** Read-only page config (never mutates the rule). */
  _pageCfgRead(rule, page) {
    const regions = rule.regions ?? {};
    const cfg = regions.pages?.[String(page)] ?? {};
    return { exclusions: cfg.exclusions ?? [], overrides: cfg.overrides ?? [], tables: cfg.tables ?? [] };
  }

  _deleteRegion(btn) {
    const rule = this.rule;
    if (!rule) return;
    const regions = RuleManager.normalizeRegions(rule);
    const kind = btn.dataset.kind;
    const id = btn.dataset.id;
    const index = btn.dataset.index != null ? Number(btn.dataset.index) : -1;

    if (kind === "default") {
      regions.defaults = regions.defaults.filter(r => r.id !== id);
      this._renumber(regions.defaults);
    } else if (kind === "defaultB") {
      regions.defaultsB = regions.defaultsB.filter(r => r.id !== id);
      this._renumber(regions.defaultsB);
    } else {
      const cfg = this._pageCfg(rule, this.currentPage);
      if (kind === "override") {
        cfg.overrides = id ? cfg.overrides.filter(r => r.id !== id) : cfg.overrides.filter((_, i) => i !== index);
        this._renumber(cfg.overrides);
      } else if (kind === "exclusion") {
        cfg.exclusions = cfg.exclusions.filter((_, i) => i !== index);
      } else if (kind === "table") {
        cfg.tables = id ? cfg.tables.filter(r => r.id !== id) : cfg.tables.filter((_, i) => i !== index);
      }
      if (!cfg.overrides.length && !cfg.exclusions.length && !cfg.tables.length) delete regions.pages[String(this.currentPage)];
    }

    this.selectedRegion = null;
    this._persist();
    this._redrawOverlay();
    this._renderSidePanel();
  }

  _renumber(arr) { arr.forEach((r, i) => { r.order = i; }); }

  // ── Override templates ────────────────────────────────────────────────────────

  /** Open the Override-tool dropdown: draw new, or apply/delete a saved template. */
  _openOverrideMenu(btn) {
    this._dismissOverrideMenu();
    const rule = this.rule;
    const regions = rule ? RuleManager.normalizeRegions(rule) : { overrideTemplates: [] };
    const templates = regions.overrideTemplates ?? [];

    const menu = document.createElement("div");
    menu.className = "dajb-region-menu";

    const drawItem = document.createElement("button");
    drawItem.type = "button";
    drawItem.className = "dajb-region-menu-item";
    drawItem.textContent = "✏ Draw new overrides";
    drawItem.addEventListener("click", () => { this._dismissOverrideMenu(); this._toggleTool("override"); });
    menu.appendChild(drawItem);

    const divider = document.createElement("div");
    divider.className = "dajb-region-menu-divider";
    menu.appendChild(divider);

    if (!templates.length) {
      const empty = document.createElement("div");
      empty.className = "dajb-region-menu-empty";
      empty.textContent = "No saved templates";
      menu.appendChild(empty);
    } else {
      for (const tpl of templates) {
        // Row = container with two sibling buttons (apply | delete). Avoid nesting
        // a clickable element inside a <button>, which made the ✕ activate "apply".
        const row = document.createElement("div");
        row.className = "dajb-region-menu-row";

        const name = document.createElement("button");
        name.type = "button";
        name.className = "dajb-region-menu-item dajb-region-menu-name";
        name.textContent = `▦ ${tpl.name} (${tpl.overrides?.length ?? 0})`;
        name.addEventListener("click", () => { this._dismissOverrideMenu(); this._applyOverrideTemplate(tpl.id); });
        row.appendChild(name);

        const del = document.createElement("button");
        del.type = "button";
        del.className = "dajb-region-menu-del";
        del.textContent = "✕";
        del.title = "Delete template";
        del.addEventListener("click", (e) => { e.stopPropagation(); this._deleteOverrideTemplate(tpl.id); this._openOverrideMenu(btn); });
        row.appendChild(del);

        menu.appendChild(row);
      }
    }

    document.body.appendChild(menu);
    const rect = btn.getBoundingClientRect();
    menu.style.left = `${rect.left}px`;
    menu.style.top  = `${rect.bottom + 4}px`;
    const mrect = menu.getBoundingClientRect();
    if (mrect.right > window.innerWidth - 8) menu.style.left = `${window.innerWidth - mrect.width - 8}px`;

    this._overrideMenu = menu;
    this._overrideMenuDismiss = (e) => {
      if (!menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) this._dismissOverrideMenu();
    };
    setTimeout(() => document.addEventListener("mousedown", this._overrideMenuDismiss), 0);
  }

  _dismissOverrideMenu() {
    if (this._overrideMenu) { this._overrideMenu.remove(); this._overrideMenu = null; }
    if (this._overrideMenuDismiss) { document.removeEventListener("mousedown", this._overrideMenuDismiss); this._overrideMenuDismiss = null; }
  }

  async _saveOverrideTemplate() {
    const rule = this.rule;
    if (!rule) return;
    const regions = RuleManager.normalizeRegions(rule);
    const cfg = this._pageCfgRead(rule, this.currentPage);
    if (!cfg.overrides.length) { ui.notifications?.warn("DAJB | No overrides on this page to save."); return; }
    const name = await this._promptName("Save Override Template", `Template ${regions.overrideTemplates.length + 1}`);
    if (!name) return;
    regions.overrideTemplates.push({
      id: foundry.utils.randomID(),
      name,
      overrides: cfg.overrides.map(o => ({ order: o.order ?? 0, x: o.x, y: o.y, w: o.w, h: o.h })),
    });
    this._persist();
    ui.notifications?.info(`DAJB | Saved override template "${name}".`);
  }

  _applyOverrideTemplate(id) {
    const rule = this.rule;
    if (!rule) return;
    const regions = RuleManager.normalizeRegions(rule);
    const tpl = regions.overrideTemplates.find(t => t.id === id);
    if (!tpl) return;
    const cfg = this._pageCfg(rule, this.currentPage);
    const baseOrder = cfg.overrides.length;
    (tpl.overrides ?? []).forEach((o, i) => {
      cfg.overrides.push({ id: foundry.utils.randomID(), order: baseOrder + i, x: o.x, y: o.y, w: o.w, h: o.h });
    });
    this._persist();
    this._redrawOverlay();
    this._renderSidePanel();
    ui.notifications?.info(`DAJB | Applied template "${tpl.name}".`);
  }

  _deleteOverrideTemplate(id) {
    const rule = this.rule;
    if (!rule) return;
    const regions = RuleManager.normalizeRegions(rule);
    regions.overrideTemplates = regions.overrideTemplates.filter(t => t.id !== id);
    this._persist();
  }

  async _promptName(title, initial = "") {
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" })[c]);
    try {
      const result = await foundry.applications.api.DialogV2.prompt({
        window: { title },
        content: `<input type="text" name="tplName" value="${esc(initial)}" style="width:100%" autofocus>`,
        ok: { label: "Save", callback: (_e, button) => button.form?.elements?.tplName?.value?.trim() || null },
        rejectClose: false,
      });
      return result || null;
    } catch { return null; }
  }

  // ── Side panel ──────────────────────────────────────────────────────────────

  _renderSidePanel() {
    const list = this.app.element?.querySelector("#dajb-region-list");
    const overview = this.app.element?.querySelector("#dajb-region-exceptions");
    if (list)     list.hidden     = this.sidePanelTab !== "thispage";
    if (overview) overview.hidden = this.sidePanelTab !== "exceptions";
    if (this.sidePanelTab === "thispage") this._renderRegionList();
    else this._renderExceptionsOverview();
  }

  _renderRegionList() {
    const list = this.app.element?.querySelector("#dajb-region-list");
    if (!list) return;
    list.innerHTML = "";

    const rule = this.rule;
    if (!rule) return;
    const regions = RuleManager.normalizeRegions(rule);
    const cfg = this._pageCfgRead(rule, this.currentPage);

    const fmt = (r) => `${Math.round(r.w)}×${Math.round(r.h)} @ (${Math.round(r.x)}, ${Math.round(r.y)})`;

    const addRow = (kind, label, colour, r, scope, draggable, index) => {
      const row = document.createElement("div");
      row.className = "dajb-region-row";
      row.dataset.kind = kind;
      row.dataset.index = String(index);
      if (this.selectedRegion?.ref === r) row.classList.add("dajb-region-selected");
      if (draggable) { row.draggable = true; row.classList.add("dajb-region-draggable"); }

      const swatch = document.createElement("span");
      swatch.className = "dajb-region-swatch";
      swatch.style.background = colour;
      row.appendChild(swatch);

      const text = document.createElement("span");
      text.className = "dajb-region-rowtext";
      text.innerHTML = `<strong>${label}</strong> <span class="dajb-region-scope">${scope}</span><span class="dajb-region-dims">${fmt(r)}</span>`;
      row.appendChild(text);

      // Table regions: inline per-region column count editor.
      if (kind === "table") {
        const cols = document.createElement("input");
        cols.type = "number"; cols.min = "1"; cols.step = "1";
        cols.className = "dajb-region-maxcols";
        cols.value = String(r.maxColumns ?? 2);
        cols.title = "Max columns for this table";
        if (r.id) cols.dataset.id = r.id;
        row.appendChild(cols);
      }

      const del = document.createElement("button");
      del.type = "button"; del.className = "dajb-region-del"; del.textContent = "✕"; del.title = "Delete region";
      del.dataset.regionAction = "delete-region";
      del.dataset.kind = kind;
      if (r.id) del.dataset.id = r.id;
      del.dataset.index = String(index);
      row.appendChild(del);
      list.appendChild(row);
    };

    // Show the default group active for this page (A on even index, B on odd).
    const group = this._currentPageGroup();
    const useB = regions.alternating && group === "B";
    const groupArr   = useB ? regions.defaultsB : regions.defaults;
    const groupKind  = useB ? "defaultB" : "default";
    const groupLabel = regions.alternating ? `Default ${group}` : "Default";
    const groupScope = regions.alternating ? `all ${group} pages` : "all pages";
    const groupColour = useB ? "rgba(64,196,196,0.85)" : "rgba(100,200,100,0.85)";

    if (!groupArr.length && !cfg.overrides.length && !cfg.exclusions.length && !cfg.tables.length) {
      list.innerHTML = '<div class="dajb-region-empty">No regions yet. Pick a tool and drag a box on the page.</div>';
      return;
    }

    groupArr.forEach((r, i) => addRow(groupKind, groupLabel, groupColour, r, groupScope, true, i));
    (cfg.overrides ?? []).forEach((r, i) => addRow("override",  "Override",  "rgba(100,160,255,0.9)",  r, `page ${this.currentPage}`, true,  i));
    (cfg.exclusions ?? []).forEach((r, i) => addRow("exclusion", "Exclusion", "rgba(224,120,120,0.9)",  r, `page ${this.currentPage}`, false, i));
    (cfg.tables ?? []).forEach((r, i) => addRow("table",     "Table",     "rgba(167,139,250,0.9)",  r, `page ${this.currentPage}`, false, i));

    if (cfg.overrides?.length) {
      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "dajb-region-savetpl";
      saveBtn.dataset.regionAction = "save-override-template";
      saveBtn.textContent = "💾 Save overrides as template";
      list.appendChild(saveBtn);
    }
  }

  _renderExceptionsOverview() {
    const root = this.app.element?.querySelector("#dajb-region-exceptions");
    if (!root) return;
    root.innerHTML = "";

    const rule = this.rule;
    if (!rule) return;
    const regions = RuleManager.normalizeRegions(rule);

    const head = document.createElement("div");
    head.className = "dajb-region-overview-head";
    head.textContent = `Defaults: ${regions.defaults.length} (all pages)`;
    root.appendChild(head);

    const pages = Object.keys(regions.pages)
      .map(Number)
      .filter(p => (regions.pages[p].overrides?.length || regions.pages[p].exclusions?.length || regions.pages[p].tables?.length))
      .sort((a, b) => a - b);

    if (!pages.length) {
      const empty = document.createElement("div");
      empty.className = "dajb-region-empty";
      empty.textContent = "No page exceptions yet. Use the Override or Exclusion tool on a page.";
      root.appendChild(empty);
      return;
    }

    for (const p of pages) {
      const cfg = regions.pages[p];
      const row = document.createElement("div");
      row.className = "dajb-region-overview-row";
      if (p === this.currentPage) row.classList.add("dajb-region-selected");
      row.dataset.regionAction = "goto-page";
      row.dataset.page = String(p);
      row.title = "Jump to this page";
      const parts = [];
      if (cfg.overrides?.length)  parts.push(`${cfg.overrides.length} override${cfg.overrides.length !== 1 ? "s" : ""}`);
      if (cfg.exclusions?.length) parts.push(`${cfg.exclusions.length} exclusion${cfg.exclusions.length !== 1 ? "s" : ""}`);
      if (cfg.tables?.length)     parts.push(`${cfg.tables.length} table${cfg.tables.length !== 1 ? "s" : ""}`);
      row.innerHTML = `<strong>Page ${p}</strong> <span class="dajb-region-scope">${parts.join(", ")}</span>`;
      root.appendChild(row);
    }
  }

  // ── Region list drag-reorder ────────────────────────────────────────────────

  _attachListDragDrop(list) {
    if (!list) return;

    list.addEventListener("dragstart", (ev) => {
      const row = ev.target.closest(".dajb-region-draggable");
      if (!row) { ev.preventDefault(); return; }
      this._listDrag = { kind: row.dataset.kind, index: Number(row.dataset.index) };
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("text/plain", "region-row");
      row.classList.add("dajb-dragging");
    });

    list.addEventListener("dragover", (ev) => {
      if (!this._listDrag) return;
      const row = ev.target.closest(".dajb-region-row");
      this._clearListIndicators(list);
      // Only allow dropping onto a row of the same group.
      if (!row || row.dataset.kind !== this._listDrag.kind) { ev.dataTransfer.dropEffect = "none"; return; }
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
      const rect = row.getBoundingClientRect();
      const after = (ev.clientY - rect.top) / rect.height > 0.5;
      row.classList.add(after ? "dajb-drop-after" : "dajb-drop-before");
    });

    list.addEventListener("drop", (ev) => {
      if (!this._listDrag) return;
      const row = ev.target.closest(".dajb-region-row");
      this._clearListIndicators(list);
      if (row && row.dataset.kind === this._listDrag.kind) {
        ev.preventDefault();
        const rect = row.getBoundingClientRect();
        const after = (ev.clientY - rect.top) / rect.height > 0.5;
        let to = Number(row.dataset.index) + (after ? 1 : 0);
        this._reorderRegion(this._listDrag.kind, this._listDrag.index, to);
      }
      this._listDrag = null;
    });

    const cleanup = () => { this._clearListIndicators(list); this._listDrag = null;
      list.querySelectorAll(".dajb-dragging").forEach(el => el.classList.remove("dajb-dragging")); };
    list.addEventListener("dragend", cleanup);
    list.addEventListener("dragleave", (ev) => { if (!list.contains(ev.relatedTarget)) this._clearListIndicators(list); });
  }

  _clearListIndicators(list) {
    list?.querySelectorAll(".dajb-drop-before, .dajb-drop-after")
      .forEach((el) => el.classList.remove("dajb-drop-before", "dajb-drop-after"));
  }

  _reorderRegion(kind, from, to) {
    const rule = this.rule;
    if (!rule) return;
    const regions = RuleManager.normalizeRegions(rule);
    const arr = kind === "default"  ? regions.defaults
              : kind === "defaultB" ? regions.defaultsB
              : this._pageCfg(rule, this.currentPage).overrides;
    if (from < 0 || from >= arr.length) return;
    if (to > from) to -= 1; // account for removal shift
    if (to === from) return;
    const [moved] = arr.splice(from, 1);
    arr.splice(Math.max(0, Math.min(to, arr.length)), 0, moved);
    this._renumber(arr);
    this._persist();
    this._redrawOverlay();
    this._renderSidePanel();
  }

  /** Push region changes into the live preview (regions already live on the rule). */
  _persist() {
    this.app._schedulePreviewRefresh(true);
  }

  // ── Coordinate transforms ─────────────────────────────────────────────────────

  _pdfRectToCanvas(r) {
    const vp = this.viewport;
    const dpr = window.devicePixelRatio || 1;
    const [x1, y1] = vp.convertToViewportPoint(r.x,       r.y + r.h);
    const [x2, y2] = vp.convertToViewportPoint(r.x + r.w, r.y);
    return {
      x: Math.min(x1, x2) * dpr,
      y: Math.min(y1, y2) * dpr,
      w: Math.abs(x2 - x1) * dpr,
      h: Math.abs(y2 - y1) * dpr,
    };
  }

  _canvasRectToPdf(c) {
    const vp = this.viewport;
    const dpr = window.devicePixelRatio || 1;
    const cssX = c.x / dpr, cssY = c.y / dpr, cssW = c.w / dpr, cssH = c.h / dpr;
    const [l, t] = vp.convertToPdfPoint(cssX,        cssY);
    const [r, b] = vp.convertToPdfPoint(cssX + cssW, cssY + cssH);
    return {
      x: Math.min(l, r),
      y: Math.min(t, b),
      w: Math.abs(r - l),
      h: Math.abs(t - b),
    };
  }
}

// ── Module-level helper ──────────────────────────────────────────────────────
function normalizeRect(x1, y1, x2, y2) {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}
