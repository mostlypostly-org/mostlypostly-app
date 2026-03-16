// src/core/puppeteerRenderer.js
// Singleton Puppeteer browser. Renders HTML to JPEG buffer at any canvas size.
// Reuses one browser instance across all requests to avoid cold-start cost.

import puppeteer from "puppeteer";
import { execFileSync } from "child_process";
import { existsSync } from "fs";

let browser = null;
let chromeReady = false;
let launchPromise = null; // mutex — prevents concurrent puppeteer.launch() calls

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
  // Return existing launch promise so concurrent calls share one Chrome instance
  if (launchPromise) return launchPromise;
  launchPromise = puppeteer.launch({
    headless: true,
    timeout: 60000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--single-process",
      "--font-render-hinting=none",
    ],
  }).then(b => {
    browser = b;
    launchPromise = null;
    b.on("disconnected", () => { browser = null; launchPromise = null; chromeReady = false; });
    return b;
  }).catch(err => {
    launchPromise = null;
    throw err;
  });
  return launchPromise;
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
    // Use domcontentloaded — networkidle0 blocks on Google Fonts CDN and times out on Render
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 15000 });
    // Give fonts up to 6s to load; proceed with screenshot even if CDN is slow
    await Promise.race([
      page.evaluate(() => document.fonts.ready),
      new Promise(r => setTimeout(r, 6000)),
    ]);
    const buf = await page.screenshot({ type: "jpeg", quality: 92, clip: { x: 0, y: 0, width, height } });
    return buf;
  } finally {
    await page.close();
  }
}
