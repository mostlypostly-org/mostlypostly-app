export const DEFAULT_PLACEMENT = {
  before_after: "reel",
  standard_post: "post",
  vendor_product: "story",
  vendor_promotion: "story",
  reviews: "post",
  education: "reel",
  celebration: "post",
  stylist_availability: "story",
};

// Content types that should never publish to GMB regardless of placement
const GMB_EXCLUDED = new Set(["reviews", "stylist_availability"]);

// Platforms reached by each placement (before content-type overrides)
const PLACEMENT_PLATFORMS = {
  reel: ["instagram", "facebook", "tiktok"],
  post: ["instagram", "facebook", "gmb"],
  story: ["instagram", "facebook"],
};

export function getDefaultPlacement(contentType) {
  return DEFAULT_PLACEMENT[contentType] || "post";
}

export function deriveFromPostType(postType) {
  if (["availability", "promotions", "celebration_story"].includes(postType)) return "story";
  if (postType === "reel") return "reel";
  return "post";
}

export function mapVendorCampaignType(campaignType) {
  return campaignType === "Promotion" ? "vendor_promotion" : "vendor_product";
}

export function getPlatformReach(placement, contentType) {
  let platforms = [...(PLACEMENT_PLATFORMS[placement] || ["instagram", "facebook"])];

  if (GMB_EXCLUDED.has(contentType)) {
    platforms = platforms.filter((p) => p !== "gmb");
  }

  if (contentType === "vendor_promotion" && !platforms.includes("gmb")) {
    platforms.push("gmb");
  }

  return platforms;
}
