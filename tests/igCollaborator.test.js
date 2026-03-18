// tests/igCollaborator.test.js
import { describe, it, expect } from "vitest";
import { buildCollaborators } from "../src/publishers/instagram.js";

describe("buildCollaborators", () => {
  it("returns handle in array when ig_collab=1 and handle exists", () => {
    const stylist = { ig_collab: 1, instagram_handle: "janedoe" };
    expect(buildCollaborators(stylist)).toEqual(["janedoe"]);
  });

  it("strips leading @ from handle", () => {
    const stylist = { ig_collab: 1, instagram_handle: "@janedoe" };
    expect(buildCollaborators(stylist)[0]).toBe("janedoe");
  });

  it("returns undefined when ig_collab=0", () => {
    const stylist = { ig_collab: 0, instagram_handle: "janedoe" };
    expect(buildCollaborators(stylist)).toBeUndefined();
  });

  it("returns undefined when handle is empty", () => {
    const stylist = { ig_collab: 1, instagram_handle: "" };
    expect(buildCollaborators(stylist)).toBeUndefined();
  });

  it("returns undefined when stylist is null", () => {
    expect(buildCollaborators(null)).toBeUndefined();
  });
});
