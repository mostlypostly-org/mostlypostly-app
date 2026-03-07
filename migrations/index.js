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

export const migrations = [
  { name: "001_baseline_patches",        run: run001 },
  { name: "002_add_image_urls",          run: run002 },
  { name: "003_stylist_portal_tokens",   run: run003 },
  { name: "004_post_types",             run: run004 },
  { name: "005_manager_profile",         run: run005 },
  { name: "006_brand_palette",           run: run006 },
  { name: "007_post_insights",           run: run007 },
  { name: "008_billing",                 run: run008 },
];
