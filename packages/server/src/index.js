import http from 'http';
import { chromium } from 'playwright';
import { captureScript } from './capture.js';
import path from 'path';
import { pathToFileURL } from 'url';

const PORT = 3333;

let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

async function captureUrl(url) {
  const b = await getBrowser();
  const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    // Wait a bit extra for fonts/images
    await page.waitForTimeout(1000);
    const layers = await page.evaluate(captureScript);
    // Collect all image URLs from layers
    const imageUrls = collectImageUrls(layers);
    const images = await downloadImages(page, imageUrls);
    return { layers, images };
  } finally {
    await page.close();
  }
}

async function captureHtmlContent(html) {
  const b = await getBrowser();
  const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    const layers = await page.evaluate(captureScript);
    const imageUrls = collectImageUrls(layers);
    const images = await downloadImages(page, imageUrls);
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
  for (const child of (node.children || [])) {
    collectImageUrls(child, urls);
  }
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
    } catch {
      // Skip failed images
    }
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
  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Health check
  if (url.pathname === '/health') {
    res.writeHead(200, corsHeaders());
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Main capture endpoint
  if (url.pathname === '/capture' && req.method === 'POST') {
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

        console.log(`[capture] ${targetUrl || 'html content'}`);
        let result;
        if (html) {
          result = await captureHtmlContent(html);
        } else {
          result = await captureUrl(targetUrl);
        }

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
  console.log('\nShutting down...');
  if (browser) await browser.close();
  server.close();
  process.exit(0);
});
