import http from 'http';
import { chromium } from 'playwright';
import { captureScript } from './capture.js';

const PORT = 3333;

let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

/**
 * After the page loads, prepare it for pixel-perfect capture:
 * 1. Disable all CSS transitions/animations so state changes are instant
 * 2. Scroll through the full page to trigger IntersectionObservers,
 *    scroll-reveal libraries, lazy loaders, etc.
 * 3. Return to scroll(0,0) so getBoundingClientRect() gives page-relative coords
 */
async function preparePageForCapture(page) {
  // Step 1: Kill all transitions & animations
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        animation-play-state: paused !important;
      }
    `,
  });

  // Step 2: Scroll through full page in steps to fire IntersectionObservers
  const totalHeight = await page.evaluate(() =>
    Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)
  );

  const step = 600; // ~2/3 of 900px viewport — overlapping scroll
  for (let y = 0; y <= totalHeight; y += step) {
    await page.evaluate((sy) => window.scrollTo(0, sy), y);
    await page.waitForTimeout(40);
  }
  // Make sure the very bottom is reached
  await page.evaluate((h) => window.scrollTo(0, h), totalHeight);
  await page.waitForTimeout(100);

  // Step 3: Back to top — all getBoundingClientRect() will be page-relative
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
}

async function captureUrl(url, viewport = { width: 1440, height: 900 }) {
  const b = await getBrowser();
  const page = await b.newPage({ viewport });
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(800);
    await preparePageForCapture(page);
    const layers = await page.evaluate(captureScript);
    const images = await downloadImages(page, collectImageUrls(layers));
    return { layers, images };
  } finally {
    await page.close();
  }
}

async function captureHtmlContent(html, viewport = { width: 1440, height: 900 }) {
  const b = await getBrowser();
  const page = await b.newPage({ viewport });
  try {
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    await preparePageForCapture(page);
    const layers = await page.evaluate(captureScript);
    const images = await downloadImages(page, collectImageUrls(layers));
    return { layers, images };
  } finally {
    await page.close();
  }
}

function collectImageUrls(node, urls = new Set()) {
  if (!node) return urls;
  for (const fill of (node.fills || [])) {
    if (fill.type === 'IMAGE' && fill.url) urls.add(fill.url);
  }
  for (const child of (node.children || [])) collectImageUrls(child, urls);
  return urls;
}

async function downloadImages(page, urls) {
  const images = {};
  for (const url of urls) {
    try {
      const response = await page.request.get(url);
      if (response.ok()) {
        const buffer = await response.body();
        const ct = response.headers()['content-type'] || 'image/png';
        images[url] = `data:${ct};base64,${buffer.toString('base64')}`;
      }
    } catch { /* skip */ }
  }
  return images;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  const urlObj = new URL(req.url, `http://localhost:${PORT}`);

  if (urlObj.pathname === '/health') {
    res.writeHead(200, corsHeaders());
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (urlObj.pathname === '/capture' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', async () => {
      try {
        const { url: targetUrl, html, viewport } = JSON.parse(body);
        if (!targetUrl && !html) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ error: 'url or html required' }));
          return;
        }

        const vp = viewport || { width: 1440, height: 900 };
        console.log(`[capture] ${targetUrl || '(html content)'} @ ${vp.width}x${vp.height}`);

        const result = html
          ? await captureHtmlContent(html, vp)
          : await captureUrl(targetUrl, vp);

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error('[error]', err.message);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, corsHeaders());
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`\n✅ html-to-figma server running on http://localhost:${PORT}`);
  console.log('   POST /capture  { url } or { html }');
  console.log('   GET  /health\n');
});

process.on('SIGINT', async () => {
  if (browser) await browser.close();
  server.close();
  process.exit(0);
});
