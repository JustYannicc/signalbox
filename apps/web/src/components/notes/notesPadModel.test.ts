import { describe, expect, it } from "vite-plus/test";

import { addsNote } from "./notesPadModel";

describe("addsNote", () => {
  it("adds on a bare Enter only", () => {
    expect(addsNote({ key: "Enter", shiftKey: false, isComposing: false })).toBe(true);
    expect(addsNote({ key: "Enter", shiftKey: true, isComposing: false })).toBe(false);
    expect(addsNote({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
    expect(addsNote({ key: "a", shiftKey: false, isComposing: false })).toBe(false);
  });
});
