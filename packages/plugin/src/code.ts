/// <reference types="@figma/plugin-typings" />

figma.showUI(__html__, { width: 420, height: 560, title: 'HTML to Figma' });

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'build') {
    await buildFromLayers(msg.layers, msg.images);
    figma.notify('Done! Layers created.');
    figma.ui.postMessage({ type: 'done' });
  }
};

// ─── Layer → Figma node ──────────────────────────────────────────────────────

interface Color { r: number; g: number; b: number; a: number }
interface Fill { type: 'SOLID' | 'IMAGE' | 'GRADIENT'; color?: Color; url?: string; gradient?: any }
interface Stroke { side: string; width: number; color: Color }
interface Shadow { type: 'dropShadow' | 'innerShadow'; x: number; y: number; blur: number; spread: number; color: Color; visible: boolean }
interface BorderRadius { tl: number; tr: number; br: number; bl: number }
interface AutoLayout { direction: 'HORIZONTAL' | 'VERTICAL'; gap: number; paddingTop: number; paddingRight: number; paddingBottom: number; paddingLeft: number; alignItems: string; justifyContent: string; wrap: boolean }
interface TextInfo { content: string; fontSize: number; fontFamily: string; fontWeight: string; lineHeight: string; letterSpacing: string; textAlign: string; color: Color | null; textDecoration: string }

interface Layer {
  type: 'FRAME' | 'TEXT' | 'IMAGE' | 'SVG';
  tagName: string;
  x: number; y: number; width: number; height: number;
  opacity: number;
  overflow: boolean;
  borderRadius: BorderRadius;
  fills: Fill[];
  strokes: Stroke[];
  effects: Shadow[];
  autoLayout: AutoLayout | null;
  text?: TextInfo;
  svgContent?: string;
  children: Layer[];
}

function figmaColor(c: Color): RGBA {
  return { r: c.r, g: c.g, b: c.b, a: c.a };
}

function applyFills(node: RectangleNode | FrameNode | TextNode, fills: Fill[], images: Record<string, string>) {
  const figmaFills: Paint[] = [];
  for (const f of fills) {
    if (f.type === 'SOLID' && f.color) {
      figmaFills.push({ type: 'SOLID', color: { r: f.color.r, g: f.color.g, b: f.color.b }, opacity: f.color.a });
    } else if (f.type === 'IMAGE' && f.url) {
      const dataUrl = images[f.url];
      if (dataUrl) {
        try {
          const b64 = dataUrl.split(',')[1];
          const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
          const img = figma.createImage(bytes);
          figmaFills.push({ type: 'IMAGE', scaleMode: 'FILL', imageHash: img.hash });
        } catch {
          // skip
        }
      }
    }
    // TODO: gradient support
  }
  if (figmaFills.length) node.fills = figmaFills;
}

function applyStrokes(node: FrameNode | RectangleNode, strokes: Stroke[]) {
  if (!strokes.length) return;
  const s = strokes[0];
  node.strokes = [{ type: 'SOLID', color: { r: s.color.r, g: s.color.g, b: s.color.b }, opacity: s.color.a }];
  node.strokeWeight = s.width;
  node.strokeAlign = 'INSIDE';
}

function applyEffects(node: FrameNode | RectangleNode, shadows: Shadow[]) {
  const effects: Effect[] = shadows.map(s => ({
    type: s.type === 'dropShadow' ? 'DROP_SHADOW' : 'INNER_SHADOW',
    color: figmaColor(s.color),
    offset: { x: s.x, y: s.y },
    radius: s.blur,
    spread: s.spread,
    visible: s.visible,
    blendMode: 'NORMAL',
  } as DropShadowEffect));
  if (effects.length) node.effects = effects;
}

function applyBorderRadius(node: FrameNode | RectangleNode, br: BorderRadius) {
  const { tl, tr, br: bottom_r, bl } = br;
  if (tl === tr && tr === bottom_r && bottom_r === bl) {
    node.cornerRadius = tl;
  } else {
    node.topLeftRadius = tl;
    node.topRightRadius = tr;
    node.bottomRightRadius = bottom_r;
    node.bottomLeftRadius = bl;
  }
}

function applyAutoLayout(node: FrameNode, al: AutoLayout) {
  node.layoutMode = al.direction;
  node.itemSpacing = al.gap;
  node.paddingTop = al.paddingTop;
  node.paddingRight = al.paddingRight;
  node.paddingBottom = al.paddingBottom;
  node.paddingLeft = al.paddingLeft;
  node.primaryAxisSizingMode = 'AUTO';
  node.counterAxisSizingMode = 'AUTO';

  // align-items → counterAxisAlignItems
  const aiMap: Record<string, 'MIN' | 'CENTER' | 'MAX' | 'BASELINE'> = {
    'flex-start': 'MIN', 'center': 'CENTER', 'flex-end': 'MAX', 'baseline': 'BASELINE',
  };
  node.counterAxisAlignItems = aiMap[al.alignItems] || 'MIN';

  // justify-content → primaryAxisAlignItems
  const jcMap: Record<string, 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN'> = {
    'flex-start': 'MIN', 'center': 'CENTER', 'flex-end': 'MAX', 'space-between': 'SPACE_BETWEEN',
  };
  node.primaryAxisAlignItems = jcMap[al.justifyContent] || 'MIN';
}

async function loadFontSafe(family: string, weight: string) {
  const numWeight = parseInt(weight) || 400;
  const style = numWeight >= 700 ? 'Bold' : numWeight >= 600 ? 'SemiBold' : 'Regular';
  try {
    await figma.loadFontAsync({ family, style });
    return { family, style };
  } catch {
    await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
    return { family: 'Inter', style: 'Regular' };
  }
}

function parseLineHeight(lh: string, fontSize: number): LineHeight {
  if (lh === 'normal') return { unit: 'AUTO' };
  if (lh.endsWith('px')) return { unit: 'PIXELS', value: parseFloat(lh) };
  const num = parseFloat(lh);
  if (!isNaN(num)) return { unit: 'PIXELS', value: num * fontSize };
  return { unit: 'AUTO' };
}

function parseLetterSpacing(ls: string, fontSize: number): LetterSpacing {
  if (!ls || ls === 'normal') return { unit: 'PIXELS', value: 0 };
  if (ls.endsWith('em')) return { unit: 'PERCENT', value: parseFloat(ls) * 100 };
  return { unit: 'PIXELS', value: parseFloat(ls) || 0 };
}

async function buildText(layer: Layer, images: Record<string, string>): Promise<TextNode> {
  const t = layer.text!;
  const font = await loadFontSafe(t.fontFamily, t.fontWeight);
  const node = figma.createText();
  node.fontName = font;
  node.fontSize = t.fontSize || 14;
  node.characters = t.content;
  node.lineHeight = parseLineHeight(t.lineHeight, t.fontSize);
  node.letterSpacing = parseLetterSpacing(t.letterSpacing, t.fontSize);

  const alignMap: Record<string, 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED'> = {
    left: 'LEFT', center: 'CENTER', right: 'RIGHT', justify: 'JUSTIFIED',
  };
  node.textAlignHorizontal = alignMap[t.textAlign] || 'LEFT';

  if (t.color) {
    node.fills = [{ type: 'SOLID', color: { r: t.color.r, g: t.color.g, b: t.color.b }, opacity: t.color.a }];
  }

  if (t.textDecoration?.includes('underline')) node.textDecoration = 'UNDERLINE';
  if (t.textDecoration?.includes('line-through')) node.textDecoration = 'STRIKETHROUGH';

  node.resize(layer.width, layer.height);
  node.x = layer.x;
  node.y = layer.y;
  node.opacity = layer.opacity;
  return node;
}

async function buildSvg(layer: Layer): Promise<FrameNode | null> {
  if (!layer.svgContent) return null;
  try {
    const node = figma.createNodeFromSvg(layer.svgContent);
    node.resize(layer.width, layer.height);
    node.x = layer.x;
    node.y = layer.y;
    node.opacity = layer.opacity;
    return node as unknown as FrameNode;
  } catch {
    return null;
  }
}

async function buildLayer(layer: Layer, images: Record<string, string>): Promise<SceneNode | null> {
  if (layer.type === 'TEXT') {
    return buildText(layer, images);
  }

  if (layer.type === 'SVG') {
    return buildSvg(layer);
  }

  // FRAME or IMAGE
  const node = figma.createFrame();
  node.name = layer.tagName.toLowerCase();
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

  if (layer.autoLayout) {
    applyAutoLayout(node, layer.autoLayout);
  } else {
    node.layoutMode = 'NONE';
  }

  for (const child of layer.children) {
    const childNode = await buildLayer(child, images);
    if (childNode) node.appendChild(childNode);
  }

  return node;
}

async function buildFromLayers(rootLayer: Layer, images: Record<string, string>) {
  const page = figma.currentPage;
  const frame = await buildLayer(rootLayer, images) as FrameNode;
  if (!frame) return;
  frame.name = 'Imported from HTML';
  page.appendChild(frame);
  figma.viewport.scrollAndZoomIntoView([frame]);
}
