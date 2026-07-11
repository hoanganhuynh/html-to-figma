/**
 * Injected into the page by Playwright.
 * Walks the DOM and returns a tree of FigmaLayer objects
 * with resolved computed styles and bounding boxes.
 */
export async function captureScript() {
  const IGNORE_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'HEAD', 'TEMPLATE', 'IFRAME']);

  // ─── Color helpers ───────────────────────────────────────────────────────────

  function rgba(r, g, b, a = 1) {
    return { r: r / 255, g: g / 255, b: b / 255, a };
  }

  function parseColor(str) {
    if (!str || str === 'transparent' || str === 'rgba(0, 0, 0, 0)') return null;
    const m = str.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/);
    if (!m) return null;
    const a = m[4] !== undefined ? +m[4] : 1;
    if (a === 0) return null;
    return rgba(+m[1], +m[2], +m[3], a);
  }

  function parsePx(val) {
    return parseFloat(val) || 0;
  }

  // ─── Box shadow ──────────────────────────────────────────────────────────────

  function parseBoxShadow(str) {
    if (!str || str === 'none') return [];
    const shadows = [];
    const regex = /(-?\d+(?:\.\d+)?px)\s+(-?\d+(?:\.\d+)?px)\s+(-?\d+(?:\.\d+)?px)(?:\s+(-?\d+(?:\.\d+)?px))?\s+(rgba?\([^)]+\))(\s+inset)?/g;
    let m;
    while ((m = regex.exec(str)) !== null) {
      const color = parseColor(m[5]);
      if (!color) continue;
      shadows.push({
        type: m[6] ? 'innerShadow' : 'dropShadow',
        x: parsePx(m[1]),
        y: parsePx(m[2]),
        blur: parsePx(m[3]),
        spread: parsePx(m[4] || '0px'),
        color,
        visible: true,
      });
    }
    return shadows;
  }

  // ─── Border radius ───────────────────────────────────────────────────────────

  function parseBorderRadius(cs) {
    return {
      tl: parsePx(cs.borderTopLeftRadius),
      tr: parsePx(cs.borderTopRightRadius),
      br: parsePx(cs.borderBottomRightRadius),
      bl: parsePx(cs.borderBottomLeftRadius),
    };
  }

  // ─── Fills ───────────────────────────────────────────────────────────────────

  function getBackgroundImageUrl(cs) {
    const bg = cs.backgroundImage;
    if (!bg || bg === 'none') return null;
    if (bg.includes('gradient')) return null;
    const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
    return m ? m[1] : null;
  }

  function parseLinearGradient(str) {
    // Extract angle and stops from linear-gradient(...)
    // Simplified: capture raw for now
    return { type: 'LINEAR', raw: str };
  }

  function extractFills(el, cs) {
    const fills = [];
    const bgColor = parseColor(cs.backgroundColor);
    if (bgColor) fills.push({ type: 'SOLID', color: bgColor });

    const bgImage = cs.backgroundImage;
    if (bgImage && bgImage !== 'none') {
      if (bgImage.includes('gradient')) {
        fills.push({ type: 'GRADIENT', gradient: parseLinearGradient(bgImage) });
      } else {
        const url = getBackgroundImageUrl(cs);
        if (url) fills.push({ type: 'IMAGE', url });
      }
    }

    if (el.tagName === 'IMG') {
      const src = el.currentSrc || el.src || el.getAttribute('src');
      if (src) fills.push({ type: 'IMAGE', url: src });
    }

    return fills;
  }

  // ─── Strokes ─────────────────────────────────────────────────────────────────

  function extractStrokes(cs) {
    const strokes = [];
    const sides = ['Top', 'Right', 'Bottom', 'Left'];
    for (const side of sides) {
      const w = parsePx(cs[`border${side}Width`]);
      const color = parseColor(cs[`border${side}Color`]);
      if (w > 0 && color) {
        strokes.push({ side: side.toLowerCase(), width: w, color });
        break;
      }
    }
    return strokes;
  }

  // ─── Node type detection ─────────────────────────────────────────────────────

  function isSvgEl(el) {
    return el instanceof SVGElement;
  }

  /**
   * Determine the Figma node type for an element.
   * Key rule: any leaf element (no child elements) with non-empty text → TEXT.
   * This catches div, span, p, h1-h6, button, td, li, etc.
   */
  function nodeType(el) {
    if (isSvgEl(el)) return 'SVG';
    if (el.tagName === 'IMG') return 'IMAGE';
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return 'INPUT';
    // Leaf element with visible text → TEXT node in Figma
    if (el.childElementCount === 0) {
      const text = el.textContent.trim();
      if (text) return 'TEXT';
    }
    return 'FRAME';
  }

  // ─── Text info ───────────────────────────────────────────────────────────────

  function extractText(el, cs) {
    // For input elements, get the value or placeholder
    let content = el.tagName === 'INPUT'
      ? (el.value || el.placeholder || '')
      : el.textContent.trim();

    return {
      content,
      fontSize: parsePx(cs.fontSize),
      fontFamily: cs.fontFamily.split(',')[0].replace(/['"]/g, '').trim(),
      fontWeight: cs.fontWeight,
      fontStyle: cs.fontStyle,          // 'italic' | 'normal'
      lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing,
      textAlign: cs.textAlign,
      color: parseColor(cs.color),
      textDecoration: cs.textDecoration,
      textTransform: cs.textTransform,
    };
  }

  // ─── Walk DOM ────────────────────────────────────────────────────────────────

  function walkNode(el, parentRect) {
    if (IGNORE_TAGS.has(el.tagName)) return null;

    const rect = el.getBoundingClientRect();
    // Skip truly invisible elements (both dimensions zero)
    if (rect.width === 0 && rect.height === 0) return null;

    const cs = window.getComputedStyle(el);
    if (cs.display === 'none') return null;
    if (cs.visibility === 'hidden' && el.childElementCount === 0) return null;

    const type = nodeType(el);

    const layer = {
      type,
      tagName: el.tagName,
      name: el.id ? `#${el.id}` : (el.className && typeof el.className === 'string' ? el.className.split(' ')[0] : el.tagName.toLowerCase()),
      // Position relative to parent's top-left corner
      x: Math.round(rect.left - (parentRect ? parentRect.left : 0)),
      y: Math.round(rect.top - (parentRect ? parentRect.top : 0)),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      opacity: parseFloat(cs.opacity) ?? 1,
      overflow: cs.overflow === 'hidden' || cs.overflowX === 'hidden' || cs.overflowY === 'hidden',
      borderRadius: parseBorderRadius(cs),
      fills: extractFills(el, cs),
      strokes: extractStrokes(cs),
      effects: parseBoxShadow(cs.boxShadow),
      children: [],
    };

    if (type === 'TEXT' || type === 'INPUT') {
      layer.text = extractText(el, cs);
    }

    if (type === 'SVG') {
      try {
        layer.svgContent = new XMLSerializer().serializeToString(el);
      } catch {}
    }

    // Recurse into children for container elements
    if (type === 'FRAME') {
      for (const child of el.children) {
        const childLayer = walkNode(child, rect);
        if (childLayer) layer.children.push(childLayer);
      }
    }

    return layer;
  }

  // ─── Build root ──────────────────────────────────────────────────────────────

  // Scroll to top before capturing to get consistent positions
  window.scrollTo(0, 0);

  const body = document.body;
  const bodyRect = body.getBoundingClientRect();
  const bgColor = parseColor(getComputedStyle(body).backgroundColor)
    || parseColor(getComputedStyle(document.documentElement).backgroundColor)
    || { r: 1, g: 1, b: 1, a: 1 };

  const root = {
    type: 'FRAME',
    tagName: 'BODY',
    name: 'Page',
    x: 0,
    y: 0,
    width: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    fills: [{ type: 'SOLID', color: bgColor }],
    strokes: [],
    effects: [],
    borderRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
    opacity: 1,
    overflow: false,
    children: [],
  };

  for (const child of body.children) {
    const layer = walkNode(child, bodyRect);
    if (layer) root.children.push(layer);
  }

  return root;
}
