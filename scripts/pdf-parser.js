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
    this._pdfjsLib = pdfjsLib; // retain for OPS constant access in _extractColorSequence

    const arrayBuffer = await file.arrayBuffer();
    const typedArray = new Uint8Array(arrayBuffer);

    this._doc = await pdfjsLib.getDocument({ data: typedArray }).promise;
    this._totalPages = this._doc.numPages;
    this._cache.clear();
    this._itemCache.clear();
    this._pageWidths.clear();
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

    const [content, opList] = await Promise.all([
      page.getTextContent(),
      page.getOperatorList().catch(() => null),
    ]);

    // Extract per-show-text fill color from the operator list.
    // Each entry in colorSeq corresponds to one showText-type op (in order).
    const colorSeq = opList ? PDFParser._extractColorSequence(opList, this._pdfjsLib) : [];

    // content.items may include whitespace-only entries that have no matching
    // showText op (PDF.js can synthesise them).  Assign colors by walking both
    // arrays in tandem: only advance the color index for items that actually
    // map to a showText op (i.e. non-empty strings).
    let colorIdx = 0;
    const items = content.items
      .map((item) => {
        const fontName = item.fontName ?? "";
        const fn = fontName.toLowerCase();
        const hasText = typeof item.str === 'string' && item.str.trim();
        const color = hasText ? (colorSeq[colorIdx++] ?? '#000000') : '#000000';
        const rawX = item.transform?.[4] ?? 0;
        return { _keep: !!hasText, text: item.str, fontSize: Math.abs(item.transform?.[3] ?? 0),
          fontName, color,
          x: rawX,
          y: item.transform?.[5] ?? 0,
          width: item.width ?? 0,
          xNorm: viewport.width > 0 ? rawX / viewport.width : 0,
          isBold:   /bold|heavy|black|demi|semibold|extrabold|ultrabold/.test(fn),
          isItalic: /italic|oblique|slanted|inclined/.test(fn),
        };
      })
      .filter(item => item._keep)
      .map(({ _keep, ...rest }) => rest);

    this._itemCache.set(pageNum, items);
    return items;
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
   * @param {{ columnAware?: boolean }} [options]
   * @returns {Promise<Array<{text:string, fontSize:number, fontName:string, x:number, y:number}>>}
   */
  async getPagesItems(ranges, { columnAware = false } = {}) {
    if (!this._doc) throw new Error("No PDF loaded");
    const all = [];
    for (const { start, end } of ranges) {
      for (let p = start; p <= Math.min(end, this._totalPages); p++) {
        const pageItems = await this.getPageItems(p);
        if (columnAware) {
          all.push(...PDFParser.reorderForColumns(pageItems, this.getPageWidth(p)));
        } else {
          all.push(...pageItems);
        }
      }
    }
    return all;
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

    const avgDensity = items.length / BUCKETS;
    const gapThreshold = avgDensity * 0.20;

    // Look for a gap bucket whose centre falls in the middle 20–80 % of page width
    let splitX = null;
    for (let b = 0; b < BUCKETS; b++) {
      const bucketCentreX = xMin + (b + 0.5) * bucketWidth;
      if (bucketCentreX < pageWidth * 0.20 || bucketCentreX > pageWidth * 0.80) continue;
      if (hist[b] < gapThreshold) { splitX = bucketCentreX; break; }
    }

    if (splitX === null) return items; // no column gap detected

    const sortColumn = (col) => {
      const Y_TOL = 2; // pt — items within this Y range are on the same line
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

    return [
      ...sortColumn(items.filter(i => i.x <  splitX)),
      ...sortColumn(items.filter(i => i.x >= splitX)),
    ];
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
      if (rule.fontNameContains &&
          !item.fontName?.toLowerCase().includes(rule.fontNameContains.toLowerCase())) return false;
      if (rule.fontColor && item.color !== rule.fontColor.toLowerCase()) return false;
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
      const key = `${item.fontName}||${size}||${item.color ?? '#000000'}`;
      if (!map.has(key)) {
        map.set(key, {
          fontName: item.fontName || '',
          fontSize: size,
          color: item.color ?? '#000000',
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
    firstRowHeader  = true,
    columnGapMinPt  = 4,
    preserveFormatting = false,
  } = {}) {
    if (!items?.length) return { html: '', rowCount: 0, colCount: 0 };

    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // 1. Sort descending Y (top of page first), then ascending X
    const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);

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
    const colBoundaries = []; // x values that divide columns
    for (let i = 1; i < allX.length; i++) {
      if (allX[i] - allX[i - 1] > columnGapMinPt) {
        colBoundaries.push((allX[i] + allX[i - 1]) / 2);
      }
    }
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
    const logicalRows = []; // each entry: Array(colCount) of item[]
    for (const vrow of visualRows) {
      const colItems = Array.from({ length: colCount }, () => []);
      for (const item of vrow) colItems[colOf(item.x)].push(item);

      // Continuation: no items in col 0 and leftmost item is right of col0's boundary
      const isContinuation =
        logicalRows.length > 0 &&
        colItems[0].length === 0 &&
        vrow.length > 0 &&
        vrow[0].x > col0RightEdge;

      if (isContinuation) {
        const prev = logicalRows[logicalRows.length - 1];
        for (let c = 1; c < colCount; c++) {
          prev[c].push(...colItems[c]);
        }
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

    let html = '<table>\n';
    for (let r = 0; r < logicalRows.length; r++) {
      const isHeader = firstRowHeader && r === 0;
      const tag = isHeader ? 'th' : 'td';
      if (isHeader) html += '  <thead>\n';
      else if (r === 1 && firstRowHeader) html += '  <tbody>\n';
      html += '    <tr>';
      for (let c = 0; c < colCount; c++) {
        html += `<${tag}>${renderCell(logicalRows[r][c])}</${tag}>`;
      }
      html += '</tr>\n';
      if (isHeader) html += '  </thead>\n';
    }
    if (logicalRows.length > (firstRowHeader ? 1 : 0)) html += '  </tbody>\n';
    html += '</table>';

    return { html, rowCount: logicalRows.length, colCount };
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
