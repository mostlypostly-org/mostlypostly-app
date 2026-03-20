// src/core/vendorSync.js
// Automated vendor sync pipeline: Puppeteer portal login → CDP PDF download →
// pdfjs-dist parsing → image download → dedup INSERT OR IGNORE into vendor_campaigns.
//
// Key design decisions:
// - Reuses puppeteerRenderer.js getBrowser() singleton — no second Chrome launch
// - captions stored verbatim with [SALON NAME] placeholder (no AI at import time)
// - INSERT OR IGNORE + UNIQUE index on (vendor_name, campaign_name, release_date) for idempotency
// - source = 'pdf_sync' distinguishes PDF imports from manually created campaigns
// - In-memory syncInProgress map prevents concurrent Puppeteer sessions per vendor

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import fetch from 'node-fetch';
import { getBrowser } from './puppeteerRenderer.js';
import { VENDOR_CONFIGS, getVendorConfig } from './vendorConfigs.js';
import { UPLOADS_DIR } from './uploadPath.js';
import { db } from '../../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Worker required for Node.js — must point to legacy build
pdfjsLib.GlobalWorkerOptions.workerSrc = path.join(
  __dirname,
  '../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'
);

// In-memory sync lock — prevents concurrent Puppeteer sessions against same portal credentials
const syncInProgress = new Map();

// Month name lookup for search keyword template substitution
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Run the vendor sync pipeline for one or all vendors.
 * @param {string|null} vendorName - vendor to sync, or null for all
 * @returns {Array<{ vendor: string, imported: number, skipped: number, error: string|null }>}
 */
export async function runVendorSync(vendorName = null) {
  const configs = vendorName
    ? [getVendorConfig(vendorName)].filter(Boolean)
    : VENDOR_CONFIGS;

  if (vendorName && configs.length === 0) {
    throw new Error(`[VendorSync] Unknown vendor: ${vendorName}`);
  }

  const results = [];

  for (const config of configs) {
    if (syncInProgress.get(config.vendorName)) {
      console.warn(`[VendorSync] ${config.vendorName} sync already in progress — skipping`);
      results.push({ vendor: config.vendorName, imported: 0, skipped: 0, error: 'Sync already in progress' });
      continue;
    }

    syncInProgress.set(config.vendorName, true);
    let imported = 0;
    let skipped = 0;
    let error = null;

    try {
      const result = await syncVendor(config);
      imported = result.imported;
      skipped = result.skipped;

      // Update vendor_brands sync status on success — synchronous, no await
      db.prepare(`
        UPDATE vendor_brands
        SET last_sync_at = ?, last_sync_count = ?, last_sync_error = NULL
        WHERE vendor_name = ?
      `).run(new Date().toISOString(), imported, config.vendorName);

      console.log(`[VendorSync] ${config.vendorName} complete — imported: ${imported}, skipped: ${skipped}`);
    } catch (err) {
      error = err.message;
      console.error(`[VendorSync] ${config.vendorName} error:`, err.message);

      // Update error status — synchronous, no await
      db.prepare(`
        UPDATE vendor_brands SET last_sync_error = ? WHERE vendor_name = ?
      `).run(err.message.slice(0, 500), config.vendorName);
    } finally {
      syncInProgress.delete(config.vendorName);
    }

    results.push({ vendor: config.vendorName, imported, skipped, error });
  }

  return results;
}

/**
 * Full sync pipeline for a single vendor config.
 * @param {import('./vendorConfigs.js').VendorConfig} config
 */
async function syncVendor(config) {
  console.log(`[VendorSync] Starting sync for ${config.vendorName}`);

  // Step 1 — Login + PDF download via Puppeteer CDP
  const pdfPath = await downloadPortalPdf(config);
  console.log(`[VendorSync] PDF downloaded: ${pdfPath}`);

  let campaigns = [];
  const pdfDir = path.dirname(pdfPath);
  try {
    // Step 2 — Parse PDF pages
    campaigns = await parseCampaignPdf(pdfPath, config);
    console.log(`[VendorSync] Parsed ${campaigns.length} campaigns from PDF`);

    // Step 3 — Download campaign images
    for (const campaign of campaigns) {
      if (campaign.imageUrl) {
        try {
          campaign.localImagePath = await downloadCampaignImage(campaign.imageUrl, config);
          console.log(`[VendorSync] Image downloaded for campaign: ${campaign.campaign_name}`);
        } catch (imgErr) {
          console.warn(`[VendorSync] Image download failed for ${campaign.campaign_name}: ${imgErr.message} — continuing without image`);
          campaign.localImagePath = null;
        }
      }
    }

    // Step 4 — Dedup + insert
    return insertCampaigns(campaigns, config);
  } finally {
    // Cleanup temp PDF directory
    try {
      fs.rmSync(pdfDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.warn(`[VendorSync] Temp dir cleanup failed: ${cleanupErr.message}`);
    }
  }
}

/**
 * Login to the vendor portal and download the monthly PDF via Puppeteer CDP.
 * @param {import('./vendorConfigs.js').VendorConfig} config
 * @returns {Promise<string>} absolute path to the downloaded PDF file
 */
async function downloadPortalPdf(config) {
  const user = process.env[config.credentialEnvVars.userEnv];
  const pass = process.env[config.credentialEnvVars.passEnv];

  if (!user || !pass) {
    throw new Error(
      `[VendorSync] Missing credentials: set ${config.credentialEnvVars.userEnv} and ${config.credentialEnvVars.passEnv} env vars`
    );
  }

  const now = new Date();
  const month = MONTH_NAMES[now.getMonth()];
  const year = now.getFullYear();
  const searchKeyword = config.searchKeywordTemplate
    .replace('{MONTH}', month)
    .replace('{YEAR}', String(year));

  const downloadDir = path.join(os.tmpdir(), `vendor-pdf-${Date.now()}`);
  fs.mkdirSync(downloadDir, { recursive: true });

  const browser = await getBrowser();
  const page = await browser.newPage();
  let cdpTimeout; // hoisted so finally block can always clearTimeout

  try {
    // Set up CDP download interception before navigation
    const cdpSession = await page.createCDPSession();
    await cdpSession.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDir,
      eventsEnabled: true,
    });

    // Listen for download completion via CDP event
    // Falls back to file-system polling if CDP events don't fire (--single-process constraint)
    let cdpResolved = false;
    const cdpDownloadPromise = new Promise((resolve, reject) => {
      cdpTimeout = setTimeout(() => {
        if (!cdpResolved) reject(new Error('[VendorSync] PDF download timed out (CDP)'));
      }, 120000);

      cdpSession.on('Browser.downloadProgress', (ev) => {
        if (ev.state === 'completed') {
          cdpResolved = true;
          clearTimeout(cdpTimeout);
          resolve();
        } else if (ev.state === 'canceled') {
          clearTimeout(cdpTimeout);
          reject(new Error('[VendorSync] PDF download canceled'));
        }
      });
    });
    // Prevent unhandled rejection if we exit early (login failure, etc.)
    cdpDownloadPromise.catch(() => {});

    // Navigate to portal login page
    console.log(`[VendorSync] Navigating to portal: ${config.portalUrl}`);
    await page.goto(config.portalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Fill login form — try each selector individually to get a clear error
    const userInput = await page.waitForSelector(config.loginSelectors.userSelector, { timeout: 10000 }).catch(() => null);
    if (!userInput) throw new Error(`[VendorSync] Login email field not found — portal selectors may need updating`);
    await userInput.type(user);

    const passInput = await page.waitForSelector(config.loginSelectors.passSelector, { timeout: 5000 }).catch(() => null);
    if (!passInput) throw new Error(`[VendorSync] Login password field not found`);
    await passInput.type(pass);

    const submitBtn = await page.waitForSelector(config.loginSelectors.submitSelector, { timeout: 5000 }).catch(() => null);
    if (!submitBtn) throw new Error(`[VendorSync] Login submit button not found`);
    await submitBtn.click();
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 });

    console.log(`[VendorSync] Logged in — searching for: ${searchKeyword}`);

    // Search for the current month's social assets
    // Try common search input patterns
    const searchInputSelectors = [
      'input[type="search"]',
      'input[name="search"]',
      'input[name="q"]',
      '#search',
      '[placeholder*="search" i]',
      '[placeholder*="Search" i]',
    ];
    let searchInput = null;
    for (const sel of searchInputSelectors) {
      try {
        searchInput = await page.$(sel);
        if (searchInput) break;
      } catch (_) { /* try next */ }
    }

    if (searchInput) {
      await searchInput.type(searchKeyword);
      await page.keyboard.press('Enter');
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    }

    // Click first matching resource card
    await page.waitForSelector(config.pdfDownloadSelectors.cardSelector, { timeout: 10000 }).catch(() => {});
    const card = await page.$(config.pdfDownloadSelectors.cardSelector);
    if (card) {
      await card.click();
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    }

    // Click the download button to trigger PDF download
    await page.waitForSelector(config.pdfDownloadSelectors.downloadButtonSelector, { timeout: 10000 }).catch(() => {});
    const dlBtn = await page.$(config.pdfDownloadSelectors.downloadButtonSelector);
    if (!dlBtn) {
      throw new Error('[VendorSync] Download button not found on page');
    }
    await dlBtn.click();

    // Wait for download — try CDP event first, fall back to file-system polling
    const pollingPromise = waitForPdfFile(downloadDir, 120000);

    const raceResult = await Promise.race([
      cdpDownloadPromise.then(() => 'cdp'),
      pollingPromise.then(() => 'polling'),
    ]);

    console.log(`[VendorSync] PDF download complete via ${raceResult}`);

    const files = fs.readdirSync(downloadDir).filter(f => f.endsWith('.pdf') && !f.endsWith('.crdownload'));
    if (files.length === 0) {
      throw new Error('[VendorSync] No PDF file found in download directory after download');
    }

    return path.join(downloadDir, files[0]);
  } finally {
    clearTimeout(cdpTimeout);
    await page.close();
  }
}

/**
 * Poll the download directory for a completed PDF file.
 * Fallback for --single-process environments where CDP download events may not fire.
 * @param {string} dir - directory to watch
 * @param {number} timeoutMs
 * @returns {Promise<string>} path to the downloaded PDF
 */
async function waitForPdfFile(dir, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.pdf') && !f.endsWith('.crdownload'));
    if (files.length > 0) return path.join(dir, files[0]);
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('[VendorSync] PDF download timeout (file polling)');
}

/**
 * Parse campaign pages from a downloaded PDF using pdfjs-dist.
 * Skips page 1 (cover). Each subsequent page = one campaign.
 * @param {string} pdfPath
 * @param {import('./vendorConfigs.js').VendorConfig} config
 * @returns {Promise<Array>} array of campaign objects
 */
async function parseCampaignPdf(pdfPath, config) {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({
    data,
    standardFontDataUrl: path.join(
      __dirname,
      '../../node_modules/pdfjs-dist/standard_fonts/'
    ),
  }).promise;

  console.log(`[VendorSync] PDF has ${doc.numPages} pages — skipping page 1 (cover)`);

  const campaigns = [];
  const skipPages = config.pdfParserHints.skipPages || [1];

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    if (skipPages.includes(pageNum)) continue;

    const page = await doc.getPage(pageNum);

    // Extract text with position data
    const textContent = await page.getTextContent();

    // Extract hyperlinks from PDF annotations
    const annotations = await page.getAnnotations();
    const annotationUrls = annotations
      .filter(a => a.subtype === 'Link' && a.url)
      .map(a => a.url);

    // Sort text items by Y position descending (PDF origin is bottom-left)
    const sortedItems = textContent.items.slice().sort((a, b) => {
      const yA = a.transform ? a.transform[5] : 0;
      const yB = b.transform ? b.transform[5] : 0;
      return yB - yA; // descending = top of page first
    });

    // Group items into lines by Y-threshold (items within 3 units = same line)
    const lines = [];
    let currentLine = [];
    let currentY = null;

    for (const item of sortedItems) {
      const y = item.transform ? item.transform[5] : 0;
      if (currentY === null || Math.abs(y - currentY) <= 3) {
        currentLine.push(item.str);
        currentY = y;
      } else {
        if (currentLine.length > 0) {
          const lineText = currentLine.join('').trim();
          if (lineText) lines.push(lineText);
        }
        currentLine = [item.str];
        currentY = y;
      }
    }
    if (currentLine.length > 0) {
      const lineText = currentLine.join('').trim();
      if (lineText) lines.push(lineText);
    }

    // Also scan text lines for URLs as fallback to annotations
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const textUrls = [];
    for (const line of lines) {
      const matches = line.match(urlRegex);
      if (matches) textUrls.push(...matches);
    }

    const allUrls = [...new Set([...annotationUrls, ...textUrls])];

    const campaign = extractCampaignFromPage(lines, allUrls, pageNum, config);
    if (campaign) {
      campaigns.push(campaign);
    }
  }

  return campaigns;
}

/**
 * Extract structured campaign fields from a PDF page's text lines and URLs.
 * Uses layout heuristics: date regex, [SALON NAME] marker, hashtag lines.
 * @param {string[]} lines - text lines sorted top-to-bottom
 * @param {string[]} urls - all URLs from annotations + text
 * @param {number} pageNum
 * @param {import('./vendorConfigs.js').VendorConfig} config
 */
function extractCampaignFromPage(lines, urls, pageNum, config) {
  const hints = config.pdfParserHints;

  // Release date — find in first ~10 lines
  let release_date = null;
  for (const line of lines.slice(0, 10)) {
    const match = line.match(hints.dateRegex);
    if (match) {
      release_date = match[0].trim();
      break;
    }
  }

  // Campaign name — first short line (< 60 chars) in top 5 lines that is NOT the date
  let campaign_name = null;
  for (const line of lines.slice(0, 5)) {
    const trimmed = line.trim();
    if (trimmed.length > 0 && trimmed.length < 60 && trimmed !== release_date) {
      campaign_name = trimmed;
      break;
    }
  }

  // Caption body — the block containing [SALON NAME] or the longest multi-line block
  // Collect lines until hashtag block begins
  let captionLines = [];
  let hashtagLines = [];
  let inHashtags = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith(hints.hashtagMarker)) {
      inHashtags = true;
    }
    if (inHashtags) {
      hashtagLines.push(trimmed);
    } else {
      captionLines.push(trimmed);
    }
  }

  // If no explicit hashtag block found, check last few lines
  if (hashtagLines.length === 0 && captionLines.length > 0) {
    const lastLines = captionLines.slice(-3);
    const hashIdx = lastLines.findIndex(l => l.startsWith('#'));
    if (hashIdx >= 0) {
      hashtagLines = captionLines.slice(captionLines.length - 3 + hashIdx);
      captionLines = captionLines.slice(0, captionLines.length - (3 - hashIdx));
    }
  }

  // Join caption — skip the date line and campaign name line if they appear in caption
  const captionFiltered = captionLines.filter(l =>
    l !== release_date &&
    l !== campaign_name &&
    l.length > 3
  );
  const caption_body = captionFiltered.join('\n').trim() || null;

  // Product hashtag — join all hashtag lines
  const product_hashtag = hashtagLines.join(' ').trim() || null;

  // Image URL — first URL that looks like an image resource (not a login/auth page)
  const imageUrl = urls.find(u => {
    try {
      const parsed = new URL(u);
      // Prefer URLs with image-like extensions or from known asset domains
      const ext = path.extname(parsed.pathname).toLowerCase();
      const isImage = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext);
      const isAssetDomain = parsed.hostname.includes('aveda') || parsed.hostname.includes('cloudfront') ||
        parsed.hostname.includes('cdn') || parsed.hostname.includes('assets');
      return isImage || isAssetDomain;
    } catch (_) {
      return false;
    }
  }) || urls[0] || null;

  if (!campaign_name && !release_date && !caption_body) {
    console.warn(`[VendorSync] Page ${pageNum}: could not extract any fields — skipping`);
    return null;
  }

  return {
    release_date: release_date || `Page ${pageNum}`,
    campaign_name: campaign_name || `Campaign Page ${pageNum}`,
    caption_body,
    product_hashtag,
    imageUrl,
    pageNum,
  };
}

/**
 * Download a campaign image using the configured strategy.
 * 'auto': try HEAD request first; fall back to Puppeteer page-click if not a direct image.
 * 'direct': always use direct fetch.
 * 'page-click': always use Puppeteer (for auth-protected image pages).
 * @param {string} imageUrl
 * @param {import('./vendorConfigs.js').VendorConfig} config
 * @returns {Promise<string>} relative path suitable for photo_url column e.g. /uploads/vendor/aveda/filename.jpg
 */
async function downloadCampaignImage(imageUrl, config) {
  const vendorDir = path.join(UPLOADS_DIR, 'vendor', config.imageSubdir);
  fs.mkdirSync(vendorDir, { recursive: true });

  const urlExt = path.extname(new URL(imageUrl).pathname).toLowerCase();
  const ext = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(urlExt) ? urlExt : '.jpg';
  const filename = `campaign-${Date.now()}-${crypto.randomUUID().slice(0, 8)}${ext}`;
  const filePath = path.join(vendorDir, filename);
  const relativePath = `/uploads/vendor/${config.imageSubdir}/${filename}`;

  const strategy = config.imageDownloadStrategy || 'auto';

  if (strategy === 'direct' || strategy === 'auto') {
    // Try direct fetch first
    try {
      const head = await fetch(imageUrl, { method: 'HEAD', timeout: 10000 });
      const contentType = head.headers.get('content-type') || '';

      if (head.ok && contentType.startsWith('image/')) {
        // Direct download works
        const response = await fetch(imageUrl, { timeout: 30000 });
        const buffer = await response.buffer();
        fs.writeFileSync(filePath, buffer);
        return relativePath;
      }

      // Not a direct image — fall through to Puppeteer if strategy is 'auto'
      if (strategy === 'direct') {
        throw new Error(`[VendorSync] Direct fetch failed — status ${head.status}, content-type: ${contentType}`);
      }
    } catch (fetchErr) {
      if (strategy === 'direct') throw fetchErr;
      console.warn(`[VendorSync] Direct image fetch failed, trying Puppeteer: ${fetchErr.message}`);
    }
  }

  // Puppeteer page-click strategy — navigate to image URL in authenticated session
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    const downloadDir = path.join(os.tmpdir(), `vendor-img-${Date.now()}`);
    fs.mkdirSync(downloadDir, { recursive: true });

    const cdpSession = await page.createCDPSession();
    await cdpSession.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDir,
      eventsEnabled: true,
    });

    const downloadComplete = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('[VendorSync] Image download timed out')), 60000);
      cdpSession.on('Browser.downloadProgress', (ev) => {
        if (ev.state === 'completed') { clearTimeout(timeout); resolve(); }
        if (ev.state === 'canceled') { clearTimeout(timeout); reject(new Error('[VendorSync] Image download canceled')); }
      });
    });

    await page.goto(imageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Try to find and click a download button on the asset page
    const downloadBtnSel = 'a[download], button.download, a.download, [data-action="download"]';
    const dlBtn = await page.$(downloadBtnSel);
    if (dlBtn) {
      await dlBtn.click();
    } else {
      // If no download button, try to get the image directly from the page
      const imgSrc = await page.evaluate(() => {
        const img = document.querySelector('img[src]');
        return img ? img.src : null;
      });
      if (imgSrc) {
        // Download via fetch with page cookies for auth
        const cookies = await page.cookies();
        const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        const response = await fetch(imgSrc, {
          headers: { Cookie: cookieHeader },
          timeout: 30000,
        });
        const buffer = await response.buffer();
        fs.writeFileSync(filePath, buffer);
        return relativePath;
      }
    }

    // Wait for CDP download or file-system polling
    await Promise.race([
      downloadComplete,
      waitForImageFile(downloadDir, 60000),
    ]).catch(() => {});

    const files = fs.readdirSync(downloadDir).filter(f =>
      !f.endsWith('.crdownload') && ['.jpg', '.jpeg', '.png', '.webp', '.gif'].some(e => f.endsWith(e))
    );

    if (files.length > 0) {
      fs.copyFileSync(path.join(downloadDir, files[0]), filePath);
      fs.rmSync(downloadDir, { recursive: true, force: true });
      return relativePath;
    }

    throw new Error('[VendorSync] No image file found after Puppeteer download');
  } finally {
    await page.close();
  }
}

/**
 * Poll directory for an image file (fallback for --single-process CDP event issue).
 */
async function waitForImageFile(dir, timeoutMs = 60000) {
  const imageExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const files = fs.readdirSync(dir).filter(f =>
      !f.endsWith('.crdownload') && imageExts.some(e => f.endsWith(e))
    );
    if (files.length > 0) return path.join(dir, files[0]);
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('[VendorSync] Image download timeout (file polling)');
}

/**
 * Insert parsed campaigns into vendor_campaigns with dedup via INSERT OR IGNORE.
 * Uses the UNIQUE index on (vendor_name, campaign_name, release_date).
 * @param {Array} campaigns
 * @param {import('./vendorConfigs.js').VendorConfig} config
 * @returns {{ imported: number, skipped: number }}
 */
function insertCampaigns(campaigns, config) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO vendor_campaigns
    (id, vendor_name, campaign_name, release_date, caption_body, product_hashtag,
     photo_url, expires_at, frequency_cap, active, source, created_at)
    VALUES
    (@id, @vendor_name, @campaign_name, @release_date, @caption_body, @product_hashtag,
     @photo_url, @expires_at, @frequency_cap, 1, 'pdf_sync', @created_at)
  `);

  let imported = 0;
  let skipped = 0;

  for (const campaign of campaigns) {
    if (!campaign) {
      skipped++;
      continue;
    }

    // Normalize dedup keys
    const campaign_name = (campaign.campaign_name || '').trim();
    const release_date = (campaign.release_date || '').trim();

    // Compute expires_at: 60 days from release_date if parseable, else 30 days from today
    let expires_at = null;
    try {
      const releaseMs = new Date(release_date).getTime();
      if (!isNaN(releaseMs)) {
        const expiry = new Date(releaseMs + 60 * 24 * 60 * 60 * 1000);
        expires_at = expiry.toISOString().slice(0, 10);
      }
    } catch (_) { /* leave null */ }
    // Auto-expiry fallback: if no expiry computed, default to 30 days from today
    if (!expires_at) {
      expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    }

    const campaignData = {
      id: crypto.randomUUID(),
      vendor_name: config.vendorName,
      campaign_name,
      release_date,
      caption_body: campaign.caption_body || null,
      product_hashtag: campaign.product_hashtag || null,
      photo_url: campaign.localImagePath || null,
      expires_at,
      frequency_cap: 3,
      created_at: new Date().toISOString(),
    };

    // INSERT OR IGNORE — synchronous, no await
    const result = stmt.run(campaignData);
    if (result.changes > 0) {
      imported++;
      console.log(`[VendorSync] Inserted: ${campaign_name} (${release_date})`);
    } else {
      skipped++;
      console.log(`[VendorSync] Skipped (already exists): ${campaign_name} (${release_date})`);
    }
  }

  return { imported, skipped };
}
