/**
 * Injected into the page by Playwright.
 * Walks the DOM and returns a tree of FigmaLayer objects
 * with resolved computed styles and bounding boxes.
 */
export async function captureScript() {
  // This function runs INSIDE the browser via page.evaluate()
  const IGNORE_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'HEAD', 'TEMPLATE']);

  function rgba(r, g, b, a = 1) {
    return { r: r / 255, g: g / 255, b: b / 255, a };
  }

  function parseColor(str) {
    if (!str || str === 'transparent' || str === 'rgba(0, 0, 0, 0)') return null;
    const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (!m) return null;
    return rgba(+m[1], +m[2], +m[3], m[4] !== undefined ? +m[4] : 1);
  }

  function parsePx(val) {
    return parseFloat(val) || 0;
  }

  function parseBoxShadow(str) {
    if (!str || str === 'none') return [];
    // Basic: "x y blur spread color inset"
    const shadows = [];
    const regex = /(-?\d+(?:\.\d+)?px)\s+(-?\d+(?:\.\d+)?px)\s+(-?\d+(?:\.\d+)?px)(?:\s+(-?\d+(?:\.\d+)?px))?\s+(rgba?\([^)]+\)|#\w+|\w+)(\s+inset)?/g;
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

  function parseGradient(str) {
    // Very simplified - just detect type
    if (str.startsWith('linear-gradient')) return { type: 'linear', raw: str };
    if (str.startsWith('radial-gradient')) return { type: 'radial', raw: str };
    return null;
  }

  function parseBorderRadius(cs) {
    return {
      tl: parsePx(cs.borderTopLeftRadius),
      tr: parsePx(cs.borderTopRightRadius),
      br: parsePx(cs.borderBottomRightRadius),
      bl: parsePx(cs.borderBottomLeftRadius),
    };
  }

  function getImageSrc(el) {
    if (el.tagName === 'IMG') return el.currentSrc || el.src || null;
    return null;
  }

  function getBackgroundImageUrl(cs) {
    const bg = cs.backgroundImage;
    if (!bg || bg === 'none') return null;
    const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
    return m ? m[1] : null;
  }

  function extractFills(el, cs) {
    const fills = [];
    const bgColor = parseColor(cs.backgroundColor);
    if (bgColor && bgColor.a > 0) {
      fills.push({ type: 'SOLID', color: bgColor });
    }

    const bgImage = cs.backgroundImage;
    if (bgImage && bgImage !== 'none') {
      if (bgImage.includes('gradient')) {
        const g = parseGradient(bgImage);
        if (g) fills.push({ type: 'GRADIENT', gradient: g });
      } else {
        const url = getBackgroundImageUrl(cs);
        if (url) fills.push({ type: 'IMAGE', url });
      }
    }

    if (el.tagName === 'IMG') {
      const src = getImageSrc(el);
      if (src) fills.push({ type: 'IMAGE', url: src });
    }

    return fills;
  }

  function extractStrokes(cs) {
    const strokes = [];
    const sides = ['Top', 'Right', 'Bottom', 'Left'];
    for (const side of sides) {
      const w = parsePx(cs[`border${side}Width`]);
      const color = parseColor(cs[`border${side}Color`]);
      if (w > 0 && color) {
        strokes.push({ side: side.toLowerCase(), width: w, color });
        break; // Figma doesn't support per-side strokes well; use first non-zero
      }
    }
    return strokes;
  }

  function isSvg(el) {
    return el instanceof SVGElement;
  }

  function nodeType(el, cs) {
    if (isSvg(el)) return 'SVG';
    if (el.tagName === 'IMG') return 'IMAGE';
    const tag = el.tagName;
    if (['P', 'SPAN', 'A', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LABEL', 'BUTTON', 'LI'].includes(tag)) {
      if (el.childElementCount === 0 && el.textContent.trim()) return 'TEXT';
    }
    return 'FRAME';
  }

  function extractText(el, cs) {
    return {
      content: el.textContent.trim(),
      fontSize: parsePx(cs.fontSize),
      fontFamily: cs.fontFamily.split(',')[0].replace(/['"]/g, '').trim(),
      fontWeight: cs.fontWeight,
      lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing,
      textAlign: cs.textAlign,
      color: parseColor(cs.color),
      textDecoration: cs.textDecoration,
    };
  }

  function extractAutoLayout(cs) {
    if (cs.display !== 'flex') return null;
    return {
      direction: cs.flexDirection.startsWith('row') ? 'HORIZONTAL' : 'VERTICAL',
      gap: parsePx(cs.gap || cs.rowGap || '0'),
      paddingTop: parsePx(cs.paddingTop),
      paddingRight: parsePx(cs.paddingRight),
      paddingBottom: parsePx(cs.paddingBottom),
      paddingLeft: parsePx(cs.paddingLeft),
      alignItems: cs.alignItems,
      justifyContent: cs.justifyContent,
      wrap: cs.flexWrap !== 'nowrap',
    };
  }

  function walkNode(el, parentRect) {
    if (IGNORE_TAGS.has(el.tagName)) return null;

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;

    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return null;

    const type = nodeType(el, cs);
    const layer = {
      type,
      tagName: el.tagName,
      x: rect.left - (parentRect ? parentRect.left : 0),
      y: rect.top - (parentRect ? parentRect.top : 0),
      width: rect.width,
      height: rect.height,
      opacity: parseFloat(cs.opacity) || 1,
      overflow: cs.overflow === 'hidden' || cs.overflowX === 'hidden' || cs.overflowY === 'hidden',
      borderRadius: parseBorderRadius(cs),
      fills: extractFills(el, cs),
      strokes: extractStrokes(cs),
      effects: parseBoxShadow(cs.boxShadow),
      autoLayout: extractAutoLayout(cs),
      children: [],
    };

    if (type === 'TEXT') {
      layer.text = extractText(el, cs);
    }

    if (type === 'SVG') {
      layer.svgContent = new XMLSerializer().serializeToString(el);
    }

    if (type === 'FRAME' || type === 'IMAGE') {
      for (const child of el.children) {
        const childLayer = walkNode(child, rect);
        if (childLayer) layer.children.push(childLayer);
      }
    }

    return layer;
  }

  // Start from body
  const body = document.body;
  const bodyRect = body.getBoundingClientRect();
  const root = {
    type: 'FRAME',
    tagName: 'BODY',
    x: 0,
    y: 0,
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    fills: [{ type: 'SOLID', color: parseColor(getComputedStyle(body).backgroundColor) || { r: 1, g: 1, b: 1, a: 1 } }],
    strokes: [],
    effects: [],
    borderRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
    opacity: 1,
    overflow: false,
    autoLayout: null,
    children: [],
  };

  for (const child of body.children) {
    const layer = walkNode(child, bodyRect);
    if (layer) root.children.push(layer);
  }

  return root;
}
