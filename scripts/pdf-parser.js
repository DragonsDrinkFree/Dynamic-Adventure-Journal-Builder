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
  }

  get totalPages() {
    return this._totalPages;
  }

  /**
   * Load a File object as a PDF.
   * @param {File} file
   */
  async loadPDF(file) {
    const pdfjsLib = await getPdfjsLib();

    const arrayBuffer = await file.arrayBuffer();
    const typedArray = new Uint8Array(arrayBuffer);

    this._doc = await pdfjsLib.getDocument({ data: typedArray }).promise;
    this._totalPages = this._doc.numPages;
    this._cache.clear();
    this._itemCache.clear();
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
    const content = await page.getTextContent();
    const items = content.items
      .filter((item) => item.str && item.str.trim())
      .map((item) => ({
        text: item.str,
        fontSize: Math.abs(item.transform?.[3] ?? 0),
        fontName: item.fontName ?? "",
        color: PDFParser._colorToHex(item.color),
      }));
    this._itemCache.set(pageNum, items);
    return items;
  }

  /**
   * Return all structured text items across a set of page ranges.
   * @param {Array<{start:number, end:number}>} ranges
   * @returns {Promise<Array<{text:string, fontSize:number, fontName:string}>>}
   */
  async getPagesItems(ranges) {
    if (!this._doc) throw new Error("No PDF loaded");
    const all = [];
    for (const { start, end } of ranges) {
      for (let p = start; p <= Math.min(end, this._totalPages); p++) {
        all.push(...(await this.getPageItems(p)));
      }
    }
    return all;
  }

  /**
   * Convert a PDF.js color array [r, g, b] (0–255) to a lowercase hex string.
   * Returns "#000000" if color data is unavailable (older PDF.js builds).
   * @param {Array|Uint8ClampedArray|undefined} color
   * @returns {string}
   */
  static _colorToHex(color) {
    if (!color || color.length < 3) return "#000000";
    return "#" + Array.from(color).slice(0, 3)
      .map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0"))
      .join("");
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
      if (rule.minFontSize != null && item.fontSize < rule.minFontSize) return false;
      if (rule.maxFontSize != null && item.fontSize > rule.maxFontSize) return false;
      if (rule.fontNameContains &&
          !item.fontName?.toLowerCase().includes(rule.fontNameContains.toLowerCase())) return false;
      if (rule.fontColor && item.color !== rule.fontColor.toLowerCase()) return false;
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
        map.set(key, { fontName: item.fontName || '', fontSize: size, color: item.color ?? '#000000', count: 0, sample: '' });
      }
      const entry = map.get(key);
      entry.count++;
      if (!entry.sample && item.text.trim()) entry.sample = item.text.trim().slice(0, 50);
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  }

  /**
   * Join an items array into a plain text string.
   * @param {Array<{text:string}>} items
   * @returns {string}
   */
  static itemsToText(items) {
    return items.map((i) => i.text).join(" ");
  }
}
