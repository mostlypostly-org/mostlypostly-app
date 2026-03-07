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
];
