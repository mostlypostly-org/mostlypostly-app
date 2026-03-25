import { describe, it, expect } from "vitest";
import {
  getDefaultPlacement,
  deriveFromPostType,
  mapVendorCampaignType,
  getPlatformReach,
} from "../../src/core/contentType.js";

describe("getDefaultPlacement", () => {
  it("returns reel for before_after", () => expect(getDefaultPlacement("before_after")).toBe("reel"));
  it("returns post for standard_post", () => expect(getDefaultPlacement("standard_post")).toBe("post"));
  it("returns story for vendor_product", () => expect(getDefaultPlacement("vendor_product")).toBe("story"));
  it("returns story for vendor_promotion", () => expect(getDefaultPlacement("vendor_promotion")).toBe("story"));
  it("returns post for reviews", () => expect(getDefaultPlacement("reviews")).toBe("post"));
  it("returns reel for education", () => expect(getDefaultPlacement("education")).toBe("reel"));
  it("returns post for celebration", () => expect(getDefaultPlacement("celebration")).toBe("post"));
  it("returns story for stylist_availability", () => expect(getDefaultPlacement("stylist_availability")).toBe("story"));
  it("defaults unknown to post", () => expect(getDefaultPlacement("unknown_type")).toBe("post"));
});

describe("deriveFromPostType", () => {
  it("maps availability to story", () => expect(deriveFromPostType("availability")).toBe("story"));
  it("maps promotions to story", () => expect(deriveFromPostType("promotions")).toBe("story"));
  it("maps celebration_story to story", () => expect(deriveFromPostType("celebration_story")).toBe("story"));
  it("maps reel to reel", () => expect(deriveFromPostType("reel")).toBe("reel"));
  it("maps standard_post to post", () => expect(deriveFromPostType("standard_post")).toBe("post"));
  it("maps before_after_post to post", () => expect(deriveFromPostType("before_after_post")).toBe("post"));
  it("defaults unknown to post", () => expect(deriveFromPostType("other")).toBe("post"));
});

describe("mapVendorCampaignType", () => {
  it("maps Promotion to vendor_promotion", () => expect(mapVendorCampaignType("Promotion")).toBe("vendor_promotion"));
  it("maps Standard to vendor_product", () => expect(mapVendorCampaignType("Standard")).toBe("vendor_product"));
  it("maps Educational to vendor_product", () => expect(mapVendorCampaignType("Educational")).toBe("vendor_product"));
  it("maps Product Launch to vendor_product", () => expect(mapVendorCampaignType("Product Launch")).toBe("vendor_product"));
  it("maps anything else to vendor_product", () => expect(mapVendorCampaignType("Mystery")).toBe("vendor_product"));
});

describe("getPlatformReach", () => {
  it("reel reaches IG, FB, TikTok", () => {
    expect(getPlatformReach("reel", "before_after")).toEqual(
      expect.arrayContaining(["instagram", "facebook", "tiktok"])
    );
  });
  it("story does not reach GMB or TikTok", () => {
    const reach = getPlatformReach("story", "vendor_product");
    expect(reach).not.toContain("gmb");
    expect(reach).not.toContain("tiktok");
  });
  it("post reaches IG, FB, GMB", () => {
    const reach = getPlatformReach("post", "standard_post");
    expect(reach).toContain("instagram");
    expect(reach).toContain("facebook");
    expect(reach).toContain("gmb");
  });
  it("vendor_promotion on story also reaches GMB", () => {
    const reach = getPlatformReach("story", "vendor_promotion");
    expect(reach).toContain("gmb");
  });
  it("reviews on post does NOT reach GMB", () => {
    const reach = getPlatformReach("post", "reviews");
    expect(reach).not.toContain("gmb");
  });
  it("stylist_availability on story does NOT reach GMB", () => {
    const reach = getPlatformReach("story", "stylist_availability");
    expect(reach).not.toContain("gmb");
  });
});
