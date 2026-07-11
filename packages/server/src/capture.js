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

  // Inline elements AND line-break elements.  When ALL element children of a node
  // are in this set the node is collapsed to a single TEXT layer so that plain
  // text runs (DOM text nodes) between the inline children are not silently lost.
  // BR/WBR must be included so <h1>text<br><span>…</span></h1> collapses too.
  const INLINE_TAGS = new Set([
    'SPAN', 'A', 'EM', 'STRONG', 'B', 'I', 'U', 'S',
    'CODE', 'KBD', 'SAMP', 'VAR', 'CITE', 'DFN', 'ABBR',
    'SMALL', 'SUB', 'SUP', 'MARK', 'DEL', 'INS', 'TIME',
    'BDI', 'BDO', 'BR', 'WBR',
  ]);

  // ─── Generic helpers ──────────────────────────────────────────────────────────

  function parsePx(val) { return parseFloat(val) || 0; }

  /** Split a CSS string at top-level commas (skipping commas inside parentheses). */
  function splitTopLevel(str, sep = ',') {
    const parts = [];
    let depth = 0, start = 0;
    for (let i = 0; i < str.length; i++) {
      if (str[i] === '(') depth++;
      else if (str[i] === ')') depth--;
      else if (str[i] === sep && depth === 0) {
        parts.push(str.slice(start, i).trim());
        start = i + 1;
      }
    }
    parts.push(str.slice(start).trim());
    return parts;
  }

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

  // ─── Gradient parsing ─────────────────────────────────────────────────────────

  /**
   * Parse a single computed CSS linear-gradient() string into a structured object.
   * getComputedStyle always normalises colors to rgb()/rgba() so we can rely on
   * the parseColor helper for stop colors.
   */
  function parseLinearGradient(inner) {
    const parts = splitTopLevel(inner, ',');
    let angle = 180; // default = "to bottom"
    let stopStart = 0;

    const first = parts[0].trim();
    const degM = first.match(/^(-?[\d.]+)deg$/);
    if (degM) {
      angle = parseFloat(degM[1]);
      stopStart = 1;
    } else if (first.startsWith('to ')) {
      const dir = first.slice(3).trim();
      const map = {
        'top': 0, 'top right': 45, 'right top': 45,
        'right': 90, 'bottom right': 135, 'right bottom': 135,
        'bottom': 180, 'bottom left': 225, 'left bottom': 225,
        'left': 270, 'top left': 315, 'left top': 315,
      };
      if (dir in map) { angle = map[dir]; stopStart = 1; }
    } else if (/^-?[\d.]+rad$/.test(first)) {
      angle = parseFloat(first) * 180 / Math.PI; stopStart = 1;
    } else if (/^-?[\d.]+turn$/.test(first)) {
      angle = parseFloat(first) * 360; stopStart = 1;
    }

    const stops = [];
    for (let i = stopStart; i < parts.length; i++) {
      const p = parts[i].trim();
      // Each stop is: <color> [<position>]
      // getComputedStyle always gives rgb/rgba colors
      const m = p.match(/^(rgba?\([^)]+\))\s*([\d.]+%|[\d.]+px)?/);
      if (!m) continue;
      const color = parseColor(m[1]);
      if (!color) continue;
      const position = m[2]
        ? (m[2].endsWith('%') ? parseFloat(m[2]) / 100 : null)
        : null;
      stops.push({ color, position });
    }

    if (stops.length < 2) return null;

    // Distribute positions for stops that don't have explicit ones
    for (let i = 0; i < stops.length; i++) {
      if (stops[i].position === null) stops[i].position = i / (stops.length - 1);
    }

    return { type: 'LINEAR', angle, stops };
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
        x: parsePx(m[1]), y: parsePx(m[2]),
        blur: parsePx(m[3]), spread: parsePx(m[4] || '0px'),
        color, visible: true,
      });
    }
    return shadows;
  }

  function parseTextShadow(str) {
    if (!str || str === 'none') return [];
    const shadows = [];
    // text-shadow: x y blur color (no spread, no inset)
    const regex = /(-?\d+(?:\.\d+)?px)\s+(-?\d+(?:\.\d+)?px)\s+(-?\d+(?:\.\d+)?px)\s+(rgba?\([^)]+\))/g;
    let m;
    while ((m = regex.exec(str)) !== null) {
      const color = parseColor(m[4]);
      if (!color) continue;
      shadows.push({ x: parsePx(m[1]), y: parsePx(m[2]), blur: parsePx(m[3]), color });
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
      // backgroundImage can be a comma-separated stack of layers.
      // Split at top-level commas so we handle each layer individually.
      const layers = splitTopLevel(bgImage, ',');
      // Re-join adjacent parts that belong to the same function call.
      // After splitTopLevel each element is already one layer because commas
      // inside gradient() have depth > 0 and are not split.
      for (const layer of layers) {
        const s = layer.trim();
        if (s.includes('gradient')) {
          // Extract function name and inner content
          const fnM = s.match(/^([\w-]+)-gradient\((.+)\)$/s);
          if (fnM) {
            const fnType = fnM[1];
            if (fnType === 'linear') {
              const g = parseLinearGradient(fnM[2]);
              if (g) fills.push({ type: 'GRADIENT', gradient: g });
            }
            // radial / conic: skip for now
          }
        } else {
          const m = s.match(/url\(["']?([^"')]+)["']?\)/);
          if (m) fills.push({ type: 'IMAGE', url: m[1] });
        }
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
    // Also check CSS outline (badges sometimes use outline instead of border)
    const outlineW = parsePx(cs.outlineWidth);
    const outlineColor = parseColor(cs.outlineColor);
    if (outlineW > 0 && outlineColor) {
      return [{ side: 'all', width: outlineW, color: outlineColor }];
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
    const bg = cs.backgroundColor;
    const hasBg = bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
    const hasBorder = ['Top', 'Right', 'Bottom', 'Left'].some(s => parsePx(cs[`border${s}Width`]) > 0);
    const hasOutline = parsePx(cs.outlineWidth) > 0;
    return hasBg || hasBorder || hasOutline;
  }

  /**
   * Returns true when any non-BR inline child has its own visual box.
   * Keeps tag-list containers as FRAME so each pill badge is built individually.
   */
  function anyChildHasVisualBox(el) {
    for (const c of el.children) {
      if (c.tagName === 'BR' || c.tagName === 'WBR') continue;
      if (hasVisualBox(window.getComputedStyle(c))) return true;
    }
    return false;
  }

  function nodeType(el, cs) {
    if (isSvgEl(el)) return 'SVG';
    if (el.tagName === 'IMG') return 'IMAGE';
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return 'INPUT';

    const raw = el.innerText !== undefined ? el.innerText : el.textContent;
    const hasText = raw.trim().length > 0;

    // Pure leaf with text → TEXT (buildText wraps in FRAME if it has borders)
    if (el.childElementCount === 0 && hasText) return 'TEXT';

    // Collapse to TEXT only when:
    //   • all children are inline/BR/WBR
    //   • the element itself has no visual box
    //   • no child has its own visual box (e.g. pill badges inside a tag row)
    if (hasOnlyInlineChildren(el) && hasText && !hasVisualBox(cs) && !anyChildHasVisualBox(el)) {
      return 'TEXT';
    }

    return 'FRAME';
  }

  // ─── Text extraction ─────────────────────────────────────────────────────────

  function extractText(el, cs) {
    const raw = (el.innerText !== undefined ? el.innerText : el.textContent) || '';
    const content = raw.replace(/\n{3,}/g, '\n\n').trim();

    const baseColorStr = cs.color;
    const baseColor = parseColor(baseColorStr);

    // Collect per-span color overrides so that multi-color headings like
    // <h1>White text <span class="gold">Profit.</span></h1> can be reproduced
    // using Figma's per-character fill API.
    const inlineColors = [];
    if (el.childElementCount > 0) {
      for (const child of el.children) {
        if (child.tagName === 'BR' || child.tagName === 'WBR') continue;
        const childCs = window.getComputedStyle(child);
        if (childCs.color !== baseColorStr) {
          const childColor = parseColor(childCs.color);
          const childText = ((child.innerText !== undefined ? child.innerText : child.textContent) || '').trim();
          if (childText && childColor) {
            inlineColors.push({ text: childText, color: childColor });
          }
        }
      }
    }

    return {
      content,
      fontSize: parsePx(cs.fontSize),
      fontFamily: cs.fontFamily.split(',')[0].replace(/['"]/g, '').trim(),
      fontWeight: cs.fontWeight,
      fontStyle: cs.fontStyle,
      lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing,
      textAlign: cs.textAlign,
      color: baseColor,
      textDecoration: cs.textDecoration,
      textTransform: cs.textTransform,
      textShadows: parseTextShadow(cs.textShadow),
      inlineColors: inlineColors.length > 0 ? inlineColors : undefined,
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
