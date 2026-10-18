import { describe, expect, it } from "vite-plus/test";

import {
  captureTitle,
  findFolderTrigger,
  isOpenDraftShortcut,
  rankByLabel,
  removeTriggerText,
} from "@t3tools/client-runtime/capture/text";

describe("findFolderTrigger", () => {
  it("finds the #query the caret is in, at the start or after whitespace", () => {
    expect(findFolderTrigger("#wo", 3)).toEqual({ query: "wo", start: 0, end: 3 });
    expect(findFolderTrigger("fix login #cli", 14)).toEqual({ query: "cli", start: 10, end: 14 });
    expect(findFolderTrigger("fix\n#", 5)).toEqual({ query: "", start: 4, end: 5 });
  });

  it("ignores # inside a word, after the token ended, and before the caret moved in", () => {
    expect(findFolderTrigger("issue#12", 8)).toBeNull();
    expect(findFolderTrigger("#work done", 10)).toBeNull();
    expect(findFolderTrigger("#work done", 2)).toEqual({ query: "w", start: 0, end: 2 });
  });
});

describe("removeTriggerText", () => {
  it("drops the typed tag without leaving a double space", () => {
    const text = "fix #cli login";
    const trigger = findFolderTrigger(text, 8)!;
    expect(removeTriggerText(text, trigger)).toEqual({ text: "fix login", caret: 4 });
  });

  it("handles a tag at the very start", () => {
    const trigger = findFolderTrigger("#cli", 4)!;
    expect(removeTriggerText("#cli", trigger)).toEqual({ text: "", caret: 0 });
  });
});

describe("rankByLabel", () => {
  const folders = [
    { label: "Work" },
    { label: "Work / Clients" },
    { label: "Personal / Taxes" },
    { label: "Homework" },
  ];

  it("ranks segment-prefix matches before substring ones", () => {
    expect(rankByLabel(folders, "wo", 5).map((folder) => folder.label)).toEqual([
      "Work",
      "Work / Clients",
      "Homework",
    ]);
    expect(rankByLabel(folders, "cli", 5).map((folder) => folder.label)).toEqual([
      "Work / Clients",
    ]);
  });

  it("keeps tree order for an empty query and respects the limit", () => {
    expect(rankByLabel(folders, " ", 2).map((folder) => folder.label)).toEqual([
      "Work",
      "Work / Clients",
    ]);
  });
});

describe("isOpenDraftShortcut", () => {
  const enter = { key: "Enter", metaKey: false, ctrlKey: false, shiftKey: false };

  it("is ⌘↵ on Mac and Ctrl+↵ elsewhere, never with Shift", () => {
    expect(isOpenDraftShortcut({ ...enter, metaKey: true }, true)).toBe(true);
    expect(isOpenDraftShortcut({ ...enter, ctrlKey: true }, true)).toBe(false);
    expect(isOpenDraftShortcut({ ...enter, ctrlKey: true }, false)).toBe(true);
    expect(isOpenDraftShortcut({ ...enter, metaKey: true, shiftKey: true }, true)).toBe(false);
    expect(isOpenDraftShortcut(enter, true)).toBe(false);
  });
});

describe("captureTitle", () => {
  it("uses the first line and truncates long ones", () => {
    expect(captureTitle("  Fix login\nmore detail")).toBe("Fix login");
    expect(captureTitle("a".repeat(70), 10)).toBe("aaaaaaaaa…");
  });
});
