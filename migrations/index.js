// migrations/index.js
// Ordered list of all migrations. Add new ones at the bottom.

import { run as run001 } from "./001_baseline_patches.js";
import { run as run002 } from "./002_add_image_urls.js";
import { run as run003 } from "./003_stylist_portal_tokens.js";
import { run as run004 } from "./004_post_types.js";
import { run as run005 } from "./005_manager_profile.js";
import { run as run006 } from "./006_brand_palette.js";
import { run as run007 } from "./007_post_insights.js";
import { run as run008 } from "./008_billing.js";
import { run as run009 } from "./009_scheduler_policy.js";
import { run as run010 } from "./010_stylist_profiles.js";
import { run as run011 } from "./011_vendor_campaigns.js";
import { run as run012 } from "./012_content_types.js";
import { run as run013 } from "./013_trial_used.js";
import { run as run014 } from "./014_manager_phone_nonunique.js";
import { run as run015 } from "./015_salon_groups.js";
import { run as run016 } from "./016_logo_address.js";
import { run as run017 } from "./017_email_verification.js";
import { run as run018 } from "./018_vendor_approvals.js";
import { run as run019 } from "./019_stock_photo_category.js";
import { run as run020 } from "./020_posting_schedule.js";

export const migrations = [
  { name: "001_baseline_patches",        run: run001 },
  { name: "002_add_image_urls",          run: run002 },
  { name: "003_stylist_portal_tokens",   run: run003 },
  { name: "004_post_types",             run: run004 },
  { name: "005_manager_profile",         run: run005 },
  { name: "006_brand_palette",           run: run006 },
  { name: "007_post_insights",           run: run007 },
  { name: "008_billing",                 run: run008 },
  { name: "009_scheduler_policy",        run: run009 },
  { name: "010_stylist_profiles",        run: run010 },
  { name: "011_vendor_campaigns",        run: run011 },
  { name: "012_content_types",           run: run012 },
  { name: "013_trial_used",              run: run013 },
  { name: "014_manager_phone_nonunique", run: run014 },
  { name: "015_salon_groups",            run: run015 },
  { name: "016_logo_address",            run: run016 },
  { name: "017_email_verification",      run: run017 },
  { name: "018_vendor_approvals",        run: run018 },
  { name: "019_stock_photo_category",   run: run019 },
  { name: "020_posting_schedule",       run: run020 },
];
