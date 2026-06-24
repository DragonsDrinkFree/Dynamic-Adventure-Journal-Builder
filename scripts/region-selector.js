import { RuleManager } from "./rule-manager.js";

/**
 * RegionSelector — drives the "Select Regions" tab.
 *
 * Renders the loaded PDF (page by page, across the active top-level rule's page
 * range) onto a canvas with a transparent overlay for drawing bounding boxes.
 * Three tools produce three kinds of region, all stored on the top-level page
 * rule's `regions` object in PDF user units:
 *
 *   • Default   — green; applied at the same coordinates on every page in range.
 *                 Multiple may be drawn per page (e.g. two columns); items are
 *                 stitched in draw order.
 *   • Exclusion — red; current-page-only carve-outs subtracted from the defaults.
 *   • Override  — blue; current-page-only regions that replace the defaults for
 *                 that single page.
 *
 * Coordinate math mirrors the reference modules' PDF scanner: PDF rects are kept
 * scale-independent and converted to/from canvas pixels via the pdf.js viewport.
 */
export class RegionSelector {
  constructor(app) {
    this.app = app;
    this.tool = null;            // "default" | "exclusion" | "override" | null
    this.scale = 1.3;
    this.currentPage = null;     // actual PDF page number
    this.viewport = null;        // pdf.js PageViewport for the rendered page
    this.dragStart = null;       // { x, y } in canvas buffer px
    this.currentRect = null;     // rubber-band rect in canvas buffer px
    this._ruleId = null;         // top-level rule id this tab is bound to
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
    this._attachListeners();
    // If the regions tab is the one currently visible, (re)render it.
    const tab = this.app.element?.querySelector("#dajb-tab-regions");
    if (tab && !tab.hidden) this.activate();
  }

  /** Called when the user switches to the Select Regions tab. */
  async activate() {
    this._syncToolButtons();
    const rule = this.rule;
    const pages = this.pages;

    // Reset page when the bound rule changed or the current page left the range.
    if (rule?.id !== this._ruleId) { this._ruleId = rule?.id ?? null; this.currentPage = null; }
    if (!pages.includes(this.currentPage)) this.currentPage = pages[0] ?? null;

    await this._renderCurrentPage();
  }

  // ── Listeners ────────────────────────────────────────────────────────────────

  _attachListeners() {
    const tab = this.app.element?.querySelector("#dajb-tab-regions");
    if (!tab) return;

    // Toolbar / nav / list buttons (delegated)
    tab.addEventListener("click", (ev) => {
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
      overlay.addEventListener("mouseleave", () => { this.dragStart = null; this.currentRect = null; this._redrawOverlay(); });
    }
  }

  _onAction(action, btn) {
    switch (action) {
      case "tool-default":   this._toggleTool("default");   break;
      case "tool-exclusion": this._toggleTool("exclusion"); break;
      case "tool-override":  this._toggleTool("override");  break;
      case "prev-page":      this._stepPage(-1); break;
      case "next-page":      this._stepPage(1);  break;
      case "delete-region":  this._deleteRegion(btn); break;
    }
  }

  _toggleTool(tool) {
    this.tool = this.tool === tool ? null : tool;
    this._syncToolButtons();
    const overlay = this.app.element?.querySelector("#dajb-region-canvas");
    if (overlay) overlay.style.cursor = this.tool ? "crosshair" : "default";
  }

  _syncToolButtons() {
    const tab = this.app.element?.querySelector("#dajb-tab-regions");
    if (!tab) return;
    for (const t of ["default", "exclusion", "override"]) {
      tab.querySelector(`[data-region-action="tool-${t}"]`)
        ?.classList.toggle("dajb-active", this.tool === t);
    }
    const overlay = tab.querySelector("#dajb-region-canvas");
    if (overlay) overlay.style.cursor = this.tool ? "crosshair" : "default";
  }

  async _stepPage(delta) {
    const pages = this.pages;
    const idx = pages.indexOf(this.currentPage);
    const next = pages[idx + delta];
    if (next == null) return;
    this.currentPage = next;
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

    if (!this.pdfParser.totalPages) {
      this._setCanvasMessage(wrap, "Load a PDF to draw regions.");
      this._renderRegionList();
      return;
    }
    if (!rule) {
      this._setCanvasMessage(wrap, "Select a rule to draw regions.");
      this._renderRegionList();
      return;
    }
    if (!pages.length) {
      this._setCanvasMessage(wrap, "Set page ranges on the top-level rule to draw regions.");
      this._renderRegionList();
      return;
    }

    this._clearCanvasMessage(wrap);
    if (!pages.includes(this.currentPage)) this.currentPage = pages[0];

    try {
      this.viewport = await this.pdfParser.renderPageToCanvas(this.currentPage, pdfCanvas, this.scale);
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
      label.textContent = `Page ${this.currentPage}  (${idx + 1}/${pages.length})`;
    }

    this._redrawOverlay();
    this._renderRegionList();
  }

  _setCanvasMessage(wrap, msg) {
    if (!wrap) return;
    let el = wrap.querySelector(".dajb-region-msg");
    if (!el) {
      el = document.createElement("div");
      el.className = "dajb-region-msg";
      wrap.appendChild(el);
    }
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
    const cfg = regions.pages[this.currentPage] ?? regions.pages[String(this.currentPage)] ?? { exclusions: [], overrides: [] };
    const pageOverridden = (cfg.overrides ?? []).length > 0;

    const drawRect = (r, stroke, fill, label, dashed = false) => {
      const c = this._pdfRectToCanvas(r);
      ctx.fillStyle = fill;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 2;
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

    // Default regions — drawn on every page; faded/dashed when overridden here.
    for (const r of regions.defaults) {
      drawRect(
        r,
        pageOverridden ? "rgba(120,200,120,0.4)" : "rgba(100,200,100,0.85)",
        pageOverridden ? "rgba(120,200,120,0.05)" : "rgba(100,200,100,0.12)",
        pageOverridden ? "default (inactive)" : "default",
        pageOverridden
      );
    }

    // Override regions (current page)
    for (const r of cfg.overrides ?? []) {
      drawRect(r, "rgba(100,160,255,0.9)", "rgba(100,160,255,0.15)", "override");
    }

    // Exclusion regions (current page)
    for (const r of cfg.exclusions ?? []) {
      drawRect(r, "rgba(224,120,120,0.9)", "rgba(224,120,120,0.18)", "exclude");
    }

    // Active rubber-band
    if (this.tool && this.currentRect) {
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

  // ── Mouse handlers ────────────────────────────────────────────────────────────

  _bufferCoords(ev, overlay) {
    return {
      x: ev.offsetX * (overlay.width / overlay.clientWidth),
      y: ev.offsetY * (overlay.height / overlay.clientHeight),
    };
  }

  _onMouseDown(ev, overlay) {
    if (!this.tool || !this.viewport) return;
    this.dragStart = this._bufferCoords(ev, overlay);
    this.currentRect = null;
  }

  _onMouseMove(ev, overlay) {
    if (!this.tool || !this.dragStart) return;
    const c = this._bufferCoords(ev, overlay);
    this.currentRect = normalizeRect(this.dragStart.x, this.dragStart.y, c.x, c.y);
    this._redrawOverlay();
  }

  _onMouseUp(ev, overlay) {
    if (!this.tool || !this.dragStart) return;
    const rect = this.currentRect;
    this.dragStart = null;
    this.currentRect = null;
    if (rect && rect.w > 8 && rect.h > 8) {
      this._finalizeRegion(rect);
    } else {
      this._redrawOverlay();
    }
  }

  _finalizeRegion(canvasRect) {
    const rule = this.rule;
    if (!rule) return;
    const pdfRect = this._canvasRectToPdf(canvasRect);
    const regions = RuleManager.normalizeRegions(rule);

    if (this.tool === "default") {
      regions.defaults.push({
        id: foundry.utils.randomID(),
        order: regions.defaults.length,
        ...pdfRect,
      });
    } else {
      const cfg = this._pageCfg(rule, this.currentPage);
      if (this.tool === "exclusion") {
        cfg.exclusions.push({ ...pdfRect });
      } else if (this.tool === "override") {
        cfg.overrides.push({ id: foundry.utils.randomID(), order: cfg.overrides.length, ...pdfRect });
      }
    }

    this._persist();
    this._redrawOverlay();
    this._renderRegionList();
  }

  _pageCfg(rule, page) {
    const regions = RuleManager.normalizeRegions(rule);
    const key = String(page);
    if (!regions.pages[key]) regions.pages[key] = { exclusions: [], overrides: [] };
    return regions.pages[key];
  }

  // ── Region list ───────────────────────────────────────────────────────────────

  _renderRegionList() {
    const list = this.app.element?.querySelector("#dajb-region-list");
    if (!list) return;
    list.innerHTML = "";

    const rule = this.rule;
    if (!rule) return;
    const regions = RuleManager.normalizeRegions(rule);
    const cfg = regions.pages[String(this.currentPage)] ?? { exclusions: [], overrides: [] };

    const fmt = (r) => `${Math.round(r.w)}×${Math.round(r.h)} @ (${Math.round(r.x)}, ${Math.round(r.y)})`;

    const addRow = (kind, label, colour, r, scope) => {
      const row = document.createElement("div");
      row.className = "dajb-region-row";
      const swatch = document.createElement("span");
      swatch.className = "dajb-region-swatch";
      swatch.style.background = colour;
      row.appendChild(swatch);
      const text = document.createElement("span");
      text.className = "dajb-region-rowtext";
      text.innerHTML = `<strong>${label}</strong> <span class="dajb-region-scope">${scope}</span><br><span class="dajb-region-dims">${fmt(r)}</span>`;
      row.appendChild(text);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "dajb-region-del";
      del.textContent = "✕";
      del.title = "Delete region";
      del.dataset.regionAction = "delete-region";
      del.dataset.kind = kind;
      if (r.id) del.dataset.id = r.id;
      else del.dataset.index = String((kind === "exclusion" ? cfg.exclusions : cfg.overrides).indexOf(r));
      row.appendChild(del);
      list.appendChild(row);
    };

    if (!regions.defaults.length && !cfg.overrides.length && !cfg.exclusions.length) {
      list.innerHTML = '<div class="dajb-region-empty">No regions yet. Pick a tool and drag a box on the page.</div>';
      return;
    }

    for (const r of regions.defaults)  addRow("default",   "Default",   "rgba(100,200,100,0.85)", r, "all pages");
    for (const r of cfg.overrides ?? []) addRow("override",  "Override",  "rgba(100,160,255,0.9)",  r, `page ${this.currentPage}`);
    for (const r of cfg.exclusions ?? []) addRow("exclusion", "Exclusion", "rgba(224,120,120,0.9)",  r, `page ${this.currentPage}`);
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
    } else {
      const cfg = this._pageCfg(rule, this.currentPage);
      if (kind === "override") {
        cfg.overrides = id ? cfg.overrides.filter(r => r.id !== id) : cfg.overrides.filter((_, i) => i !== index);
      } else if (kind === "exclusion") {
        cfg.exclusions = cfg.exclusions.filter((_, i) => i !== index);
      }
      // Drop now-empty page config to keep the saved file tidy.
      if (!cfg.overrides.length && !cfg.exclusions.length) delete regions.pages[String(this.currentPage)];
    }

    this._persist();
    this._redrawOverlay();
    this._renderRegionList();
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
