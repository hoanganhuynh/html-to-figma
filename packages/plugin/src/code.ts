/// <reference types="@figma/plugin-typings" />

figma.showUI(__html__, { width: 420, height: 560, title: 'HTML to Figma' });

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'build') {
    await buildFromLayers(msg.layers, msg.images);
    figma.notify('Done! Layers created.');
    figma.ui.postMessage({ type: 'done' });
  }
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface Color { r: number; g: number; b: number; a: number }

interface GradientStop { color: Color; position: number }
interface GradientData { type: 'LINEAR'; angle: number; stops: GradientStop[] }

interface Fill {
  type: 'SOLID' | 'IMAGE' | 'GRADIENT';
  color?: Color;
  url?: string;
  gradient?: GradientData;
}

interface Stroke { side: string; width: number; color: Color }

interface Shadow {
  type: 'dropShadow' | 'innerShadow';
  x: number; y: number; blur: number; spread: number;
  color: Color; visible: boolean;
}

interface TextShadow { x: number; y: number; blur: number; color: Color }

interface BorderRadius { tl: number; tr: number; br: number; bl: number }
interface Padding { top: number; right: number; bottom: number; left: number }

interface InlineColor { text: string; color: Color }

interface TextInfo {
  content: string; fontSize: number; fontFamily: string;
  fontWeight: string; fontStyle: string;
  lineHeight: string; letterSpacing: string;
  textAlign: string; color: Color | null;
  textDecoration: string; textTransform: string;
  textShadows?: TextShadow[];
  inlineColors?: InlineColor[];
  lineCount?: number;
}

interface FlexLayout {
  direction: string;      // 'row' | 'column' | 'row-reverse' | 'column-reverse'
  alignItems: string;     // 'flex-start' | 'center' | 'flex-end' | 'stretch' | ...
  justifyContent: string; // 'flex-start' | 'center' | 'space-between' | ...
  gap: number;
  rowGap: number;
  columnGap: number;
}

interface Layer {
  type: 'FRAME' | 'TEXT' | 'INPUT' | 'IMAGE' | 'SVG';
  tagName: string;
  name: string;
  x: number; y: number; width: number; height: number;
  opacity: number;
  overflow: boolean;
  borderRadius: BorderRadius;
  padding: Padding;
  fills: Fill[];
  strokes: Stroke[];
  effects: Shadow[];
  flexLayout?: FlexLayout;
  flexGrow?: number;
  alignSelf?: string;
  text?: TextInfo;
  svgContent?: string;
  children: Layer[];
}

// ─── Gradient → Figma ─────────────────────────────────────────────────────────

/**
 * Convert a parsed CSS linear-gradient into a Figma GradientPaint.
 *
 * Figma's GRADIENT_LINEAR uses a 2×3 affine transform that maps the canonical
 * horizontal gradient line [(0,0.5)→(1,0.5)] into normalized node-space
 * (where 0,0 = top-left and 1,1 = bottom-right).
 *
 * CSS angle convention: 0deg = upward (to top), clockwise.
 * Figma convention: identity transform = left→right (equivalent to CSS 90deg).
 * Rotation needed in Figma space: φ = (angleCss − 90)°, counterclockwise.
 *
 * Rotation-around-center (cx=cy=0.5):
 *   a =  cos φ,  b = −sin φ,  c = 0.5·(1 − cos φ + sin φ)
 *   d =  sin φ,  e =  cos φ,  f = 0.5·(1 − cos φ − sin φ)
 */
function buildGradientPaint(g: GradientData): GradientPaint | null {
  if (g.type !== 'LINEAR' || g.stops.length < 2) return null;

  const phi = (g.angle - 90) * Math.PI / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);

  const gradientTransform: Transform = [
    [cos, -sin, 0.5 * (1 - cos + sin)],
    [sin,  cos, 0.5 * (1 - cos - sin)],
  ];

  const gradientStops: ColorStop[] = g.stops.map(s => ({
    position: s.position,
    color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a },
  }));

  return { type: 'GRADIENT_LINEAR', gradientTransform, gradientStops };
}

// ─── Fills ────────────────────────────────────────────────────────────────────

function applyFills(node: FrameNode | TextNode, fills: Fill[], images: Record<string, string>) {
  const result: Paint[] = [];
  for (const f of fills) {
    if (f.type === 'SOLID' && f.color) {
      result.push({
        type: 'SOLID',
        color: { r: f.color.r, g: f.color.g, b: f.color.b },
        opacity: f.color.a,
      });
    } else if (f.type === 'IMAGE' && f.url) {
      const dataUrl = images[f.url];
      if (dataUrl) {
        try {
          const b64 = dataUrl.split(',')[1];
          const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
          const img = figma.createImage(bytes);
          result.push({ type: 'IMAGE', scaleMode: 'FILL', imageHash: img.hash });
        } catch { /* skip failed image */ }
      }
    } else if (f.type === 'GRADIENT' && f.gradient && node.type !== 'TEXT') {
      // Gradients are background fills — only meaningful on frame nodes.
      const paint = buildGradientPaint(f.gradient);
      if (paint) result.push(paint);
    }
  }
  node.fills = result;
}

// ─── Strokes ──────────────────────────────────────────────────────────────────

// NOTE: call AFTER applyBorderRadius — per-side stroke weights are rejected by
// Figma on nodes that have a corner radius, so we must know the radius first.
function applyStrokes(node: FrameNode, strokes: Stroke[]) {
  if (!strokes.length) return;

  // Figma allows one stroke color per node — use the first present side's color.
  const c = strokes[0].color;
  node.strokes = [{ type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a }];
  node.strokeAlign = 'INSIDE';

  const uniform = () => {
    node.strokeWeight = Math.max(...strokes.map(s => s.width));
  };

  // CSS outline → uniform border on all four sides.
  if (strokes.length === 1 && strokes[0].side === 'all') {
    uniform();
    return;
  }

  // Per-side weights are disallowed on rounded nodes — fall back to uniform.
  const radius = node.cornerRadius;
  const hasRadius = (typeof radius === 'number' && radius > 0)
    || node.topLeftRadius > 0 || node.topRightRadius > 0
    || node.bottomLeftRadius > 0 || node.bottomRightRadius > 0;
  if (hasRadius) {
    uniform();
    return;
  }

  // Per-side border: only draw the sides that actually have a border so a lone
  // border-bottom stays an underline instead of becoming a full box outline.
  const widthOf = (side: string) => {
    const found = strokes.find(s => s.side === side);
    return found ? found.width : 0;
  };
  try {
    node.strokeTopWeight = widthOf('top');
    node.strokeRightWeight = widthOf('right');
    node.strokeBottomWeight = widthOf('bottom');
    node.strokeLeftWeight = widthOf('left');
  } catch {
    uniform();
  }
}

// ─── Effects ─────────────────────────────────────────────────────────────────

function applyEffects(node: FrameNode, shadows: Shadow[]) {
  const effects: Effect[] = shadows.map(s => ({
    type: s.type === 'dropShadow' ? 'DROP_SHADOW' : 'INNER_SHADOW',
    color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a },
    offset: { x: s.x, y: s.y },
    radius: s.blur,
    spread: s.spread,
    visible: s.visible,
    blendMode: 'NORMAL',
  } as DropShadowEffect));
  if (effects.length) node.effects = effects;
}

function applyTextEffects(node: TextNode, textShadows: TextShadow[]) {
  if (!textShadows?.length) return;
  node.effects = textShadows.map(s => ({
    type: 'DROP_SHADOW',
    color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a },
    offset: { x: s.x, y: s.y },
    radius: s.blur,
    spread: 0,
    visible: true,
    blendMode: 'NORMAL',
  } as DropShadowEffect));
}

// ─── Border radius ────────────────────────────────────────────────────────────

function applyBorderRadius(node: FrameNode, br: BorderRadius) {
  const { tl, tr, br: brv, bl } = br;
  if (tl === tr && tr === brv && brv === bl) {
    node.cornerRadius = tl;
  } else {
    node.topLeftRadius = tl;
    node.topRightRadius = tr;
    node.bottomRightRadius = brv;
    node.bottomLeftRadius = bl;
  }
}

// ─── Font loading ─────────────────────────────────────────────────────────────

function figmaFontStyle(weight: string, italic: boolean): string {
  const w = parseInt(weight) || 400;
  if (italic) {
    if (w >= 900) return 'Black Italic';
    if (w >= 800) return 'ExtraBold Italic';
    if (w >= 700) return 'Bold Italic';
    if (w >= 600) return 'SemiBold Italic';
    if (w >= 500) return 'Medium Italic';
    if (w <= 200) return 'ExtraLight Italic';
    if (w <= 300) return 'Light Italic';
    return 'Italic';
  }
  if (w >= 900) return 'Black';
  if (w >= 800) return 'ExtraBold';
  if (w >= 700) return 'Bold';
  if (w >= 600) return 'SemiBold';
  if (w >= 500) return 'Medium';
  if (w <= 100) return 'Thin';
  if (w <= 200) return 'ExtraLight';
  if (w <= 300) return 'Light';
  return 'Regular';
}

const fontCache: Record<string, FontName> = {};

async function loadFontSafe(family: string, weight: string, italic: boolean): Promise<FontName> {
  const key = `${family}-${weight}-${italic}`;
  if (fontCache[key]) return fontCache[key];

  const style = figmaFontStyle(weight, italic);
  const w = parseInt(weight) || 400;

  // Weight-ordered fallback styles within the same family
  const weightStyles: string[] = [];
  if (!italic) {
    if (w >= 900) weightStyles.push('Black', 'ExtraBold', 'Bold', 'Regular');
    else if (w >= 800) weightStyles.push('ExtraBold', 'Black', 'Bold', 'Regular');
    else if (w >= 700) weightStyles.push('Bold', 'SemiBold', 'Regular');
    else if (w >= 600) weightStyles.push('SemiBold', 'Medium', 'Bold', 'Regular');
    else if (w >= 500) weightStyles.push('Medium', 'SemiBold', 'Regular');
    else if (w <= 200) weightStyles.push('ExtraLight', 'Thin', 'Light', 'Regular');
    else if (w <= 300) weightStyles.push('Light', 'ExtraLight', 'Regular');
    else weightStyles.push('Regular');
  } else {
    if (w >= 900) weightStyles.push('Black Italic', 'ExtraBold Italic', 'Bold Italic', 'Italic');
    else if (w >= 800) weightStyles.push('ExtraBold Italic', 'Black Italic', 'Bold Italic', 'Italic');
    else if (w >= 700) weightStyles.push('Bold Italic', 'SemiBold Italic', 'Italic');
    else weightStyles.push('Italic', 'Regular');
  }

  // Google Fonts sometimes ships heavy weights as a separate family.
  // e.g. CSS "Archivo" weight 900 → Figma family "Archivo Black" style "Regular".
  const separateFamilies: FontName[] = [];
  if (w >= 900) separateFamilies.push({ family: `${family} Black`, style: italic ? 'Italic' : 'Regular' });
  if (w >= 800) separateFamilies.push({ family: `${family} ExtraBold`, style: italic ? 'Italic' : 'Regular' });

  const fallbacks: FontName[] = [
    { family, style },
    ...weightStyles.filter(s => s !== style).map(s => ({ family, style: s })),
    ...separateFamilies,
    { family: 'Inter', style: italic ? 'Italic' : 'Regular' },
    { family: 'Inter', style: 'Regular' },
  ];

  for (const font of fallbacks) {
    try {
      await figma.loadFontAsync(font);
      fontCache[key] = font;
      return font;
    } catch { /* try next */ }
  }

  const last = { family: 'Inter', style: 'Regular' };
  await figma.loadFontAsync(last);
  fontCache[key] = last;
  return last;
}

// ─── Text helpers ─────────────────────────────────────────────────────────────

function parseLineHeight(lh: string, fontSize: number): LineHeight {
  if (!lh || lh === 'normal') return { unit: 'AUTO' };
  if (lh.endsWith('px')) return { unit: 'PIXELS', value: parseFloat(lh) };
  const num = parseFloat(lh);
  if (!isNaN(num) && num > 0) return { unit: 'PIXELS', value: num * fontSize };
  return { unit: 'AUTO' };
}

function parseLetterSpacing(ls: string): LetterSpacing {
  if (!ls || ls === 'normal') return { unit: 'PIXELS', value: 0 };
  if (ls.endsWith('em')) return { unit: 'PERCENT', value: parseFloat(ls) * 100 };
  if (ls.endsWith('px')) return { unit: 'PIXELS', value: parseFloat(ls) };
  return { unit: 'PIXELS', value: 0 };
}

function applyTextTransform(content: string, transform: string): string {
  if (transform === 'uppercase') return content.toUpperCase();
  if (transform === 'lowercase') return content.toLowerCase();
  if (transform === 'capitalize') return content.replace(/\b\w/g, c => c.toUpperCase());
  return content;
}

// ─── Build TEXT node ──────────────────────────────────────────────────────────

async function buildText(layer: Layer, images: Record<string, string>, parentIsAutoLayout = false): Promise<SceneNode | null> {
  const t = layer.text!;
  if (!t.content) return null;

  const isItalic = t.fontStyle === 'italic' || t.fontStyle === 'oblique';
  const font = await loadFontSafe(t.fontFamily, t.fontWeight, isItalic);

  const node = figma.createText();
  node.fontName = font;
  node.fontSize = Math.max(t.fontSize || 14, 1);

  const content = applyTextTransform(t.content, t.textTransform);
  node.characters = content;

  node.lineHeight = parseLineHeight(t.lineHeight, t.fontSize);
  node.letterSpacing = parseLetterSpacing(t.letterSpacing);

  const alignMap: Record<string, 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED'> = {
    left: 'LEFT', start: 'LEFT',
    center: 'CENTER',
    right: 'RIGHT', end: 'RIGHT',
    justify: 'JUSTIFIED',
  };
  node.textAlignHorizontal = alignMap[t.textAlign] || 'LEFT';

  // Base text color
  if (t.color) {
    node.fills = [{
      type: 'SOLID',
      color: { r: t.color.r, g: t.color.g, b: t.color.b },
      opacity: t.color.a,
    }];
  } else {
    // Transparent text color usually means CSS `background-clip: text` + gradient.
    // Apply any gradient fills from the element's background directly onto the text node.
    const gradFills: Paint[] = [];
    for (const f of layer.fills) {
      if (f.type === 'GRADIENT' && f.gradient) {
        const paint = buildGradientPaint(f.gradient);
        if (paint) gradFills.push(paint);
      }
    }
    if (gradFills.length > 0) node.fills = gradFills;
  }

  // Per-character color overrides (e.g. <h1>white text <span class="gold">Profit.</span></h1>)
  if (t.inlineColors?.length) {
    for (const ic of t.inlineColors) {
      const searchText = applyTextTransform(ic.text, t.textTransform);
      const idx = content.indexOf(searchText);
      if (idx >= 0) {
        node.setRangeFills(idx, idx + searchText.length, [{
          type: 'SOLID',
          color: { r: ic.color.r, g: ic.color.g, b: ic.color.b },
          opacity: ic.color.a,
        }]);
      }
    }
  }

  if (t.textDecoration?.includes('underline')) node.textDecoration = 'UNDERLINE';
  else if (t.textDecoration?.includes('line-through')) node.textDecoration = 'STRIKETHROUGH';

  if (t.textShadows?.length) applyTextEffects(node, t.textShadows);

  node.opacity = layer.opacity;

  // If the element has visual boxing (border, background, border-radius), wrap
  // the text in a FrameNode — TEXT nodes in Figma can't have borders/radius.
  const br = layer.borderRadius;
  const hasBorderRadius = br.tl > 0 || br.tr > 0 || br.br > 0 || br.bl > 0;
  const hasBackground = layer.fills.some(f => f.type === 'SOLID' || f.type === 'IMAGE' || f.type === 'GRADIENT');
  const hasStroke = layer.strokes.length > 0;

  if (hasBackground || hasStroke || hasBorderRadius) {
    // Badge / pill — exact fixed size so the border-radius looks right.
    const frame = figma.createFrame();
    frame.layoutMode = 'NONE';
    frame.name = layer.name;
    frame.x = layer.x;
    frame.y = layer.y;
    frame.resize(Math.max(layer.width, 1), Math.max(layer.height, 1));
    frame.opacity = layer.opacity;
    frame.clipsContent = layer.overflow;
    frame.fills = [];
    applyFills(frame, layer.fills, images);
    applyBorderRadius(frame, layer.borderRadius);
    applyStrokes(frame, layer.strokes); // after radius: per-side weights need it
    applyEffects(frame, layer.effects);

    const pad = layer.padding ?? { top: 0, right: 0, bottom: 0, left: 0 };
    const innerW = Math.max(layer.width - pad.left - pad.right, 1);
    const innerH = Math.max(layer.height - pad.top - pad.bottom, 1);
    node.textAutoResize = 'NONE';
    node.resize(innerW, innerH);
    node.x = pad.left;
    node.y = pad.top;
    frame.appendChild(node);
    return frame;
  }

  // Single-line text (measured in the browser) must NEVER wrap in Figma.
  // Figma renders many fonts a hair wider than Chrome, so a heading the browser
  // fit on one line (e.g. "Profit.") would wrap to two — and since the box
  // height was sized for one line, the second line overflows and overlaps the
  // content below. Using WIDTH_AND_HEIGHT lets Figma auto-size the box to fit
  // the text on one line, eliminating the wrap entirely.
  //
  // Multi-line text keeps its captured width and grows in height (HEIGHT mode):
  // if Figma wraps one extra line the box just gets taller, never overflowing.
  const isSingleLine = (t.lineCount ?? 1) <= 1 && !content.includes('\n');

  if (isSingleLine) {
    node.textAutoResize = 'WIDTH_AND_HEIGHT';
  } else {
    node.textAutoResize = 'HEIGHT';
    node.resize(Math.max(layer.width, 1), Math.max(layer.height, 1));
  }

  node.x = layer.x;
  node.y = layer.y;
  return node;
}

// ─── Build SVG node ───────────────────────────────────────────────────────────

async function buildSvg(layer: Layer): Promise<FrameNode | null> {
  if (!layer.svgContent) return null;
  try {
    const node = figma.createNodeFromSvg(layer.svgContent);
    node.resize(Math.max(layer.width, 1), Math.max(layer.height, 1));
    node.x = layer.x;
    node.y = layer.y;
    node.opacity = layer.opacity;
    return node as unknown as FrameNode;
  } catch { return null; }
}

// ─── Build FRAME node ─────────────────────────────────────────────────────────

async function buildFrame(layer: Layer, images: Record<string, string>): Promise<FrameNode> {
  const node = figma.createFrame();
  node.name = layer.name || layer.tagName.toLowerCase();

  // Always absolute positioning — Figma auto-layout requires margin/gap data
  // that doesn't survive the getBoundingClientRect→absolute-x/y conversion.
  // Children are positioned by their captured x/y, which already encode all
  // CSS layout (flex, grid, absolute, inline) into page-relative coordinates.
  node.layoutMode = 'NONE';

  node.x = layer.x;
  node.y = layer.y;
  node.resize(Math.max(layer.width, 1), Math.max(layer.height, 1));
  node.opacity = layer.opacity;
  node.clipsContent = layer.overflow;
  node.fills = [];

  applyFills(node, layer.fills, images);
  applyBorderRadius(node, layer.borderRadius);
  applyStrokes(node, layer.strokes); // after radius: per-side weights need it
  applyEffects(node, layer.effects);

  for (const child of layer.children) {
    const childNode = await buildLayer(child, images, false);
    if (!childNode) continue;
    node.appendChild(childNode);
    // Re-apply position after append — Figma resets x/y to 0 on append.
    let cx = child.x;
    // A single-line text node auto-sized with WIDTH_AND_HEIGHT shrank to the
    // text's own width. If the original box was centered/right-aligned, keep the
    // text visually where it was instead of snapping it to the box's left edge.
    if (childNode.type === 'TEXT' && childNode.textAutoResize === 'WIDTH_AND_HEIGHT') {
      const align = childNode.textAlignHorizontal;
      if (align === 'CENTER') cx = child.x + (child.width - childNode.width) / 2;
      else if (align === 'RIGHT') cx = child.x + (child.width - childNode.width);
    }
    childNode.x = cx;
    childNode.y = child.y;
  }

  return node;
}

// ─── Main dispatch ────────────────────────────────────────────────────────────

async function buildLayer(layer: Layer, images: Record<string, string>, parentIsAutoLayout = false): Promise<SceneNode | null> {
  if (layer.type === 'TEXT' || layer.type === 'INPUT') return buildText(layer, images, parentIsAutoLayout);
  if (layer.type === 'SVG') return buildSvg(layer);
  return buildFrame(layer, images);
}

async function buildFromLayers(rootLayer: Layer, images: Record<string, string>) {
  const frame = await buildFrame(rootLayer, images);
  frame.name = 'Imported from HTML';
  figma.currentPage.appendChild(frame);
  figma.viewport.scrollAndZoomIntoView([frame]);
}
