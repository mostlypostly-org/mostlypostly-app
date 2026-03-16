/**
 * seed-vanity-lounge.mjs
 *
 * Populates the local postly.db with a fully-stocked "Vanity Lounge" test salon:
 *  - 1 salon (Pro plan, active)
 *  - 1 manager account (manager@vanitylounge.com / Test1234!)
 *  - 10 stylists with profile photos
 *  - 28 published posts (mix of types) + 8 pending/scheduled queue posts
 *  - post_insights with realistic analytics per published post
 *  - vendor_campaigns for Aveda, Redken, Wella with product photos
 *  - salon_vendor_feeds enabled for all three brands
 *  - gamification_settings + leaderboard token
 *  - salon_vendor_approvals (approved) for all three
 *
 * Run:  node scripts/seed-vanity-lounge.mjs
 * Safe: uses INSERT OR IGNORE — re-runnable without duplication
 */

import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, "..", "postly.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = OFF");

console.log("Seeding Vanity Lounge test data into:", DB_PATH);

const uid         = () => randomUUID();
const now         = () => new Date().toISOString();
const daysAgo     = (n) => new Date(Date.now() - n * 86400000).toISOString();
const daysFromNow = (n) => new Date(Date.now() + n * 86400000).toISOString();

// ── ensure newer tables exist ──────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS gamification_settings (
    id                    TEXT PRIMARY KEY,
    salon_id              TEXT NOT NULL UNIQUE,
    pts_standard_post     INTEGER,
    pts_before_after      INTEGER,
    pts_availability      INTEGER,
    pts_promotions        INTEGER,
    pts_celebration       INTEGER,
    pts_product_education INTEGER,
    pts_vendor_promotion  INTEGER,
    bonus_multiplier      REAL NOT NULL DEFAULT 1.0,
    bonus_active_until    TEXT,
    shortage_threshold    INTEGER NOT NULL DEFAULT 5,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS salon_vendor_approvals (
    id           TEXT PRIMARY KEY,
    salon_id     TEXT NOT NULL,
    vendor_name  TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    proof_file   TEXT,
    notes        TEXT,
    requested_at TEXT,
    reviewed_at  TEXT,
    UNIQUE(salon_id, vendor_name)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS salon_groups (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    owner_manager_id TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

try { db.exec(`ALTER TABLE salons ADD COLUMN leaderboard_token TEXT`); } catch {}
try { db.exec(`ALTER TABLE posts ADD COLUMN post_type TEXT`); } catch {}
try { db.exec(`ALTER TABLE managers ADD COLUMN stylist_id TEXT`); } catch {}

// ── 1. SALON ──────────────────────────────────────────────────────────────

const SALON_SLUG        = "vanity-lounge";
const LEADERBOARD_TOKEN = uid();

const brandPalette = JSON.stringify({
  primary: "#2B2D35", secondary: "#3B72B9",
  accent: "#D4A574", accent_light: "#FDF6EE", cta: "#D4A574",
});

db.prepare(`
  INSERT OR IGNORE INTO salons (
    id, slug, name, phone, city, state, timezone,
    posting_start_time, posting_end_time, spacing_min, spacing_max,
    tone, default_hashtags, booking_url, website,
    require_manager_approval, auto_publish,
    plan, plan_status, trial_used, billing_cycle,
    brand_palette, leaderboard_token,
    instagram_handle, facebook_page_id,
    status, created_at, updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`).run(
  uid(), SALON_SLUG, "Vanity Lounge", "+13175550100", "Carmel", "IN",
  "America/Indiana/Indianapolis", "09:00", "20:00", 90, 240,
  "warm, uplifting, and empowering — like a best friend who happens to be a hair genius",
  JSON.stringify(["#VanityLounge","#CarmelIN","#HairGoals","#SalonLife","#TreatYourself"]),
  "https://vanitylounge.com/book", "https://vanitylounge.com",
  1, 1, "pro", "active", 1, "monthly",
  brandPalette, LEADERBOARD_TOKEN,
  "vanitylounge_carmel", "123456789",
  "active", daysAgo(120), now()
);

db.prepare(`UPDATE salons SET plan='pro', plan_status='active', leaderboard_token=? WHERE slug=?`)
  .run(LEADERBOARD_TOKEN, SALON_SLUG);

console.log("  OK Salon: Vanity Lounge (Pro/active)");

// ── 2. MANAGER ────────────────────────────────────────────────────────────

const MANAGER_ID = uid();
const PASS_HASH  = bcrypt.hashSync("Test1234!", 10);

db.prepare(`
  INSERT OR IGNORE INTO managers (id,salon_id,name,phone,email,password_hash,role,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?)
`).run(MANAGER_ID, SALON_SLUG, "Jordan Vanity", "+13175550200",
  "manager@vanitylounge.com", PASS_HASH, "owner", daysAgo(120), now());

console.log("  OK Manager: manager@vanitylounge.com / Test1234!");

// ── 3. STYLISTS ───────────────────────────────────────────────────────────

const STYLISTS = [
  { name:"Samantha Brooks", ig:"sambrooks.hair",      phone:"+13175550301", photo:"https://images.pexels.com/photos/1181686/pexels-photo-1181686.jpeg?auto=compress&cs=tinysrgb&w=400", specs:["Balayage","Color","Highlights"] },
  { name:"Jessica Lee",     ig:"jess.lee.cuts",       phone:"+13175550302", photo:"https://images.pexels.com/photos/1587009/pexels-photo-1587009.jpeg?auto=compress&cs=tinysrgb&w=400", specs:["Precision Cuts","Blowouts","Extensions"] },
  { name:"Marcus Webb",     ig:"marcuswebb.style",    phone:"+13175550303", photo:"https://images.pexels.com/photos/1681010/pexels-photo-1681010.jpeg?auto=compress&cs=tinysrgb&w=400", specs:["Color","Highlights","Balayage"] },
  { name:"Taylor Kim",      ig:"taylorkim.hair",      phone:"+13175550304", photo:"https://images.pexels.com/photos/1065084/pexels-photo-1065084.jpeg?auto=compress&cs=tinysrgb&w=400", specs:["Keratin","Brazilian Blowout","Treatments"] },
  { name:"Aisha Patel",     ig:"aisha.patel.beauty",  phone:"+13175550305", photo:"https://images.pexels.com/photos/1239291/pexels-photo-1239291.jpeg?auto=compress&cs=tinysrgb&w=400", specs:["Cuts","Color","Bridal"] },
  { name:"Riley Chen",      ig:"riley.chen.salon",    phone:"+13175550306", photo:"https://images.pexels.com/photos/774909/pexels-photo-774909.jpeg?auto=compress&cs=tinysrgb&w=400",   specs:["Balayage","Ombre","Vivid Color"] },
  { name:"Devon Morris",    ig:"devonmorris.cuts",    phone:"+13175550307", photo:"https://images.pexels.com/photos/91227/pexels-photo-91227.jpeg?auto=compress&cs=tinysrgb&w=400",     specs:["Men's Cuts","Fades","Beard Trims"] },
  { name:"Priya Sharma",    ig:"priya.sharma.hair",   phone:"+13175550308", photo:"https://images.pexels.com/photos/1036623/pexels-photo-1036623.jpeg?auto=compress&cs=tinysrgb&w=400", specs:["Extensions","Tape-Ins","Wefts"] },
  { name:"Natalie Ford",    ig:"natalieford.beauty",  phone:"+13175550309", photo:"https://images.pexels.com/photos/1382731/pexels-photo-1382731.jpeg?auto=compress&cs=tinysrgb&w=400", specs:["Highlights","Glossing","Toning"] },
  { name:"Lucas Green",     ig:"lucasgreen.style",    phone:"+13175550310", photo:"https://images.pexels.com/photos/937481/pexels-photo-937481.jpeg?auto=compress&cs=tinysrgb&w=400",   specs:["Color Correction","Vivid","Bleach & Tone"] },
];

const stylistIds = {};
for (const s of STYLISTS) {
  const sid = uid();
  stylistIds[s.name] = sid;
  db.prepare(`
    INSERT OR IGNORE INTO stylists (id,salon_id,name,phone,instagram_handle,specialties,photo_url,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(sid, SALON_SLUG, s.name, s.phone, s.ig,
    JSON.stringify(s.specs), s.photo,
    daysAgo(90 + Math.floor(Math.random() * 30)), now());
}
console.log("  OK Stylists: 10");

// ── 4. HAIR POST PHOTOS (stable Pexels URLs) ───────────────────────────────

const HAIR_PHOTOS = [
  "https://images.pexels.com/photos/3993449/pexels-photo-3993449.jpeg?auto=compress&cs=tinysrgb&w=800",
  "https://images.pexels.com/photos/3993454/pexels-photo-3993454.jpeg?auto=compress&cs=tinysrgb&w=800",
  "https://images.pexels.com/photos/3992853/pexels-photo-3992853.jpeg?auto=compress&cs=tinysrgb&w=800",
  "https://images.pexels.com/photos/3985360/pexels-photo-3985360.jpeg?auto=compress&cs=tinysrgb&w=800",
  "https://images.pexels.com/photos/3997991/pexels-photo-3997991.jpeg?auto=compress&cs=tinysrgb&w=800",
  "https://images.pexels.com/photos/3065171/pexels-photo-3065171.jpeg?auto=compress&cs=tinysrgb&w=800",
  "https://images.pexels.com/photos/3065172/pexels-photo-3065172.jpeg?auto=compress&cs=tinysrgb&w=800",
  "https://images.pexels.com/photos/3768916/pexels-photo-3768916.jpeg?auto=compress&cs=tinysrgb&w=800",
  "https://images.pexels.com/photos/3065209/pexels-photo-3065209.jpeg?auto=compress&cs=tinysrgb&w=800",
  "https://images.pexels.com/photos/3735745/pexels-photo-3735745.jpeg?auto=compress&cs=tinysrgb&w=800",
  "https://images.pexels.com/photos/3993336/pexels-photo-3993336.jpeg?auto=compress&cs=tinysrgb&w=800",
  "https://images.pexels.com/photos/3993450/pexels-photo-3993450.jpeg?auto=compress&cs=tinysrgb&w=800",
];

// ── 5. PUBLISHED POSTS + INSIGHTS ─────────────────────────────────────────

const PUBLISHED_POSTS = [
  { stylist:"Samantha Brooks", type:"before_after_post", ago:3,  ph:0,  reach:4821, likes:312, saves:89,  comments:47, caption:"Fall transformation ✨ Three hours of love — took her from brassy to buttery blonde. Swipe to see the before! #Balayage #FallHair #VanityLounge" },
  { stylist:"Samantha Brooks", type:"standard_post",     ago:8,  ph:1,  reach:3240, likes:198, saves:61,  comments:23, caption:"Warm caramel tones for the season 🍂 This look has been my most requested all month! Book via the link in bio. #CaramelHighlights #SalonCarmel" },
  { stylist:"Samantha Brooks", type:"celebration",       ago:15, ph:2,  reach:5610, likes:487, saves:112, comments:94, caption:"5 years at Vanity Lounge! 🎉 Thank you to every single client who has sat in my chair. You make this job everything. #SalonAnniversary" },
  { stylist:"Samantha Brooks", type:"before_after_post", ago:22, ph:3,  reach:6102, likes:521, saves:143, comments:67, caption:"Color correction done RIGHT 😍 Four hours, zero compromise. Heavily box-dyed to seamless natural brunette. The result speaks for itself. #ColorCorrection" },
  { stylist:"Jessica Lee",     type:"standard_post",     ago:2,  ph:4,  reach:2980, likes:167, saves:44,  comments:31, caption:"The perfect bob is a vibe 💇‍♀️ Sharp lines, soft texture — made for her face shape. Booking open! Link in bio. #BobHaircut #CarmelSalon" },
  { stylist:"Jessica Lee",     type:"before_after_post", ago:10, ph:5,  reach:4130, likes:284, saves:78,  comments:52, caption:"Before and after this pixie cut 🤩 My client wanted a major change and she absolutely nailed it. Obsessed. #PixieCut #HairTransformation" },
  { stylist:"Jessica Lee",     type:"availability",      ago:5,  ph:6,  reach:1840, likes:94,  saves:22,  comments:18, caption:"Good news — openings this Thursday and Friday afternoon! Balayage, cuts, and color available. DM or book at the link 🔗 #NowBooking" },
  { stylist:"Jessica Lee",     type:"standard_post",     ago:18, ph:7,  reach:2210, likes:143, saves:37,  comments:19, caption:"Blowout goals 🌬️ There is nothing like a fresh blowout to make you feel like a million dollars. Come in and let me work my magic! #Blowout" },
  { stylist:"Marcus Webb",     type:"before_after_post", ago:4,  ph:8,  reach:3890, likes:241, saves:66,  comments:38, caption:"Sun-kissed vibes even in fall 🌟 Balayage plus toner for that perfect lived-in blonde. Five hours — absolutely worth it. #Balayage #VanityLounge" },
  { stylist:"Marcus Webb",     type:"standard_post",     ago:11, ph:9,  reach:2760, likes:178, saves:49,  comments:27, caption:"Rich brunette with gold undertones — everything cozy season 🍁 Custom formula mixed just for her skin tone. #BrunetteHighlights #CustomColor" },
  { stylist:"Marcus Webb",     type:"promotions",        ago:7,  ph:10, reach:3420, likes:212, saves:71,  comments:43, caption:"Fall Color Special: 20% off all balayage services through November! This is the glow-up you have been waiting for. Book fast — spots are filling up! #FallSpecial" },
  { stylist:"Marcus Webb",     type:"before_after_post", ago:25, ph:11, reach:5240, likes:398, saves:118, comments:72, caption:"The transformation that stopped the team in its tracks 😱 Heavily bleached to healthy glossy brunette. Color correction at its finest. #ColorCorrection" },
  { stylist:"Taylor Kim",      type:"standard_post",     ago:6,  ph:0,  reach:2180, likes:134, saves:41,  comments:22, caption:"Keratin treatment results after 48 hours ✨ Frizz? What frizz? This is what we call salon-smooth. Book your treatment via link in bio! #Keratin" },
  { stylist:"Taylor Kim",      type:"promotions",        ago:13, ph:1,  reach:2940, likes:175, saves:53,  comments:34, caption:"Treat yourself to a Brazilian Blowout this weekend! $50 off when you mention this post. Call to book 💆‍♀️ #BrazilianBlowout #HairTreatment" },
  { stylist:"Aisha Patel",     type:"before_after_post", ago:9,  ph:2,  reach:4560, likes:367, saves:124, comments:58, caption:"Bridal prep ✨ Soft romantic curls with a half-up style for this gorgeous bride. She was absolutely glowing! #BridalHair #WeddingReady" },
  { stylist:"Aisha Patel",     type:"standard_post",     ago:16, ph:3,  reach:1980, likes:121, saves:32,  comments:14, caption:"Going into the weekend like 💁‍♀️ Fresh cut and color. Nothing better than feeling like your best self on a Friday! #FridayVibes #CarmelIN" },
  { stylist:"Riley Chen",      type:"before_after_post", ago:3,  ph:4,  reach:5120, likes:412, saves:134, comments:61, caption:"Sunset balayage ombre 🌅 Hand-painted colors from root to tip. Bold, beautiful, unapologetic. This is Riley's specialty! #SunsetHair #OmbreHair" },
  { stylist:"Riley Chen",      type:"standard_post",     ago:19, ph:5,  reach:3180, likes:234, saves:67,  comments:41, caption:"Vivid purple toning refresh 💜 Regular toning appointments keep this look exactly where we want it. Book your refresh! #PurpleHair #VividColor" },
  { stylist:"Devon Morris",    type:"standard_post",     ago:5,  ph:6,  reach:2640, likes:158, saves:39,  comments:26, caption:"Clean fade with a textured top 🔥 Devon's detail work is always elite. Ready to upgrade your look? Book Devon today! #MensCuts #FadeHaircut" },
  { stylist:"Devon Morris",    type:"standard_post",     ago:14, ph:7,  reach:2020, likes:128, saves:31,  comments:17, caption:"Taper plus beard sculpt combo 🧔 The full package. Devon's calendar is filling up fast for November! #BeardGoals #BarberStyle" },
  { stylist:"Priya Sharma",    type:"before_after_post", ago:7,  ph:8,  reach:4210, likes:321, saves:98,  comments:49, caption:"Tape-in extensions: before and after 😍 Added length AND volume in under 2 hours. Taking extension consultations now! #HairExtensions #TapeIns" },
  { stylist:"Priya Sharma",    type:"standard_post",     ago:20, ph:9,  reach:2840, likes:187, saves:54,  comments:31, caption:"Seamless weft install 💛 You would literally never know these are not her own locks. Flawless. #WeftExtensions #VanityLounge" },
  { stylist:"Natalie Ford",    type:"standard_post",     ago:6,  ph:10, reach:3010, likes:198, saves:57,  comments:36, caption:"Dimensional highlights for days ✨ Every strand placed with intention. Natalie's highlight work is second to none. Book now! #Highlights" },
  { stylist:"Natalie Ford",    type:"before_after_post", ago:12, ph:11, reach:3740, likes:267, saves:82,  comments:44, caption:"Glossing service transformation 🌟 From dull and brassy to bright, shiny, and vibrant in one visit. Why would you not? #GlossingService" },
  { stylist:"Lucas Green",     type:"before_after_post", ago:2,  ph:0,  reach:7140, likes:589, saves:201, comments:97, caption:"The color correction that took 7 hours 😤 Chunky pink and purple box dye to soft natural blonde. Lucas literally performed a miracle. #ColorCorrection" },
  { stylist:"Lucas Green",     type:"standard_post",     ago:10, ph:1,  reach:4820, likes:361, saves:108, comments:63, caption:"Vivid teal fade 💚 Living for this unexpected combo. Lucas is taking vivid color consultations for November! #VividColor #TealHair" },
  { stylist:"Lucas Green",     type:"standard_post",     ago:21, ph:2,  reach:6240, likes:487, saves:164, comments:78, caption:"Cotton candy dreams 🩷💙 The boldest color work we have done all month and we are absolutely obsessed. #CottonCandyHair #BoldColor" },
  { stylist:"Lucas Green",     type:"celebration",       ago:28, ph:3,  reach:5890, likes:441, saves:131, comments:88, caption:"Lucas just won Stylist of the Month at Vanity Lounge! 🏆 Crushing it every single week — we are SO proud. Congrats Lucas! #StylistSpotlight" },
];

let postNum = 100;
for (const p of PUBLISHED_POSTS) {
  const pid     = uid();
  const sid     = stylistIds[p.stylist];
  const pubDate = daysAgo(p.ago);
  postNum++;

  db.prepare(`
    INSERT OR IGNORE INTO posts (
      id, salon_id, stylist_id, stylist_name, image_url,
      base_caption, final_caption, status, post_type,
      published_at, scheduled_for, salon_post_number,
      fb_post_id, ig_media_id, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    pid, SALON_SLUG, sid, p.stylist, HAIR_PHOTOS[p.ph],
    p.caption, p.caption, "published", p.type,
    pubDate, pubDate, postNum,
    `${1000000 + postNum}_${Math.floor(Math.random() * 9000000)}`,
    `${10000000000 + postNum * 1000}`,
    pubDate, now()
  );

  // Facebook insights
  const fbReach   = Math.floor(p.reach * 0.65);
  const fbLikes   = Math.floor(p.likes * 0.6);
  const fbEngaged = Math.floor((p.likes + p.comments + Math.floor(p.likes * 0.08)) * 0.65);
  db.prepare(`
    INSERT OR IGNORE INTO post_insights (id,post_id,salon_id,platform,reach,impressions,likes,reactions,comments,shares,engaged_users,link_clicks,engagement_rate,fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    uid(), pid, SALON_SLUG, "facebook",
    fbReach, Math.floor(fbReach * 1.4),
    Math.floor(p.likes * 0.36), fbLikes,
    Math.floor(p.comments * 0.55),
    Math.floor(p.likes * 0.08),
    fbEngaged, Math.floor(fbEngaged * 0.12),
    parseFloat(((fbEngaged / fbReach) * 100).toFixed(2)), now()
  );

  // Instagram insights
  const igReach   = Math.floor(p.reach * 0.35);
  const igLikes   = Math.floor(p.likes * 0.4);
  const igEngaged = Math.floor((p.likes + p.saves + p.comments) * 0.35);
  db.prepare(`
    INSERT OR IGNORE INTO post_insights (id,post_id,salon_id,platform,reach,impressions,likes,saves,comments,engaged_users,engagement_rate,fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    uid(), pid, SALON_SLUG, "instagram",
    igReach, Math.floor(igReach * 1.3),
    igLikes, Math.floor(p.saves * 0.8),
    Math.floor(p.comments * 0.45),
    igEngaged,
    parseFloat(((igEngaged / igReach) * 100).toFixed(2)), now()
  );
}
console.log(`  OK Published posts: ${PUBLISHED_POSTS.length} with FB+IG insights`);

// ── 6. QUEUE POSTS ────────────────────────────────────────────────────────

const QUEUE_POSTS = [
  { stylist:"Samantha Brooks", type:"before_after_post", ph:4,  hours:18, status:"manager_approved", caption:"Just finished this stunning dimensional balayage 🌟 Dropping tomorrow! #Balayage #HairGoals" },
  { stylist:"Jessica Lee",     type:"standard_post",     ph:5,  hours:30, status:"manager_approved", caption:"Openings this Tuesday and Wednesday! Balayage, cuts, and color. Book before they are gone! #OpenBooking" },
  { stylist:"Marcus Webb",     type:"promotions",        ph:6,  hours:48, status:"manager_approved", caption:"Halloween Hair Event! Free colored streak with any color service Oct 28-31. Limited spots! #HalloweenHair" },
  { stylist:"Riley Chen",      type:"before_after_post", ph:7,  hours:66, status:"manager_approved", caption:"This pinky blonde balayage 🌸 She came in nervous and left absolutely obsessed. #PinkyBlonde" },
  { stylist:"Taylor Kim",      type:"standard_post",     ph:8,  hours:84, status:"manager_approved", caption:"Keratin plus gloss equals the smoothest hair you have ever felt 😍 Ask me about my signature package! #Keratin" },
  { stylist:"Lucas Green",     type:"before_after_post", ph:9,  hours:0,  status:"manager_pending",  caption:"Fixing a DIY disaster into a dream 💫 Color correction took everything I had and I am SO proud of the result. #ColorCorrection" },
  { stylist:"Aisha Patel",     type:"standard_post",     ph:10, hours:0,  status:"manager_pending",  caption:"Holiday booking is officially open! 🎄 Secure your December appointment now — my calendar fills up FAST. #HolidayHair" },
  { stylist:"Priya Sharma",    type:"availability",      ph:11, hours:0,  status:"manager_pending",  caption:"Three openings this Friday for extensions! Tape-ins and hand-tied wefts available. Book now at the link in bio. #HairExtensions" },
];

postNum = 200;
for (const p of QUEUE_POSTS) {
  postNum++;
  const scheduledFor = p.hours > 0
    ? new Date(Date.now() + p.hours * 3600000).toISOString()
    : null;
  db.prepare(`
    INSERT OR IGNORE INTO posts (id,salon_id,stylist_id,stylist_name,image_url,base_caption,final_caption,status,post_type,scheduled_for,salon_post_number,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    uid(), SALON_SLUG, stylistIds[p.stylist], p.stylist, HAIR_PHOTOS[p.ph],
    p.caption, p.caption, p.status, p.type,
    scheduledFor, postNum, now(), now()
  );
}
console.log("  OK Queue: 8 posts (5 scheduled + 3 pending approval)");

// ── 7. VENDOR CAMPAIGNS ───────────────────────────────────────────────────

const VENDOR_CAMPAIGNS = [
  {
    vendor:"Aveda", campaign:"Botanical Repair Spring Campaign",
    product:"Botanical Repair Strengthening Bond Serum",
    desc:"Powered by plant-based technology, this professional bond-building serum repairs hair damage from the inside out. Instantly stronger, visibly healthier hair after just one treatment.",
    photo:"https://images.pexels.com/photos/3735783/pexels-photo-3735783.jpeg?auto=compress&cs=tinysrgb&w=600",
    tags:"#Aveda #BotanicalRepair #HairRepair #HealthyHair #PlantBased",
    tone:"educational and inspiring — celebrate healthy, naturally beautiful hair",
    cta:"Ask about the Aveda Botanical Repair treatment and book a complimentary consultation",
    service:"Pairs beautifully with any color service or as a standalone treatment for damaged hair",
    expires:daysFromNow(60), cap:4,
  },
  {
    vendor:"Aveda", campaign:"Invati Ultra Advanced",
    product:"Invati Ultra Advanced Scalp System",
    desc:"Clinically proven to reduce hair loss due to breakage by 64%. The full 3-step system is a salon game-changer for thinning hair clients.",
    photo:"https://images.pexels.com/photos/3996335/pexels-photo-3996335.jpeg?auto=compress&cs=tinysrgb&w=600",
    tags:"#Aveda #InvatiUltra #HairLoss #ScalpHealth #ThickerHair",
    tone:"confident and scientific — real results for real clients",
    cta:"Mention this post for a complimentary scalp consultation when you book",
    service:"Especially effective when combined with scalp massage treatments",
    expires:daysFromNow(45), cap:3,
  },
  {
    vendor:"Redken", campaign:"Acidic Bonding Concentrate",
    product:"Acidic Bonding Concentrate Intensive Treatment",
    desc:"The number 1 bond repair treatment in salons. Restores bonds, smooths cuticle, and delivers insane shine in just one in-salon service.",
    photo:"https://images.pexels.com/photos/3765147/pexels-photo-3765147.jpeg?auto=compress&cs=tinysrgb&w=600",
    tags:"#Redken #AcidicBonding #BondRepair #HealthyHair #SalonResults",
    tone:"bold and results-driven — Redken is science-backed, stylist-trusted",
    cta:"Ask us about adding an Acidic Bonding Concentrate treatment to your next color service",
    service:"Essential addition to any color or lightening service",
    expires:daysFromNow(90), cap:4,
  },
  {
    vendor:"Redken", campaign:"Color Extend Magnetics",
    product:"Color Extend Magnetics Shampoo and Conditioner",
    desc:"Magnetic technology attracts and deposits color-protecting molecules into the hair shaft. Keep color-treated hair vibrant, nourished, and protected between visits.",
    photo:"https://images.pexels.com/photos/5069432/pexels-photo-5069432.jpeg?auto=compress&cs=tinysrgb&w=600",
    tags:"#Redken #ColorExtend #ColorProtection #ColorTreatedHair #VibrancyBoost",
    tone:"vibrant and playful — celebrate the beauty of color-treated hair",
    cta:"Take home Color Extend Magnetics for $5 off when you book a color service this month",
    service:"Recommend to every color client to maintain vibrancy between visits",
    expires:daysFromNow(75), cap:5,
  },
  {
    vendor:"Wella", campaign:"Fusion Intensive Repair Treatment",
    product:"Wella Professionals Fusion Intense Repair Treatment",
    desc:"Amino Refill Technology penetrates deep into the hair structure to rebuild fragile bonds. One treatment delivers up to 95% less breakage.",
    photo:"https://images.pexels.com/photos/3737586/pexels-photo-3737586.jpeg?auto=compress&cs=tinysrgb&w=600",
    tags:"#Wella #WellaProfessionals #FusionRepair #HairRepair #BondBuilding",
    tone:"luxurious and professional — Wella is a legacy of color innovation",
    cta:"Book a Fusion Intense Repair Treatment and see the difference in one session",
    service:"Perfect add-on for bleach, color, and chemical service clients",
    expires:daysFromNow(60), cap:4,
  },
  {
    vendor:"Wella", campaign:"Ultimate Repair Miracle Hair Rescue",
    product:"Ultimate Repair Miracle Hair Rescue",
    desc:"The most advanced in-salon repair treatment from Wella. 15-minute express or 45-minute intensive — both deliver dramatically smoother, stronger, glossier hair. Results are immediate.",
    photo:"https://images.pexels.com/photos/3768916/pexels-photo-3768916.jpeg?auto=compress&cs=tinysrgb&w=600",
    tags:"#Wella #UltimateRepair #MiracleRescue #HairTransformation #GlossyHair",
    tone:"dramatic and aspirational — hair miracles are real at Vanity Lounge",
    cta:"Ask your stylist about adding the Ultimate Repair Miracle service to your appointment",
    service:"Works on all hair types — perfect for damaged, brittle, or breakage-prone hair",
    expires:daysFromNow(90), cap:3,
  },
];

for (const c of VENDOR_CAMPAIGNS) {
  db.prepare(`
    INSERT OR IGNORE INTO vendor_campaigns (id,vendor_name,campaign_name,product_name,product_description,photo_url,hashtags,tone_direction,cta_instructions,service_pairing_notes,expires_at,frequency_cap,active,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(uid(), c.vendor, c.campaign, c.product, c.desc, c.photo, c.tags, c.tone, c.cta, c.service, c.expires, c.cap, 1, now());
}
console.log("  OK Vendor campaigns: 6 (Aveda x2, Redken x2, Wella x2)");

// ── 8. VENDOR FEEDS + APPROVALS ───────────────────────────────────────────

for (const vendor of ["Aveda","Redken","Wella"]) {
  db.prepare(`INSERT OR IGNORE INTO salon_vendor_feeds (id,salon_id,vendor_name,enabled,created_at) VALUES (?,?,?,?,?)`)
    .run(uid(), SALON_SLUG, vendor, 1, daysAgo(30));
  db.prepare(`INSERT OR IGNORE INTO salon_vendor_approvals (id,salon_id,vendor_name,status,requested_at,reviewed_at) VALUES (?,?,?,?,?,?)`)
    .run(uid(), SALON_SLUG, vendor, "approved", daysAgo(45), daysAgo(40));
}
console.log("  OK Vendor feeds: Aveda, Redken, Wella — enabled + approved");

// ── 9. GAMIFICATION ───────────────────────────────────────────────────────

db.prepare(`
  INSERT OR IGNORE INTO gamification_settings (id,salon_id,pts_standard_post,pts_before_after,pts_availability,pts_promotions,pts_celebration,pts_product_education,pts_vendor_promotion,bonus_multiplier,shortage_threshold,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
`).run(uid(), SALON_SLUG, 10, 20, 15, 12, 18, 14, 11, 1.0, 5, now(), now());
console.log("  OK Gamification settings");

db.close();

const totalReach = PUBLISHED_POSTS.reduce((s,p)=>s+p.reach,0);
const totalLikes = PUBLISHED_POSTS.reduce((s,p)=>s+p.likes,0);
console.log("\nSeed complete! Summary:");
console.log("  Salon:       Vanity Lounge (vanity-lounge) — Pro/active");
console.log("  Login:       manager@vanitylounge.com / Test1234!");
console.log("  Stylists:    10");
console.log(`  Posts:       ${PUBLISHED_POSTS.length} published + 8 queued`);
console.log(`  Reach:       ${totalReach.toLocaleString()} total`);
console.log(`  Likes:       ${totalLikes.toLocaleString()} total`);
console.log("  Vendors:     Aveda, Redken, Wella (6 campaigns, all enabled)");
