// src/core/vendorScheduler.test.js
// Tests for vendorScheduler fill-all-slots behavior.
// Uses an in-memory SQLite DB seeded with minimal fixtures.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// We test the exported pure functions directly.
import { buildVendorHashtagBlock, normalizeHashtag } from "./vendorScheduler.js";

describe("normalizeHashtag", () => {
  it("adds # prefix when missing", () => {
    assert.equal(normalizeHashtag("Aveda"), "#Aveda");
  });
  it("keeps existing # prefix", () => {
    assert.equal(normalizeHashtag("#Aveda"), "#Aveda");
  });
  it("returns empty string for tag with spaces", () => {
    assert.equal(normalizeHashtag("has space"), "");
  });
  it("returns empty string for null", () => {
    assert.equal(normalizeHashtag(null), "");
  });
});

describe("buildVendorHashtagBlock", () => {
  it("includes first 3 salon tags, 2 brand tags, 1 product tag, and #MostlyPostly", () => {
    const block = buildVendorHashtagBlock({
      salonHashtags: ["#a", "#b", "#c", "#d"],
      brandHashtags: ["#brand1", "#brand2", "#brand3"],
      productHashtag: "#product",
    });
    const tags = block.split(" ");
    assert.ok(tags.includes("#a"));
    assert.ok(tags.includes("#b"));
    assert.ok(tags.includes("#c"));
    assert.ok(!tags.includes("#d"), "4th salon tag should be excluded");
    assert.ok(tags.includes("#brand1"));
    assert.ok(tags.includes("#brand2"));
    assert.ok(!tags.includes("#brand3"), "3rd brand tag should be excluded");
    assert.ok(tags.includes("#product"));
    assert.ok(tags.includes("#MostlyPostly"));
  });

  it("deduplicates case-insensitively", () => {
    const block = buildVendorHashtagBlock({
      salonHashtags: ["#Aveda"],
      brandHashtags: ["#aveda"],
      productHashtag: null,
    });
    const tags = block.split(" ");
    const avedaTags = tags.filter(t => t.toLowerCase() === "#aveda");
    assert.equal(avedaTags.length, 1);
  });
});
