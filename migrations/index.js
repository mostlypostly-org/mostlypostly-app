// migrations/index.js
// Ordered list of all migrations. Add new ones at the bottom.

import { run as run001 } from "./001_baseline_patches.js";

export const migrations = [
  { name: "001_baseline_patches", run: run001 },
];
