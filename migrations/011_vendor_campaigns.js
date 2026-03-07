// migrations/011_vendor_campaigns.js
// Creates vendor_campaigns (MostlyPostly-managed brand content) and
// salon_vendor_feeds (per-salon opt-in per vendor brand).

export function run(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vendor_campaigns (
      id                    TEXT PRIMARY KEY,
      vendor_name           TEXT NOT NULL,
      campaign_name         TEXT NOT NULL,
      product_name          TEXT,
      product_description   TEXT,
      photo_url             TEXT,
      hashtags              TEXT,         -- JSON array e.g. ["#AvedaColor","#FullSpectrum"]
      tone_direction        TEXT,         -- e.g. "professional and educational"
      cta_instructions      TEXT,         -- e.g. "Ask about our Aveda color menu"
      service_pairing_notes TEXT,         -- e.g. "Pairs well with balayage"
      expires_at            TEXT,         -- YYYY-MM-DD — scheduler won't post after this date
      frequency_cap         INTEGER DEFAULT 4,  -- max posts per month from this campaign
      active                INTEGER DEFAULT 1,  -- 0 = paused by MostlyPostly team
      created_at            TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS salon_vendor_feeds (
      id          TEXT PRIMARY KEY,
      salon_id    TEXT NOT NULL,
      vendor_name TEXT NOT NULL,
      enabled     INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now')),
      UNIQUE(salon_id, vendor_name)
    )
  `);

  console.log("✅ [Migration 011] vendor_campaigns + salon_vendor_feeds created");
}
