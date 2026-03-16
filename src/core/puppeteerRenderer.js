// src/core/puppeteerRenderer.js
// Singleton Puppeteer browser. Renders HTML to JPEG buffer at any canvas size.
// Reuses one browser instance across all requests to avoid cold-start cost.

import puppeteer from "puppeteer";

let browser = null;

async function getBrowser() {
  if (browser) return browser;
  browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--font-render-hinting=none",
    ],
  });
  // If the browser crashes, clear the singleton so next call relaunches
  browser.on("disconnected", () => { browser = null; });
  return browser;
}

/**
 * Render an HTML string to a JPEG buffer at the given pixel dimensions.
 * Waits for fonts and images to load before screenshotting.
 *
 * @param {string} html
 * @param {number} width
 * @param {number} height
 * @returns {Promise<Buffer>}
 */
export async function renderHtmlToJpeg(html, width, height) {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 20000 });
    // Extra wait to ensure fonts are painted
    await page.evaluate(() => document.fonts.ready);
    const buf = await page.screenshot({ type: "jpeg", quality: 92, clip: { x: 0, y: 0, width, height } });
    return buf;
  } finally {
    await page.close();
  }
}
