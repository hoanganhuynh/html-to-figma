/**
 * Injected into the page by Playwright.
 * Walks the DOM and returns a tree of FigmaLayer objects
 * with resolved computed styles and bounding boxes.
 */
export async function captureScript() {

  // Tags to skip entirely
  const IGNORE_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'HEAD',
    'TEMPLATE', 'IFRAME', 'BR', 'WBR', 'HR',
  ]);

  // Inline elements AND line-break elements — when ALL element children are in this
  // set, treat the parent as a single TEXT node to preserve text continuity across
  // mixed content like: "Hello <br> <span>world</span> foo".
  const INLINE_TAGS = new Set([
    'SPAN', 'A', 'EM', 'STRONG', 'B', 'I', 'U', 'S',
    'CODE', 'KBD', 'SAMP', 'VAR', 'CITE', 'DFN', 'ABBR',
    'SMALL', 'SUB', 'SUP', 'MARK', 'DEL', 'INS', 'TIME',
    'BDI', 'BDO',
    'BR', 'WBR', // line-break elements are inline — must be included so <h1>text<br><span>…</span></h1> collapses to TEXT
  ]);

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

  function parsePx(val) { return parseFloat(val) || 0; }

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
        x: parsePx(m[1]), y: parsePx(m[2]),
        blur: parsePx(m[3]), spread: parsePx(m[4] || '0px'),
        color, visible: true,
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

  function extractFills(el, cs) {
    const fills = [];
    const bgColor = parseColor(cs.backgroundColor);
    if (bgColor) fills.push({ type: 'SOLID', color: bgColor });

    const bgImage = cs.backgroundImage;
    if (bgImage && bgImage !== 'none') {
      if (bgImage.includes('gradient')) {
        fills.push({ type: 'GRADIENT', gradient: { type: 'LINEAR', raw: bgImage } });
      } else {
        const m = bgImage.match(/url\(["']?([^"')]+)["']?\)/);
        if (m) fills.push({ type: 'IMAGE', url: m[1] });
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
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      const w = parsePx(cs[`border${side}Width`]);
      const color = parseColor(cs[`border${side}Color`]);
      if (w > 0 && color) {
        return [{ side: side.toLowerCase(), width: w, color }];
      }
    }
    return [];
  }

  // ─── Node type detection ─────────────────────────────────────────────────────

  function isSvgEl(el) { return el instanceof SVGElement; }

  function hasOnlyInlineChildren(el) {
    if (el.childElementCount === 0) return false;
    return [...el.children].every(c => INLINE_TAGS.has(c.tagName));
  }

  function hasVisualBox(cs) {
    const bgColor = cs.backgroundColor;
    const hasBg = bgColor && bgColor !== 'rgba(0, 0, 0, 0)' && bgColor !== 'transparent';
    const hasBorder = ['Top', 'Right', 'Bottom', 'Left'].some(s => parsePx(cs[`border${s}Width`]) > 0);
    return hasBg || hasBorder;
  }

  function nodeType(el, cs) {
    if (isSvgEl(el)) return 'SVG';
    if (el.tagName === 'IMG') return 'IMAGE';
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return 'INPUT';

    const raw = el.innerText !== undefined ? el.innerText : el.textContent;
    const hasText = raw.trim().length > 0;

    // Leaf element with text → TEXT (buildText will wrap in frame if it has borders)
    if (el.childElementCount === 0 && hasText) return 'TEXT';

    // Element whose children are all inline/line-break tags → collapse to a single TEXT
    // node so we capture full innerText (e.g. <h1>Foo<br><span>Bar</span></h1>).
    // BUT: if the element has its own visual box (border, background), keep it as FRAME
    // so its styling is preserved — its inline children will be TEXT nodes inside.
    if (hasOnlyInlineChildren(el) && hasText && !hasVisualBox(cs)) return 'TEXT';

    return 'FRAME';
  }

  // ─── Text extraction ─────────────────────────────────────────────────────────

  function extractText(el, cs) {
    // Use innerText so <br> becomes \n and invisible text (display:none) is excluded.
    const raw = (el.innerText !== undefined ? el.innerText : el.textContent) || '';
    const content = raw.replace(/\n{3,}/g, '\n\n').trim();

    return {
      content,
      fontSize: parsePx(cs.fontSize),
      fontFamily: cs.fontFamily.split(',')[0].replace(/['"]/g, '').trim(),
      fontWeight: cs.fontWeight,
      fontStyle: cs.fontStyle,
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
    if (rect.width === 0 && rect.height === 0) return null;

    const cs = window.getComputedStyle(el);
    if (cs.display === 'none') return null;
    if (cs.visibility === 'hidden' && el.childElementCount === 0) return null;

    const type = nodeType(el, cs);
    const name = el.id
      ? `#${el.id}`
      : (typeof el.className === 'string' && el.className.trim())
        ? el.className.trim().split(/\s+/)[0]
        : el.tagName.toLowerCase();

    const layer = {
      type,
      tagName: el.tagName,
      name,
      x: Math.round(rect.left - (parentRect ? parentRect.left : 0)),
      y: Math.round(rect.top  - (parentRect ? parentRect.top  : 0)),
      width:  Math.round(rect.width),
      height: Math.round(rect.height),
      opacity: parseFloat(cs.opacity) ?? 1,
      overflow: cs.overflow === 'hidden' || cs.overflowX === 'hidden' || cs.overflowY === 'hidden',
      borderRadius: parseBorderRadius(cs),
      fills:   extractFills(el, cs),
      strokes: extractStrokes(cs),
      effects: parseBoxShadow(cs.boxShadow),
      padding: {
        top:    parsePx(cs.paddingTop),
        right:  parsePx(cs.paddingRight),
        bottom: parsePx(cs.paddingBottom),
        left:   parsePx(cs.paddingLeft),
      },
      children: [],
    };

    if (type === 'TEXT' || type === 'INPUT') {
      layer.text = extractText(el, cs);
    }

    if (type === 'SVG') {
      try { layer.svgContent = new XMLSerializer().serializeToString(el); } catch {}
    }

    // Only recurse for container elements
    if (type === 'FRAME') {
      for (const child of el.children) {
        const childLayer = walkNode(child, rect);
        if (childLayer) layer.children.push(childLayer);
      }
    }

    return layer;
  }

  // ─── Root ────────────────────────────────────────────────────────────────────

  window.scrollTo(0, 0);

  const body = document.body;
  const bodyRect = body.getBoundingClientRect();
  const bgColor = parseColor(getComputedStyle(body).backgroundColor)
    || parseColor(getComputedStyle(document.documentElement).backgroundColor)
    || { r: 1, g: 1, b: 1, a: 1 };

  const root = {
    type: 'FRAME', tagName: 'BODY', name: 'Page',
    x: 0, y: 0,
    width:  Math.max(document.documentElement.scrollWidth,  document.body.scrollWidth),
    height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    fills: [{ type: 'SOLID', color: bgColor }],
    strokes: [], effects: [],
    borderRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    opacity: 1, overflow: false, children: [],
  };

  for (const child of body.children) {
    const layer = walkNode(child, bodyRect);
    if (layer) root.children.push(layer);
  }

  return root;
}
