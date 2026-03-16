// src/core/puppeteerRenderer.js
// Singleton Puppeteer browser. Renders HTML to JPEG buffer at any canvas size.
// Reuses one browser instance across all requests to avoid cold-start cost.

import puppeteer from "puppeteer";
import { execFileSync } from "child_process";
import { existsSync } from "fs";

let browser = null;
let chromeReady = false;

async function ensureChrome() {
  if (chromeReady) return;
  try {
    const ep = puppeteer.executablePath();
    if (!existsSync(ep)) {
      console.log("[Puppeteer] Chrome not found — installing now (one-time, ~30s)...");
      // execFileSync avoids shell injection; all args are hardcoded constants
      execFileSync("node_modules/.bin/puppeteer", ["browsers", "install", "chrome"], {
        stdio: "inherit",
        timeout: 120000,
        cwd: process.cwd(),
      });
      console.log("[Puppeteer] Chrome installed.");
    }
    chromeReady = true;
  } catch (err) {
    console.warn("[Puppeteer] Chrome install failed:", err.message);
    chromeReady = true; // don't retry on every call
  }
}

async function getBrowser() {
  await ensureChrome();
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
  browser.on("disconnected", () => { browser = null; chromeReady = false; });
  return browser;
}

/**
 * Render an HTML string to a JPEG buffer at the given pixel dimensions.
 * Waits for fonts and images to load before screenshotting.
 */
export async function renderHtmlToJpeg(html, width, height) {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 25000 });
    await page.evaluate(() => Promise.all([document.fonts.ready, new Promise(r => window.addEventListener('load', r, { once: true }))]));
    const buf = await page.screenshot({ type: "jpeg", quality: 92, clip: { x: 0, y: 0, width, height } });
    return buf;
  } finally {
    await page.close();
  }
}
