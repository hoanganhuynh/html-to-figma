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
interface Fill { type: 'SOLID' | 'IMAGE' | 'GRADIENT'; color?: Color; url?: string; gradient?: any }
interface Stroke { side: string; width: number; color: Color }
interface Shadow { type: 'dropShadow' | 'innerShadow'; x: number; y: number; blur: number; spread: number; color: Color; visible: boolean }
interface BorderRadius { tl: number; tr: number; br: number; bl: number }
interface Padding { top: number; right: number; bottom: number; left: number }
interface TextInfo {
  content: string; fontSize: number; fontFamily: string;
  fontWeight: string; fontStyle: string;
  lineHeight: string; letterSpacing: string;
  textAlign: string; color: Color | null;
  textDecoration: string; textTransform: string;
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
  text?: TextInfo;
  svgContent?: string;
  children: Layer[];
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
    }
    // GRADIENT: skip for now — complex to convert accurately
  }
  node.fills = result;
}

// ─── Strokes ──────────────────────────────────────────────────────────────────

function applyStrokes(node: FrameNode, strokes: Stroke[]) {
  if (!strokes.length) return;
  const s = strokes[0];
  node.strokes = [{ type: 'SOLID', color: { r: s.color.r, g: s.color.g, b: s.color.b }, opacity: s.color.a }];
  node.strokeWeight = s.width;
  node.strokeAlign = 'INSIDE';
}

// ─── Effects (shadows) ────────────────────────────────────────────────────────

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

  // Weight-ordered style fallbacks within the same family
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

  // Google Fonts sometimes ships heavy weights as a SEPARATE family, e.g. "Archivo Black"
  // with style "Regular" instead of "Archivo" with style "Black". Build those too.
  const separateFamilyFallbacks: FontName[] = [];
  if (w >= 900) {
    separateFamilyFallbacks.push(
      { family: `${family} Black`, style: italic ? 'Italic' : 'Regular' },
    );
  }
  if (w >= 800) {
    separateFamilyFallbacks.push(
      { family: `${family} ExtraBold`, style: italic ? 'Italic' : 'Regular' },
    );
  }

  const fallbacks: FontName[] = [
    { family, style },
    ...weightStyles.filter(s => s !== style).map(s => ({ family, style: s })),
    ...separateFamilyFallbacks,
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

async function buildText(layer: Layer, images: Record<string, string>): Promise<SceneNode | null> {
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

  if (t.color) {
    node.fills = [{
      type: 'SOLID',
      color: { r: t.color.r, g: t.color.g, b: t.color.b },
      opacity: t.color.a,
    }];
  }

  if (t.textDecoration?.includes('underline')) node.textDecoration = 'UNDERLINE';
  else if (t.textDecoration?.includes('line-through')) node.textDecoration = 'STRIKETHROUGH';

  // Lock width to match captured layout; let height grow with content
  node.textAutoResize = 'HEIGHT';
  node.resize(Math.max(layer.width, 1), Math.max(layer.height, 1));
  node.opacity = layer.opacity;

  // If the element has a visual box (border, background, or border-radius), wrap
  // the text in a FRAME so those properties are preserved. This handles badge/pill
  // elements like <span class="tag">Label</span> that have border + border-radius.
  const br = layer.borderRadius;
  const hasBorderRadius = br.tl > 0 || br.tr > 0 || br.br > 0 || br.bl > 0;
  const hasBackground = layer.fills.some(f => f.type === 'SOLID' || f.type === 'IMAGE');
  const hasStroke = layer.strokes.length > 0;

  if (hasBackground || hasStroke || hasBorderRadius) {
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
    applyStrokes(frame, layer.strokes);
    applyEffects(frame, layer.effects);
    applyBorderRadius(frame, layer.borderRadius);

    // Position text using captured padding so it sits correctly inside the box
    const pad = layer.padding ?? { top: 0, right: 0, bottom: 0, left: 0 };
    const innerW = Math.max(layer.width - pad.left - pad.right, 1);
    const innerH = Math.max(layer.height - pad.top - pad.bottom, 1);
    node.textAutoResize = 'HEIGHT';
    node.resize(innerW, innerH);
    node.x = pad.left;
    node.y = pad.top;
    frame.appendChild(node);
    return frame;
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

  // IMPORTANT: Always use absolute positioning — never Auto Layout.
  // Auto Layout ignores x/y coordinates and rearranges children,
  // which breaks pixel-perfect positioning.
  node.layoutMode = 'NONE';

  node.x = layer.x;
  node.y = layer.y;
  node.resize(Math.max(layer.width, 1), Math.max(layer.height, 1));
  node.opacity = layer.opacity;
  node.clipsContent = layer.overflow;
  node.fills = [];

  applyFills(node, layer.fills, images);
  applyStrokes(node, layer.strokes);
  applyEffects(node, layer.effects);
  applyBorderRadius(node, layer.borderRadius);

  for (const child of layer.children) {
    const childNode = await buildLayer(child, images);
    if (childNode) {
      node.appendChild(childNode);
      // Re-apply position after append to ensure correct coordinates
      childNode.x = child.x;
      childNode.y = child.y;
    }
  }

  return node;
}

// ─── Main dispatch ────────────────────────────────────────────────────────────

async function buildLayer(layer: Layer, images: Record<string, string>): Promise<SceneNode | null> {
  if (layer.type === 'TEXT' || layer.type === 'INPUT') {
    return buildText(layer, images);
  }
  if (layer.type === 'SVG') {
    return buildSvg(layer);
  }
  return buildFrame(layer, images);
}

async function buildFromLayers(rootLayer: Layer, images: Record<string, string>) {
  const frame = await buildFrame(rootLayer, images);
  frame.name = 'Imported from HTML';
  figma.currentPage.appendChild(frame);
  figma.viewport.scrollAndZoomIntoView([frame]);
}
