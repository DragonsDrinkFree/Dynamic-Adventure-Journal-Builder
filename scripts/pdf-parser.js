/**
 * PDFParser — wraps PDF.js to extract text from an uploaded PDF file.
 *
 * Tries to use the PDF.js that ships with Foundry v13 first; falls back to CDN.
 */

const PDFJS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER_CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

async function getPdfjsLib() {
  // Foundry v13 exposes pdfjsLib on the window from its bundled viewer
  if (window.pdfjsLib) return window.pdfjsLib;

  // Try the path Foundry v13 uses internally
  const foundryPaths = [
    "/scripts/pdfjs/pdf.js",
    "/scripts/pdfjs/build/pdf.js",
    "/pdfjs/pdf.js",
  ];
  for (const path of foundryPaths) {
    try {
      const mod = await import(path);
      if (mod?.default || mod?.getDocument) {
        const lib = mod.default ?? mod;
        if (!lib.GlobalWorkerOptions?.workerSrc) {
          lib.GlobalWorkerOptions.workerSrc = path.replace("pdf.js", "pdf.worker.js");
        }
        return lib;
      }
    } catch (_) {
      // not this path, try next
    }
  }

  // Fall back to CDN
  console.warn("DAJB | Foundry PDF.js not found, loading from CDN…");
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = PDFJS_CDN;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
  // CDN script sets window.pdfjsLib
  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_CDN;
    return window.pdfjsLib;
  }
  throw new Error("Failed to load PDF.js");
}

export class PDFParser {
  /**
   * Set to true from the browser console to enable column-detection diagnostics.
   *   PDFParser.debugColumns = true;
   * Then trigger a preview refresh — detailed logs appear in the console for
   * every page processed, including the full x-histogram, gap candidate, and
   * final split result.
   */
  static debugColumns = false;
  /** Set PDFParser.debugDetect = true in the console to log detectTableBoundaries internals. */
  static debugDetect  = false;
  /** Set PDFParser.debugParseTable = true in the console to log parseTableRegion internals. */
  static debugParseTable = false;

  /**
   * Character replacement map applied during text extraction.
   * Handles common PDF.js glyph-mapping failures (ligatures, zero-width chars,
   * Private Use Area codepoints from custom fonts).
   *
   * Add custom mappings from the console:
   *   PDFParser.charReplacements.set('\uE001', 'é');
   * Or for bulk additions:
   *   Object.entries({'\uE001':'é', '\uE002':'è'}).forEach(([k,v]) => PDFParser.charReplacements.set(k,v));
   *
   * After changing the map, re-open the PDF or clear the cache to see effects.
   */
  static charReplacements = new Map([
    // Common ligatures (some PDFs use these instead of individual chars)
    ['\uFB00', 'ff'],
    ['\uFB01', 'fi'],
    ['\uFB02', 'fl'],
    ['\uFB03', 'ffi'],
    ['\uFB04', 'ffl'],
    ['\uFB05', 'st'],
    ['\uFB06', 'st'],
    // Zero-width / invisible characters
    ['\u00AD', ''],      // soft hyphen
    ['\u200B', ''],      // zero-width space
    ['\u200C', ''],      // zero-width non-joiner
    ['\u200D', ''],      // zero-width joiner
    ['\uFEFF', ''],      // BOM / zero-width no-break space
  ]);

  /**
   * Normalise a text string using the charReplacements map.
   * Also flags Private Use Area codepoints (U+E000–U+F8FF) that have no
   * mapping — these are logged once so the user knows which codepoints to add.
   */
  static normalizeText(str) {
    if (!str) return str;
    let result = str;
    for (const [from, to] of PDFParser.charReplacements) {
      if (result.includes(from)) result = result.replaceAll(from, to);
    }
    // Detect unmapped Private Use Area characters and warn once per codepoint
    for (let i = 0; i < result.length; i++) {
      const code = result.charCodeAt(i);
      if (code >= 0xE000 && code <= 0xF8FF) {
        const hex = `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
        if (!PDFParser._warnedPUA.has(code)) {
          PDFParser._warnedPUA.add(code);
          const context = str.slice(Math.max(0, i - 10), i + 10);
          console.warn(
            `DAJB | Unmapped Private Use Area character ${hex} in: "${context}"` +
            `\n  → Add a mapping: PDFParser.charReplacements.set('${hex}', 'replacement');`
          );
        }
      }
    }
    return result;
  }
  static _warnedPUA = new Set();

  /** Clear the item cache so new charReplacements take effect on next preview. */
  clearItemCache() { this._itemCache.clear(); this._cache.clear(); PDFParser._warnedPUA.clear(); }

  constructor() {
    /** @type {Object|null} PDF.js document proxy */
    this._doc = null;
    /** @type {number} */
    this._totalPages = 0;
    /** @type {Map<number, string>} page text cache */
    this._cache = new Map();
    /** @type {Map<number, Array<{text:string,fontSize:number,fontName:string}>>} */
    this._itemCache = new Map();
    /** @type {Map<number, number>} page viewport width cache (pt) */
    this._pageWidths = new Map();
  }

  get totalPages() {
    return this._totalPages;
  }

  /** Returns the viewport width (pt) for a loaded page, or 0 if unknown. */
  getPageWidth(pageNum) {
    return this._pageWidths.get(pageNum) ?? 0;
  }

  /**
   * Load a File object as a PDF.
   * @param {File} file
   */
  async loadPDF(file) {
    const pdfjsLib = await getPdfjsLib();
    this._pdfjsLib = pdfjsLib;

    const arrayBuffer = await file.arrayBuffer();
    const typedArray = new Uint8Array(arrayBuffer);

    await this._doc?.destroy();
    this._doc = await pdfjsLib.getDocument({ data: typedArray }).promise;
    this._totalPages = this._doc.numPages;
    this._cache.clear();
    this._itemCache.clear();
    this._pageWidths.clear();
    PDFParser._warnedPUA.clear();
    console.log(`DAJB | PDF loaded: ${file.name} (${this._totalPages} pages)`);
    return this._totalPages;
  }

  /**
   * Return the text content of a single page (1-indexed). Caches results.
   * @param {number} pageNum
   * @returns {Promise<string>}
   */
  async getPageText(pageNum) {
    if (!this._doc) throw new Error("No PDF loaded");
    if (pageNum < 1 || pageNum > this._totalPages) return "";
    if (this._cache.has(pageNum)) return this._cache.get(pageNum);

    const page = await this._doc.getPage(pageNum);
    const content = await page.getTextContent();
    // Join items; preserve line breaks by grouping by transform y
    const text = content.items.map((item) => item.str).join(" ");
    this._cache.set(pageNum, text);
    return text;
  }

  /**
   * Return concatenated text from a set of page ranges.
   * @param {Array<{start:number, end:number}>} ranges
   * @returns {Promise<string>}
   */
  async getPagesText(ranges) {
    if (!this._doc) throw new Error("No PDF loaded");
    const parts = [];
    for (const { start, end } of ranges) {
      for (let p = start; p <= Math.min(end, this._totalPages); p++) {
        parts.push(await this.getPageText(p));
      }
    }
    return parts.join("\n");
  }

  /**
   * Return structured text items for a single page (1-indexed). Caches results.
   * Each item has { text, fontSize, fontName }.
   * fontSize comes from transform[3] (the Y-scale of the PDF text matrix ≈ pt size).
   * @param {number} pageNum
   * @returns {Promise<Array<{text:string, fontSize:number, fontName:string}>>}
   */
  async getPageItems(pageNum) {
    if (!this._doc) throw new Error("No PDF loaded");
    if (pageNum < 1 || pageNum > this._totalPages) return [];
    if (this._itemCache.has(pageNum)) return this._itemCache.get(pageNum);

    const page = await this._doc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    this._pageWidths.set(pageNum, viewport.width);

    const content = await page.getTextContent();

    const items = content.items
      .map((item) => {
        const fontName = item.fontName ?? "";
        const fn = fontName.toLowerCase();
        const hasText = typeof item.str === 'string' && item.str.trim();
        const rawX = item.transform?.[4] ?? 0;
        return { _keep: !!hasText, text: PDFParser.normalizeText(item.str), fontSize: Math.round(Math.abs(item.transform?.[3] ?? 0) * 100) / 100,
          fontName,
          x: rawX,
          y: item.transform?.[5] ?? 0,
          width: item.width ?? 0,
          xNorm: viewport.width > 0 ? rawX / viewport.width : 0,
          isBold:   /bold|heavy|black|demi|semibold|extrabold|ultrabold/.test(fn),
          isItalic: /italic|oblique|slanted|inclined/.test(fn),
          pageNum,
        };
      })
      .filter(item => item._keep)
      .map(({ _keep, ...rest }) => rest);

    // Deduplicate items with identical position and text — some PDFs render
    // the same text twice (e.g. for a shadow/stroke effect) producing doubled
    // output.  We keep only the first occurrence of each (x,y,text) triple.
    const seen = new Set();
    const deduped = items.filter(item => {
      const key = `${Math.round(item.x)},${Math.round(item.y)},${item.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    this._itemCache.set(pageNum, deduped);
    return deduped;
  }

  /**
   * Walk a PDF.js operator list and return one hex color string per "show text"
   * operation, reflecting the fill color that was active at that point.
   * Handles RGB, gray, CMYK, and generic setFillColor ops.
   * @param {Object} opList  — result of page.getOperatorList()
   * @returns {string[]}
   */
  static _extractColorSequence(opList, pdfjsLib = null) {
    // PDF.js OPS constants — prefer the live lib passed in, then window fallback,
    // then hardcoded values for PDF.js 3.x (used when loaded as ES module).
    const lib = pdfjsLib ?? window.pdfjsLib;
    const OPS = lib?.OPS ?? {
      setFillGray: 78, setFillRGBColor: 80, setFillCMYKColor: 82,
      setFillColorSpace: 83, setFillColor: 84, setFillColorN: 85,
      showText: 49, showSpacedText: 50,
      nextLineShowText: 51, nextLineSetSpacingShowText: 52,
    };

    const toHex = (r, g, b) =>
      '#' + [r, g, b]
        .map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
        .join('');

    const colors = [];
    let r = 0, g = 0, b = 0; // default: black

    for (let i = 0; i < opList.fnArray.length; i++) {
      const fn   = opList.fnArray[i];
      const args = opList.argsArray[i];

      if (fn === OPS.setFillRGBColor) {
        // rg — DeviceRGB: 3 × [0–1]
        r = args[0] * 255; g = args[1] * 255; b = args[2] * 255;
      } else if (fn === OPS.setFillGray) {
        // g — DeviceGray: 1 × [0–1]
        r = g = b = args[0] * 255;
      } else if (fn === OPS.setFillCMYKColor) {
        // k — DeviceCMYK: 4 × [0–1]
        const [c, m, y, k] = args;
        r = (1 - c) * (1 - k) * 255;
        g = (1 - m) * (1 - k) * 255;
        b = (1 - y) * (1 - k) * 255;
      } else if (fn === OPS.setFillColor || fn === OPS.setFillColorN) {
        // sc / scn — color values depend on current colorspace.
        // Infer from arg count: 4 = CMYK, 3 = RGB, 1 = gray/spot-tint.
        // This covers the common InDesign/Illustrator CMYK-exported PDF case.
        if (args?.length === 4) {
          const [c, m, y, k] = args;
          r = (1 - c) * (1 - k) * 255;
          g = (1 - m) * (1 - k) * 255;
          b = (1 - y) * (1 - k) * 255;
        } else if (args?.length === 3) {
          r = args[0] * 255; g = args[1] * 255; b = args[2] * 255;
        } else if (args?.length === 1) {
          // Single-channel: gray or spot-color tint — treat as gray shade
          r = g = b = args[0] * 255;
        }
      } else if (
        fn === OPS.showText || fn === OPS.showSpacedText ||
        fn === OPS.nextLineShowText || fn === OPS.nextLineSetSpacingShowText
      ) {
        colors.push(toHex(r, g, b));
      }
    }

    return colors;
  }

  /**
   * Return all structured text items across a set of page ranges.
   * @param {Array<{start:number, end:number}>} ranges
   * @returns {Promise<Array<{text:string, fontSize:number, fontName:string, x:number, y:number}>>}
   */
  async getPagesItems(ranges) {
    if (!this._doc) throw new Error("No PDF loaded");
    const all = [];
    for (const { start, end } of ranges) {
      for (let p = start; p <= Math.min(end, this._totalPages); p++) {
        const pageItems = await this.getPageItems(p);
        // Always apply column reordering — reorderForColumns is a no-op on
        // single-column pages (returns items unchanged when no gap is detected).
        all.push(...PDFParser.reorderForColumns(pageItems, this.getPageWidth(p)));
      }
    }
    return PDFParser.joinHyphenatedSplits(all);
  }

  // ── Region-aware extraction ────────────────────────────────────────────────

  /** True when a text item's anchor (x, y) falls inside a {x,y,w,h} rect (PDF units). */
  static _inRect(item, r) {
    return item.x >= r.x && item.x <= r.x + r.w &&
           item.y >= r.y && item.y <= r.y + r.h;
  }

  /** Filter a page's items to those whose anchor falls inside a region rect. */
  static filterItemsToRegion(items, region) {
    return items.filter(it => PDFParser._inRect(it, region));
  }

  /**
   * Sort a small set of items into reading order: top-to-bottom (descending Y),
   * grouping items within `yTol` pt onto one line and sorting those left-to-right.
   * Used for manually-drawn regions where the heuristic column detector is bypassed.
   */
  static sortItemsReadingOrder(items, yTol = 2) {
    const col = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
    const result = [];
    let line = [];
    for (const item of col) {
      if (!line.length || Math.abs(item.y - line[0].y) <= yTol) {
        line.push(item);
      } else {
        line.sort((a, b) => a.x - b.x);
        result.push(...line);
        line = [item];
      }
    }
    if (line.length) { line.sort((a, b) => a.x - b.x); result.push(...line); }
    return result;
  }

  /**
   * Stitch an ordered list of per-region item arrays into one continuous stream.
   * Each array (already in reading order) is stacked vertically below the previous
   * one by remapping its Y values, so downstream geometry (paragraph spacing, table
   * detection) sees a single top-to-bottom document.  Intra-region Y gaps are
   * preserved; a fixed gap separates regions/pages.
   * @param {Array<Array>} arrays
   * @returns {Array}
   */
  static stitchRegionStreams(arrays) {
    const GAP = 50; // pt of separation between stacked regions
    const out = [];
    let topY = 1e6;
    for (const items of arrays) {
      if (!items?.length) continue;
      const ys = items.map(i => i.y);
      const rMax = Math.max(...ys);
      const rMin = Math.min(...ys);
      for (const it of items) out.push({ ...it, y: topY - (rMax - it.y) });
      topY -= (rMax - rMin) + GAP;
    }
    return out;
  }

  /**
   * Region-aware variant of getPagesItems.  For each page in `ranges`, picks the
   * page's override regions if any, else the shared default regions, filters items
   * into them (in `order`), subtracts the page's exclusion rects, sorts each region
   * into reading order, then stitches everything into one continuous stream.
   *
   * The heuristic column reorder is intentionally bypassed: manual region order is
   * authoritative (e.g. drawing left then right column selects the reading order).
   *
   * @param {Array<{start:number,end:number}>} ranges
   * @param {{defaults:Array, pages:Object}} regions
   * @returns {Promise<Array>}
   */
  async getPagesItemsForRegions(ranges, regions) {
    if (!this._doc) throw new Error("No PDF loaded");
    const defaults    = regions?.defaults ?? [];
    const defaultsB   = regions?.defaultsB ?? [];
    const alternating = !!regions?.alternating;
    const pageCfgs    = regions?.pages ?? {};
    const streams     = [];
    let pageIndex     = -1; // position within the flattened range (for A/B alternation)

    // Tag items that fall inside a Table Override rect (clone, so we never mutate
    // the cached page items).  Tags ride through stitching and section-splitting.
    const tagTables = (items, tables) => !tables?.length ? items
      : items.map(it => {
          const t = tables.find(tb => PDFParser._inRect(it, tb));
          return t ? { ...it, tableRegionId: t.id, tableMaxColumns: t.maxColumns } : it;
        });

    for (const { start, end } of ranges) {
      for (let p = start; p <= Math.min(end, this._totalPages); p++) {
        pageIndex++;
        const pageItems  = await this.getPageItems(p);
        const cfg        = pageCfgs[p] ?? pageCfgs[String(p)] ?? {};
        const overrides  = cfg.overrides  ?? [];
        const exclusions = cfg.exclusions ?? [];
        const tables     = cfg.tables     ?? [];
        // Alternating mode: even page-index → group A (defaults), odd → group B.
        const groupDefaults = alternating
          ? (pageIndex % 2 === 0 ? defaults : defaultsB)
          : defaults;
        const active = overrides.length ? overrides : groupDefaults;

        if (active.length) {
          const ordered = [...active].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
          for (const region of ordered) {
            let items = PDFParser.filterItemsToRegion(pageItems, region);
            if (exclusions.length) {
              items = items.filter(it => !exclusions.some(ex => PDFParser._inRect(it, ex)));
            }
            items = PDFParser.sortItemsReadingOrder(items);
            items = tagTables(items, tables);
            if (items.length) streams.push(items);
          }
        } else if (tables.length) {
          // No content regions on this page, but it has Table Override regions:
          // keep the whole page (minus exclusions) so its text isn't dropped, and
          // tag the table items.  Use the heuristic column reorder for reading order.
          let items = pageItems;
          if (exclusions.length) {
            items = items.filter(it => !exclusions.some(ex => PDFParser._inRect(it, ex)));
          }
          items = PDFParser.reorderForColumns(items, this.getPageWidth(p));
          items = tagTables(items, tables);
          if (items.length) streams.push(items);
        }
        // else: override page with no regions → contributes nothing (whole page excluded).
      }
    }

    return PDFParser.joinHyphenatedSplits(PDFParser.stitchRegionStreams(streams));
  }

  /**
   * Group items by their `tableRegionId` tag (set during region-aware extraction
   * for items inside a Table Override region).  Returns one item array per region,
   * in first-appearance order — the same shape as detectTableBoundaries, so the
   * table-interleave code consumes it unchanged.
   * @param {Array} items
   * @returns {Array<Array>}
   */
  static groupItemsByTableRegion(items) {
    const map = new Map();
    for (const it of items) {
      const id = it.tableRegionId;
      if (id == null) continue;
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(it);
    }
    return [...map.values()];
  }

  /**
   * Render a PDF page onto a canvas, sizing the canvas for the device pixel ratio.
   * Returns the pdf.js viewport (needed for canvas↔PDF coordinate conversion by
   * the region selector).
   *
   * Pass `fitWidth` to scale the page so it fits that CSS width (clamped between
   * `minScale` and `maxScale`); otherwise `scale` is used directly.
   * @param {number} pageNum
   * @param {HTMLCanvasElement} canvas
   * @param {{scale?:number, fitWidth?:number, minScale?:number, maxScale?:number}} [opts]
   * @returns {Promise<Object>} the pdf.js PageViewport
   */
  async renderPageToCanvas(pageNum, canvas, opts = {}) {
    if (!this._doc) throw new Error("No PDF loaded");
    const page     = await this._doc.getPage(pageNum);
    const dpr      = window.devicePixelRatio || 1;

    let scale = opts.scale ?? 1.3;
    if (opts.fitWidth) {
      const baseWidth = page.getViewport({ scale: 1 }).width;
      if (baseWidth > 0) {
        const maxScale = opts.maxScale ?? 6;
        const minScale = opts.minScale ?? 0.1;
        const zoom     = opts.zoom ?? 1;   // user zoom multiplier, relative to fit
        scale = Math.max(minScale, Math.min(maxScale, (opts.fitWidth / baseWidth) * zoom));
      }
    }

    const viewport = page.getViewport({ scale });

    canvas.width        = Math.floor(viewport.width  * dpr);
    canvas.height       = Math.floor(viewport.height * dpr);
    canvas.style.width  = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return viewport;
  }

  /**
   * Merge items where a trailing hyphen indicates a column/line break mid-word.
   * Signal: item ends with `-` AND next item starts with a lowercase letter.
   * Real compound hyphens (e.g. "frost-elf", "Hobbled-and-Blackened") are left
   * untouched because the continuation either starts with a capital or is part of
   * the same item.
   */
  static joinHyphenatedSplits(items) {
    const out = [];
    let i = 0;
    while (i < items.length) {
      const cur = items[i];
      if (cur.text.endsWith('-') && i + 1 < items.length) {
        const nxt = items[i + 1];
        const nxtText = nxt.text;
        // Only rejoin when the continuation starts with a lowercase letter
        if (/^[a-z]/.test(nxtText)) {
          out.push({ ...cur, text: cur.text.slice(0, -1) + nxtText });
          i += 2;
          continue;
        }
      }
      out.push(cur);
      i++;
    }
    return out;
  }

  /**
   * Detect whether `items` come from a two-column page layout and, if so,
   * reorder them left-column-first top-to-bottom then right-column top-to-bottom.
   *
   * Algorithm:
   *  1. Build an x-density histogram across the item x-span.
   *  2. Look for a low-density gap bucket in the middle 20–80 % of the page width.
   *     A bucket qualifies as a gap when its count < 20 % of average bucket density.
   *  3. If a gap is found, split items at that x, sort each column descending Y
   *     (higher Y = top of page in PDF coordinates), then ascending X within each
   *     2 pt Y-tolerance line group.
   *  4. Return [leftColumn, rightColumn] concatenated; or the original array if
   *     no gap is detected (single-column page).
   *
   * @param {Array<{text:string, x:number, y:number}>} items
   * @param {number} pageWidth  Viewport width in pt
   * @returns {Array}
   */
  static reorderForColumns(items, pageWidth) {
    if (!items?.length || !pageWidth) return items;

    const BUCKETS = 20;
    const xs = items.map(i => i.x);
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    if (xMax - xMin < 10) return items; // all items clustered — single column

    const bucketWidth = (xMax - xMin) / BUCKETS;
    const hist = new Array(BUCKETS).fill(0);
    for (const x of xs) {
      const b = Math.min(BUCKETS - 1, Math.floor((x - xMin) / bucketWidth));
      hist[b]++;
    }

    // Select the best column-gap candidate using a bimodality score:
    //   score = leftMax × rightMax
    // where leftMax / rightMax are the densest buckets on each flank.
    // A true two-column gap sits between two dense content clusters so its
    // score is high.  A false gap that lives *inside* one column (e.g. a
    // sparse area inside a table) has a small rightMax and scores low.
    // Among equal-score candidates the emptier bucket wins.
    //
    // Search window: 30–70 % of the item x-range (not page width).
    // Using the content range instead of the page avoids selecting margin/indent
    // boundaries as column gaps — especially on right-hand (odd) pages where the
    // binding margin shifts the content rightward.
    const xSpan = xMax - xMin;
    const midLo = xMin + xSpan * 0.30;
    const midHi = xMin + xSpan * 0.70;
    let bestBucket = -1;
    let bestScore  = -1;
    let bestLeft   = 0;
    let bestRight  = 0;
    for (let b = 1; b < BUCKETS - 1; b++) {
      const centre = xMin + (b + 0.5) * bucketWidth;
      if (centre < midLo || centre > midHi) continue;
      const lm = Math.max(...hist.slice(0, b));
      const rm = Math.max(...hist.slice(b + 1));
      const score = lm * rm;
      if (score > bestScore ||
          (score === bestScore && hist[b] < hist[bestBucket])) {
        bestScore  = score;
        bestBucket = b;
        bestLeft   = lm;
        bestRight  = rm;
      }
    }
    const bestCount = bestBucket >= 0 ? hist[bestBucket] : Infinity;

    let splitX = null;
    let splitReason = '';
    if (bestBucket >= 0) {
      const gapX = xMin + (bestBucket + 0.5) * bucketWidth;
      const leftCount  = items.filter(i => i.x <  gapX).length;
      const rightCount = items.filter(i => i.x >= gapX).length;
      const minFlankDensity = Math.max(2, items.length / BUCKETS * 0.2);
      // Minimum balance: reject lopsided splits where the smaller side has
      // <30% of total items — these are margin/indent boundaries, not column gaps.
      const minBalance = Math.min(leftCount, rightCount) / items.length;
      if (bestLeft  >= minFlankDensity &&
          bestRight >= minFlankDensity &&
          bestCount < Math.min(bestLeft, bestRight) * 0.30 &&
          Math.min(leftCount, rightCount) >= 10 &&
          minBalance >= 0.30) {
        splitX = gapX;
        splitReason = 'primary';
      }
    }

    // ── Fallback: wide Y-line detection ───────────────────────────────────────
    // When the primary histogram check fails, many Y-lines will span the full
    // page width (items from BOTH columns on the same visual line).  If this
    // pattern is prominent, the page is almost certainly two-column and the
    // primary thresholds were just too strict.  Retry with relaxed thresholds.
    if (splitX === null && bestBucket >= 0) {
      const Y_CHECK_TOL = 2;
      const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
      const yLines = [];
      let curLine = [sorted[0]];
      for (let i = 1; i < sorted.length; i++) {
        if (Math.abs(sorted[i].y - curLine[0].y) <= Y_CHECK_TOL) {
          curLine.push(sorted[i]);
        } else {
          yLines.push(curLine);
          curLine = [sorted[i]];
        }
      }
      if (curLine.length) yLines.push(curLine);

      const wideThreshold = (xMax - xMin) * 0.35;
      const wideCount = yLines.filter(line => {
        const lxs = line.map(i => i.x);
        return Math.max(...lxs) - Math.min(...lxs) > wideThreshold;
      }).length;
      const wideRatio = wideCount / yLines.length;

      if (wideRatio > 0.25) {
        // Many Y-lines span both column regions — use the best gap even though
        // it didn't meet the strict primary thresholds.
        const gapX = xMin + (bestBucket + 0.5) * bucketWidth;
        const leftCount  = items.filter(i => i.x <  gapX).length;
        const rightCount = items.filter(i => i.x >= gapX).length;
        if (Math.min(leftCount, rightCount) >= 3) {
          splitX = gapX;
          splitReason = `fallback(wideRatio=${wideRatio.toFixed(2)},wideLines=${wideCount}/${yLines.length})`;
        }
      }
    }

    if (PDFParser.debugColumns) {
      const bucketCentres = hist.map((count, b) => {
        const cx = xMin + (b + 0.5) * bucketWidth;
        const inRange = cx >= midLo && cx <= midHi;
        return `  b${b.toString().padStart(2)} x=${Math.round(cx).toString().padStart(4)}  n=${String(count).padStart(3)}${inRange ? ' *' : ''}`;
      }).join('\n');
      const pgNum = items[0]?.pageNum ?? '?';
      console.groupCollapsed(
        `DAJB columns | p${pgNum} | ${items.length} items | pageW=${Math.round(pageWidth)}pt | xRange=${Math.round(xMin)}–${Math.round(xMax)} | splitX=${splitX !== null ? Math.round(splitX) : 'none'}`
      );
      console.log('Histogram (* = in search range):');
      console.log(bucketCentres);
      if (bestBucket >= 0) {
        const minFlankDensity = Math.max(2, items.length / BUCKETS * 0.2);
        const gapX2 = xMin + (bestBucket + 0.5) * bucketWidth;
        const lc = items.filter(i => i.x <  gapX2).length;
        const rc = items.filter(i => i.x >= gapX2).length;
        console.log(
          `Best gap: b${bestBucket} centreX=${Math.round(gapX2)}  count=${bestCount}` +
          `  leftMax=${bestLeft}  rightMax=${bestRight}` +
          `  score=${bestLeft * bestRight}` +
          `  threshold=${(Math.min(bestLeft, bestRight) * 0.30).toFixed(1)}` +
          `  sides=${lc}L/${rc}R  minFlank=${minFlankDensity.toFixed(1)}`
        );
      }
      console.log(splitX !== null
        ? `✓ Columns detected (${splitReason}), splitX=${Math.round(splitX)}`
        : '✗ No column gap — Y-sorted single column');
      {
        const preview = [...items].sort((a, b) => {
          if (splitX !== null) {
            const aLeft = a.x < splitX; const bLeft = b.x < splitX;
            if (aLeft !== bLeft) return aLeft ? -1 : 1;
          }
          return b.y - a.y;
        }).slice(0, 30).map(i => `  x=${Math.round(i.x).toString().padStart(4)}  y=${Math.round(i.y).toString().padStart(4)}  ${i.text.slice(0, 60)}`);
        console.log('First 30 items in output order (x | y | text):');
        console.log(preview.join('\n'));
      }
      console.groupEnd();
    }

    const Y_TOL = 2; // pt — items within this Y range are on the same line

    const sortColumn = (col) => {
      col.sort((a, b) => b.y - a.y || a.x - b.x);
      const result = [];
      let line = [];
      for (const item of col) {
        if (!line.length || Math.abs(item.y - line[0].y) <= Y_TOL) {
          line.push(item);
        } else {
          line.sort((a, b) => a.x - b.x);
          result.push(...line);
          line = [item];
        }
      }
      if (line.length) { line.sort((a, b) => a.x - b.x); result.push(...line); }
      return result;
    };

    // No two-column gap: sort by Y (top-to-bottom) for consistent ordering.
    // Raw PDF item order is not guaranteed to match reading order, so we always
    // normalise rather than returning items as-is.
    if (splitX === null) return sortColumn([...items]);

    // ── Spanning-header detection ──────────────────────────────────────────
    // Scan Y-lines from the top of the page.  A contiguous run of Y-lines
    // that have items on BOTH sides of splitX are "spanning header" lines
    // (e.g. a page title on the left + hex code on the right).  These items
    // are kept in natural reading order (top-to-bottom, left-to-right) and
    // emitted BEFORE the column-split body.  Once a Y-line appears that has
    // items exclusively on one side, columns have begun and all subsequent
    // items are split left/right as usual.
    const sortedByY = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
    const hdrLines = [];
    let curHdrLine = [sortedByY[0]];
    for (let i = 1; i < sortedByY.length; i++) {
      if (Math.abs(sortedByY[i].y - curHdrLine[0].y) <= Y_TOL) {
        curHdrLine.push(sortedByY[i]);
      } else {
        hdrLines.push(curHdrLine);
        curHdrLine = [sortedByY[i]];
      }
    }
    if (curHdrLine.length) hdrLines.push(curHdrLine);

    let headerEndIdx = 0;
    for (let i = 0; i < hdrLines.length; i++) {
      const hasLeft  = hdrLines[i].some(item => item.x < splitX);
      const hasRight = hdrLines[i].some(item => item.x >= splitX);
      if (hasLeft && hasRight) {
        headerEndIdx = i + 1;
      } else {
        break; // first non-spanning Y-line → columns begin
      }
    }

    const headerItems = [];
    const columnItems = [];
    for (let i = 0; i < hdrLines.length; i++) {
      if (i < headerEndIdx) headerItems.push(...hdrLines[i]);
      else                  columnItems.push(...hdrLines[i]);
    }

    const sortedHeader = sortColumn(headerItems);

    const leftItems  = [];
    const rightItems = [];
    for (const item of columnItems) {
      if (item.x >= splitX) rightItems.push(item);
      else                  leftItems.push(item);
    }

    const finalLeft  = sortColumn(leftItems);
    const finalRight = sortColumn(rightItems);
    const finalOut   = [...sortedHeader, ...finalLeft, ...finalRight];

    if (PDFParser.debugColumns) {
      const fmt = arr => arr.slice(0, 15).map(i =>
        `  x=${Math.round(i.x).toString().padStart(4)}  y=${Math.round(i.y).toString().padStart(4)}  ${i.text.slice(0, 60)}`
      ).join('\n');
      console.groupCollapsed(`DAJB split detail | hdr=${sortedHeader.length} left=${finalLeft.length} right=${finalRight.length}`);
      if (sortedHeader.length) {
        console.log(`── HEADER (${sortedHeader.length} spanning items, ${headerEndIdx} Y-lines):`);
        console.log(fmt(sortedHeader));
      }
      console.log('── LEFT (first 15 in output order):');
      console.log(fmt(finalLeft));
      console.log('── RIGHT (first 15 in output order):');
      console.log(fmt(finalRight));
      console.log('── FINAL OUTPUT (first 30):');
      console.log(fmt(finalOut));
      console.groupEnd();
    }

    return finalOut;
  }

  /**
   * Filter an items array by font size bounds (null = no bound).
   * @param {Array<{text:string, fontSize:number}>} items
   * @param {number|null} minFontSize
   * @param {number|null} maxFontSize
   * @returns {Array<{text:string, fontSize:number, fontName:string}>}
   */
  static filterByFontSize(items, minFontSize, maxFontSize) {
    return items.filter((item) => {
      if (minFontSize != null && item.fontSize < minFontSize) return false;
      if (maxFontSize != null && item.fontSize > maxFontSize) return false;
      return true;
    });
  }

  /**
   * Filter items by all font criteria on a rule (size + name).
   * @param {Array} items
   * @param {Object} rule
   * @returns {Array}
   */
  static filterByCriteria(items, rule) {
    return items.filter((item) => {
      if (rule.fontSize != null) {
        const rounded = Math.round(item.fontSize * 2) / 2;
        if (rounded !== rule.fontSize) return false;
      }
      // Legacy min/max fields (from old saved rule files)
      if (rule.minFontSize != null && item.fontSize < rule.minFontSize) return false;
      if (rule.maxFontSize != null && item.fontSize > rule.maxFontSize) return false;
      if (rule.xMin != null && (item.xNorm ?? 0) * 100 < rule.xMin) return false;
      if (rule.xMax != null && (item.xNorm ?? 0) * 100 > rule.xMax) return false;
      return true;
    });
  }

  /**
   * Summarise items by (fontName, rounded fontSize), sorted by count descending.
   * Used by the Font Inspector to help users identify which font corresponds to their target text.
   * @param {Array} items
   * @returns {Array<{fontName:string, fontSize:number, count:number, sample:string}>}
   */
  static getFontSummary(items) {
    const map = new Map();
    for (const item of items) {
      const size = Math.round(item.fontSize * 2) / 2; // round to nearest 0.5 pt
      const key = `${item.fontName}||${size}`;
      if (!map.has(key)) {
        map.set(key, {
          fontName: item.fontName || '',
          fontSize: size,
          isBold:   item.isBold   ?? false,
          isItalic: item.isItalic ?? false,
          count: 0,
          sample: '',
        });
      }
      const entry = map.get(key);
      entry.count++;
      if (!entry.sample && item.text.trim()) entry.sample = item.text.trim().slice(0, 50);
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  }

  /**
   * Join an items array into a plain text string.
   */
  static itemsToText(items) {
    return items.map((i) => i.text).join(" ");
  }

  /**
   * Geometrically parse a flat items array into an HTML table.
   *
   * Algorithm:
   *  1. Sort items by descending Y, then ascending X (PDF Y=0 is bottom of page).
   *  2. Group into visual rows: items within `fontSize/2` pt of the current row Y.
   *  3. Detect column boundaries: collect all item X values, find gaps wider than
   *     `columnGapMinPt`, use gap midpoints as column dividers.
   *  4. Assign each item to a column by its X position.
   *  5. Merge continuation rows: a visual row whose leftmost item X is greater than
   *     the right edge of column 0 is treated as a wrapped continuation of the
   *     previous logical row rather than a new row.
   *  6. Emit <table> HTML with optional <thead> for the first row.
   *
   * @param {Array}  items
   * @param {object} [options]
   * @param {boolean} [options.firstRowHeader=true]
   * @param {number}  [options.columnGapMinPt=4]
   * @param {boolean} [options.preserveFormatting=false]
   * @returns {{ html: string, rowCount: number, colCount: number }}
   */
  static parseTableRegion(items, {
    firstRowHeader     = true,
    columnGapMinPt     = 4,
    columnGapMultiplier = 0,   // if > 0: gap must also be ≥ (median gap × multiplier)
    maxColumns         = 0,    // if > 0: keep only the N-1 largest gaps (caps column count)
    preserveFormatting = false,
    maxMarkerWidth     = 6,    // max chars of a valid row-number marker (mirrors detectTableBoundaries)
  } = {}) {
    if (!items?.length) return { html: '', rowCount: 0, colCount: 0 };

    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // 1. Sort by page first, then descending Y (top of page first), then ascending X
    const sorted = [...items].sort((a, b) =>
      (a.pageNum ?? 0) - (b.pageNum ?? 0) || b.y - a.y || a.x - b.x);

    // Median font size → row-grouping tolerance
    const sizes = sorted.map(i => i.fontSize).filter(Boolean).sort((a, b) => a - b);
    const medianSize = sizes[Math.floor(sizes.length / 2)] ?? 10;
    const rowTol = medianSize / 2;

    // 2. Group into visual rows
    const visualRows = [];
    let curRow = [], curY = null;
    for (const item of sorted) {
      if (curY === null || Math.abs(item.y - curY) <= rowTol) {
        if (curY === null) curY = item.y;
        curRow.push(item);
      } else {
        visualRows.push(curRow);
        curRow = [item];
        curY = item.y;
      }
    }
    if (curRow.length) visualRows.push(curRow);

    if (!visualRows.length) return { html: '', rowCount: 0, colCount: 1 };

    // 3. Detect column boundaries via X-gap analysis
    const allX = sorted.map(i => i.x).sort((a, b) => a - b);

    // Collect all candidate gaps above the absolute threshold
    const gapCandidates = [];
    for (let i = 1; i < allX.length; i++) {
      const size = allX[i] - allX[i - 1];
      if (size > columnGapMinPt) {
        gapCandidates.push({ mid: (allX[i] + allX[i - 1]) / 2, size });
      }
    }

    // Optional: relative threshold — gap must be ≥ median-gap × multiplier
    let filtered = gapCandidates;
    if (columnGapMultiplier > 0 && gapCandidates.length > 0) {
      const allSizes = [...gapCandidates].map(g => g.size).sort((a, b) => a - b);
      const medianGap = allSizes[Math.floor(allSizes.length / 2)];
      const relThresh = medianGap * columnGapMultiplier;
      filtered = gapCandidates.filter(g => g.size >= relThresh);
    }

    // Optional: cap column count — keep only the N−1 leftmost gaps.
    // Leftmost rather than largest because structural column boundaries
    // (e.g. number | description) are always left of any incidental whitespace
    // gaps that may appear within a wide description column.
    // filtered is already sorted left→right by mid, so just take the first N-1.
    if (maxColumns > 0 && filtered.length >= maxColumns) {
      filtered = filtered.slice(0, maxColumns - 1);
    }

    const colBoundaries = filtered.map(g => g.mid);
    const colCount = colBoundaries.length + 1;

    const colOf = (x) => {
      for (let c = 0; c < colBoundaries.length; c++) {
        if (x < colBoundaries[c]) return c;
      }
      return colBoundaries.length;
    };

    // Right edge of column 0 (used for continuation detection)
    const col0RightEdge = colBoundaries[0] ?? Infinity;

    // 4 & 5. Assign items to columns and merge continuation rows
    const debugPT = PDFParser.debugParseTable === true;
    if (debugPT) console.log('[DAJB parseTable] colBoundaries=[%s]  colCount=%d  col0RightEdge=%s  maxMarkerWidth=%d',
      colBoundaries.map(x => x.toFixed(0)).join(', '), colCount, col0RightEdge.toFixed(0), maxMarkerWidth);

    const logicalRows = []; // each entry: Array(colCount) of item[]
    for (const vrow of visualRows) {
      const colItems = Array.from({ length: colCount }, () => []);
      for (const item of vrow) colItems[colOf(item.x)].push(item);

      // Continuation check — two cases:
      // 1. Standard: nothing in the marker column, leftmost x is past col0's boundary.
      // 2. Wrapped: description text wrapped back to the marker column's x range,
      //    so col0 has items but they are long text (not a row-number marker) and col1
      //    is empty.  Append col0 items to the previous row's last column instead.
      const col0Text = colItems[0].map(i => i.text).join('').trim();
      const isStandardCont = logicalRows.length > 0 && vrow.length > 0 &&
        colItems[0].length === 0 && vrow[0].x > col0RightEdge;
      const isWrappedCont  = logicalRows.length > 0 &&
        colItems[0].length > 0 && colItems[1].length === 0 &&
        col0Text.length > maxMarkerWidth;

      if (debugPT) {
        const colSummary = colItems.map((ci, idx) =>
          `col${idx}=[${ci.map(i => `"${i.text.slice(0,15)}"`).join(',')}]`).join('  ');
        const cont = isStandardCont ? 'STANDARD-CONT' : isWrappedCont ? 'WRAPPED-CONT' : 'NEW-ROW';
        const why = !isStandardCont && !isWrappedCont
          ? `(col0Text="${col0Text.slice(0,20)}" len=${col0Text.length} vrow[0].x=${vrow[0]?.x.toFixed(0)} col0RightEdge=${col0RightEdge.toFixed(0)})`
          : '';
        console.log('  vrow[%d] → %s  %s  %s', logicalRows.length, cont, colSummary, why);
      }

      if (isStandardCont) {
        const prev = logicalRows[logicalRows.length - 1];
        for (let c = 1; c < colCount; c++) prev[c].push(...colItems[c]);
      } else if (isWrappedCont) {
        // Route the wrapped text into column 1 (or last column for 2-col tables)
        const prev = logicalRows[logicalRows.length - 1];
        prev[Math.min(1, colCount - 1)].push(...colItems[0]);
      } else {
        logicalRows.push(colItems);
      }
    }

    // 6. Render to HTML
    const renderCell = (cellItems) => {
      if (!cellItems.length) return '';
      return preserveFormatting
        ? PDFParser.itemsToHTML(cellItems)
        : esc(cellItems.map(i => i.text).join(' '));
    };

    const hasBody = logicalRows.length > (firstRowHeader ? 1 : 0);
    let html = '<table>\n';
    for (let r = 0; r < logicalRows.length; r++) {
      const isHeader = firstRowHeader && r === 0;
      const tag = isHeader ? 'th' : 'td';
      if (isHeader) html += '  <thead>\n';
      else if (r === 1 && firstRowHeader && hasBody) html += '  <tbody>\n';
      html += '    <tr>';
      for (let c = 0; c < colCount; c++) {
        html += `<${tag}>${renderCell(logicalRows[r][c])}</${tag}>`;
      }
      html += '</tr>\n';
      if (isHeader) html += '  </thead>\n';
    }
    if (hasBody) html += '  </tbody>\n';
    html += '</table>';

    return { html, rowCount: logicalRows.length, colCount };
  }

  /**
   * Geometrically detect numbered-table regions within a flat item array.
   *
   * A "table marker line" is a Y-line where:
   *   - At least one item-gap ≥ colGapPt exists between adjacent items (sorted by x)
   *   - The text to the LEFT of that gap is ≤ maxLeftWidth characters
   *     (catches row markers: "1", "d6", "10", "d12", "1,000" etc.)
   *
   * A table region is a contiguous run of lines that are either:
   *   - Marker lines, OR
   *   - Continuation lines whose leftmost item's x is within xTol of the
   *     table's running right-column x estimate (wrapping text of the current row)
   *
   * When a non-marker, non-continuation line is encountered the region ends.
   *
   * @param {Array<{text:string,x:number,y:number}>} items
   * @param {{yTol?:number, colGapPt?:number, maxLeftWidth?:number, minRows?:number, contXTol?:number}} opts
   * @returns {Array<Array>} - each element is the array of items belonging to one detected table
   */
  static detectTableBoundaries(items, {
    yTol         = 4,   // pt — items within this range share a Y-line
    colGapPt     = 12,  // pt — min gap between left marker and right content
    maxLeftWidth = 6,   // chars — max combined length of left-marker group
    minRows      = 2,   // minimum table-row (marker) lines required
    contXTol     = 15,  // pt — tolerance for continuation-line x matching
    zoneGapPt    = 80,  // pt — x-gap large enough to indicate a separate page column
    // Marker text must look like a number, dice roll, or Roman numeral.
    // Matches: 1, 01, 001, d6, d8, 10, 1,000, i, ii, iv, xi, etc.
    // This prevents page refs like "(p34)", stray commas, or abbreviations from
    // being treated as row markers and creating false table regions.
    markerPattern = /^(d?\d{1,4}([,./]\d+)*\.?|[ivxlc]{1,6}\.?)$/i,
  } = {}) {
    if (!items?.length) return [];

    const debug = PDFParser.debugDetect === true;

    // Sort by page first, then top-to-bottom (high Y first in PDF coords)
    const byY = [...items].sort((a, b) =>
      (a.pageNum ?? 0) - (b.pageNum ?? 0) || b.y - a.y || a.x - b.x);

    // Group into Y-lines
    const yLines = [];
    for (const item of byY) {
      const last = yLines[yLines.length - 1];
      if (!last || Math.abs(item.y - last[0].y) > yTol) yLines.push([item]);
      else last.push(item);
    }

    // Classify a single group of x-adjacent items as a table marker or other
    const classifyGroup = (group) => {
      const gsx = [...group].sort((a, b) => a.x - b.x);
      let gapIdx = -1;
      for (let i = 1; i < gsx.length; i++) {
        if (gsx[i].x - gsx[i - 1].x >= colGapPt) { gapIdx = i; break; }
      }
      const leftX = gsx[0].x;
      if (gapIdx < 0) return { items: group, type: 'other', leftX, rightX: null };
      const leftText = gsx.slice(0, gapIdx).map(t => t.text).join('').trim();
      const rightX   = gsx[gapIdx].x;
      return {
        items:   group,
        type:    leftText.length <= maxLeftWidth && markerPattern.test(leftText) ? 'marker' : 'other',
        leftX,
        rightX,
      };
    };

    // Classify each line — split into x-zones first so that a left-column prose
    // item sharing a Y with a right-column table marker doesn't hide the marker.
    const tagged = yLines.map(line => {
      const sx = [...line].sort((a, b) => a.x - b.x);

      // Split line into x-zones separated by large gaps (separate page columns)
      const zones = [[sx[0]]];
      for (let i = 1; i < sx.length; i++) {
        if (sx[i].x - sx[i - 1].x > zoneGapPt) zones.push([sx[i]]);
        else zones[zones.length - 1].push(sx[i]);
      }

      if (zones.length === 1) return classifyGroup(zones[0]);

      // Multiple zones: classify each zone; prefer marker over other for the
      // type / leftX / rightX metadata, but KEEP items from ALL zones.
      //
      // Why keep all items: inline styled runs (bold NPC names, italic references)
      // that appear at the far right of a description line (e.g. x=492 while the
      // description text starts at x=329) create a second x-zone on that y-line.
      // If we return only the winning zone's items, the description text at x=329
      // is silently dropped and reappears as orphan prose below the table.
      const zoneResults = zones.map(classifyGroup);
      const markerZone  = zoneResults.find(z => z.type === 'marker');
      const winner      = markerZone ?? zoneResults[zoneResults.length - 1];
      return { ...winner, items: zoneResults.flatMap(z => z.items) };
    });

    if (debug) {
      console.log('[DAJB detectTable] items=%d  yLines=%d  colGapPt=%d  maxLeftWidth=%d  contXTol=%d  minRows=%d',
        items.length, yLines.length, colGapPt, maxLeftWidth, contXTol, minRows);
      tagged.forEach((t, i) => {
        const preview = t.items.map(it => it.text).join(' ').slice(0, 70);
        const rx = t.rightX != null ? t.rightX.toFixed(0) : 'null';
        console.log('  line[%d] %s  leftX=%s  rightX=%s  | %s',
          i, t.type.toUpperCase().padEnd(6), t.leftX.toFixed(0), rx, preview);
      });
    }

    // Walk lines, accumulate table regions
    const regions = [];
    let blockStart      = null;
    let rightColX       = null;  // running estimate of right-column x
    let leftColX        = null;  // running estimate of left (marker) column x
    let rightColSamples = 0;
    let leftColSamples  = 0;

    const flush = (endIdx) => {
      const slice = tagged.slice(blockStart, endIdx);
      const markerCount = slice.filter(l => l.type === 'marker').length;
      const saved = markerCount >= minRows;
      if (debug) console.log('  → FLUSH lines[%d..%d]  markers=%d  saved=%s', blockStart, endIdx - 1, markerCount, saved);
      if (saved) regions.push(slice.flatMap(l => l.items));
      blockStart = null; rightColX = null; leftColX = null;
      rightColSamples = 0; leftColSamples = 0;
    };

    for (let i = 0; i < tagged.length; i++) {
      const { type, rightX, leftX } = tagged[i];

      if (type === 'marker') {
        if (blockStart === null) blockStart = i;
        // Update right-column x estimate (running average)
        if (rightX !== null) {
          rightColX = rightColSamples === 0 ? rightX
            : (rightColX * rightColSamples + rightX) / (rightColSamples + 1);
          rightColSamples++;
        }
        // Update left-column x estimate (running average)
        leftColX = leftColSamples === 0 ? leftX
          : (leftColX * leftColSamples + leftX) / (leftColSamples + 1);
        leftColSamples++;
        if (debug) console.log('    ↳ block active  leftColX=%s  rightColX=%s',
          leftColX.toFixed(0), rightColX?.toFixed(0) ?? 'null');
      } else if (blockStart !== null) {
        // A non-marker line is a continuation if its leftmost x falls anywhere
        // within the table's horizontal span (leftColX … rightColX ± contXTol).
        // This handles description text that wraps back to the row-number column's
        // x position (which can be 15–30 pt left of rightColX, beyond the old check).
        const textLen = tagged[i].items.map(t => t.text).join('').trim().length;
        const inSpan = rightColX !== null && leftColX !== null &&
                       leftX >= leftColX - contXTol &&
                       leftX <= rightColX + contXTol &&
                       textLen > maxLeftWidth;
        const nearRight = rightColX !== null && Math.abs(leftX - rightColX) <= contXTol;
        // Items whose leftX is far to the RIGHT of rightColX are inline styled
        // text (italic NPC names, bold references, closing parens) that happen to
        // appear at the end of a description line.  They are part of the description
        // and must not terminate the block.
        const isOutOfBand = rightColX !== null && leftX > rightColX + 50;
        const isContinuation = inSpan || nearRight || isOutOfBand;
        if (debug) {
          const why = isContinuation
            ? (nearRight ? `nearRight(|${leftX.toFixed(0)}-${rightColX.toFixed(0)}|=${Math.abs(leftX-rightColX).toFixed(0)}≤${contXTol})` : `inSpan(textLen=${textLen})`)
            : `FAIL nearRight=|${leftX.toFixed(0)}-${(rightColX??0).toFixed(0)}|=${Math.abs(leftX-(rightColX??0)).toFixed(0)}>${contXTol} inSpan=textLen${textLen}${textLen>maxLeftWidth?'>':'≤'}${maxLeftWidth}`;
          console.log('    ↳ cont=%s  leftX=%s  leftColX=%s  rightColX=%s  textLen=%d  %s',
            isContinuation, leftX.toFixed(0), leftColX?.toFixed(0)??'null', rightColX?.toFixed(0)??'null', textLen, why);
        }
        if (!isContinuation) {
          flush(i);
          // Don't increment i — re-evaluate this line as potential new block start
          i--;
        }
        // If continuation: just let it accumulate in the current block (no action needed)
      }
    }
    if (blockStart !== null) flush(tagged.length);

    return regions;
  }

  /**
   * Detect where paragraph breaks should be inserted in a (possibly
   * column-reordered) items array.
   *
   * Two independent signals are supported and can be combined:
   *   "spacing"  — Y gap between consecutive lines exceeds gapThreshold × the
   *                median within-paragraph leading.  A Y-increase between
   *                consecutive items signals a column boundary and is skipped.
   *   "indent"   — The first item of a new line starts to the right of the
   *                modal left-margin X by more than indentMinPt points.
   *
   * @param {Array}  items        — item array, already in reading order
   * @param {object} [options]
   * @param {string}  [options.mode="spacing"]  "spacing" | "indent" | "both"
   * @param {number}  [options.gapThreshold=1.4] multiplier on median leading
   * @param {number}  [options.indentMinPt=6]   minimum indent in pt
   * @returns {Set<number>}  set of item indices that begin a new paragraph
   */
  static detectParagraphBreaks(items, { mode = 'spacing', gapThreshold = 1.4, indentMinPt = 6 } = {}) {
    if (items.length < 2) return new Set();

    const useSpacing = mode === 'spacing' || mode === 'both';
    const useIndent  = mode === 'indent'  || mode === 'both';

    // ── Group items into visual Y-lines ──────────────────────────────────────
    // Y_TOL: use smallest fontSize found, capped to a sensible range
    const sizes = items.map(i => i.fontSize).filter(Boolean);
    const minSize = sizes.length ? Math.min(...sizes) : 10;
    const yTol = Math.max(1, Math.min(minSize / 2, 4));

    const lines = []; // [{y, firstX, items:[]}]
    let cur = null;
    for (const item of items) {
      if (!cur || Math.abs(item.y - cur.y) > yTol) {
        cur = { y: item.y, firstX: item.x, items: [item] };
        lines.push(cur);
      } else {
        cur.items.push(item);
        if (item.x < cur.firstX) cur.firstX = item.x;
      }
    }

    // ── Spacing: compute median within-paragraph leading ─────────────────────
    let medianLeading = 0;
    if (useSpacing && lines.length > 1) {
      const gaps = [];
      for (let i = 1; i < lines.length; i++) {
        const dy = lines[i - 1].y - lines[i].y; // positive = Y decreased (normal)
        if (dy > 0) gaps.push(dy);
      }
      if (gaps.length) {
        gaps.sort((a, b) => a - b);
        // Lower 60 % excludes paragraph gaps (which are the larger values)
        const lower = gaps.slice(0, Math.ceil(gaps.length * 0.6));
        medianLeading = lower[Math.floor(lower.length / 2)] ?? gaps[0];
      }
    }

    // ── Indent: compute modal left-margin X ──────────────────────────────────
    let modalMarginX = 0;
    if (useIndent && lines.length) {
      const xBuckets = new Map();
      for (const ln of lines) {
        const bucket = Math.round(ln.firstX / 2) * 2; // 2 pt bins
        xBuckets.set(bucket, (xBuckets.get(bucket) ?? 0) + 1);
      }
      modalMarginX = [...xBuckets.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
    }

    // ── Mark break indices ────────────────────────────────────────────────────
    const breaks = new Set();
    let itemIdx = 0;
    for (let i = 1; i < lines.length; i++) {
      itemIdx += lines[i - 1].items.length;
      const dy = lines[i - 1].y - lines[i].y;

      if (dy <= 0) continue; // Y increased = column transition, never a paragraph break

      const spacingBreak = useSpacing && medianLeading > 0 && dy > medianLeading * gapThreshold;
      const indentBreak  = useIndent  && lines[i].firstX > modalMarginX + indentMinPt;

      if (spacingBreak || indentBreak) breaks.add(itemIdx);
    }
    return breaks;
  }

  /**
   * Render items as HTML with paragraph structure inferred from geometry.
   * Returns one or more <p>…</p> blocks.
   *
   * @param {Array}  items
   * @param {object} [options]
   * @param {string}  [options.mode]              passed to detectParagraphBreaks
   * @param {number}  [options.gapThreshold]      passed to detectParagraphBreaks
   * @param {number}  [options.indentMinPt]       passed to detectParagraphBreaks
   * @param {boolean} [options.preserveFormatting=false] use itemsToHTML vs plain text
   * @returns {string}
   */
  static itemsToParagraphedHTML(items, options = {}) {
    if (!items?.length) return '';
    const { preserveFormatting = false, ...breakOpts } = options;
    const breaks = PDFParser.detectParagraphBreaks(items, breakOpts);

    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const renderGroup = (grp) => preserveFormatting
      ? PDFParser.itemsToHTML(grp)
      : esc(grp.map(i => i.text).join(' '));

    const paragraphs = [];
    let cur = [];
    for (let i = 0; i < items.length; i++) {
      if (breaks.has(i) && cur.length) { paragraphs.push(cur); cur = []; }
      cur.push(items[i]);
    }
    if (cur.length) paragraphs.push(cur);

    return paragraphs.map(p => `<p>${renderGroup(p)}</p>`).join('');
  }

  /**
   * Render an items array as HTML, wrapping consecutive runs of bold/italic items
   * in <strong> and/or <em> tags.  Underline is not detectable from PDF text items.
   * @param {Array} items
   * @returns {string}
   */
  static itemsToHTML(items) {
    if (!items?.length) return '';
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Group consecutive items that share the same bold/italic state
    const groups = [];
    for (const item of items) {
      const b = item.isBold   ?? false;
      const i = item.isItalic ?? false;
      const last = groups[groups.length - 1];
      if (last && last.b === b && last.i === i) {
        last.parts.push(item.text);
      } else {
        groups.push({ b, i, parts: [item.text] });
      }
    }

    return groups.map(g => {
      const text = esc(g.parts.join(' '));
      if (g.b && g.i) return `<strong><em>${text}</em></strong>`;
      if (g.b)        return `<strong>${text}</strong>`;
      if (g.i)        return `<em>${text}</em>`;
      return text;
    }).join(' ');
  }
}
