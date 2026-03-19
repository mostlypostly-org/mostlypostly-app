// src/core/vendorConfigs.js
// Factory config objects for vendor portal automation.
// Adding a new vendor = one config object here + env vars. No code changes to vendorSync.js.

/**
 * @typedef {Object} VendorConfig
 * @property {string} vendorName — matches vendor_brands.vendor_name
 * @property {string} portalUrl — login/resource page URL
 * @property {{ userSelector: string, passSelector: string, submitSelector: string }} loginSelectors
 * @property {string} searchKeywordTemplate — "{MONTH} {YEAR} Salon Social Media Assets"
 * @property {{ cardSelector: string, downloadButtonSelector: string }} pdfDownloadSelectors
 * @property {'auto'|'direct'|'page-click'} imageDownloadStrategy
 * @property {{ userEnv: string, passEnv: string }} credentialEnvVars
 * @property {string} imageSubdir — subdirectory under public/uploads/vendor/
 * @property {object} pdfParserHints — heuristics for field extraction per page
 */

export const VENDOR_CONFIGS = [
  {
    vendorName: 'Aveda',
    portalUrl: 'https://avedapurepro.com/ResourceLibrary',
    loginSelectors: {
      userSelector: 'input[name="email"], input[type="email"], #email',
      passSelector: 'input[name="password"], input[type="password"], #password',
      submitSelector: 'button[type="submit"], input[type="submit"]',
    },
    searchKeywordTemplate: '{MONTH} {YEAR} Salon Social Media Assets',
    pdfDownloadSelectors: {
      cardSelector: '.resource-card, .card, [data-resource]',
      downloadButtonSelector: 'a[download], button.download, a.download, [data-action="download"]',
    },
    imageDownloadStrategy: 'auto',
    credentialEnvVars: {
      userEnv: 'AVEDA_PORTAL_USER',
      passEnv: 'AVEDA_PORTAL_PASS',
    },
    imageSubdir: 'aveda',
    pdfParserHints: {
      dateRegex: /(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/i,
      hashtagMarker: '#',
      salonNamePlaceholder: '[SALON NAME]',
      skipPages: [1],
    },
  },
];

/**
 * Get config for a specific vendor by name.
 * @param {string} vendorName
 * @returns {VendorConfig|undefined}
 */
export function getVendorConfig(vendorName) {
  return VENDOR_CONFIGS.find(c => c.vendorName === vendorName);
}
