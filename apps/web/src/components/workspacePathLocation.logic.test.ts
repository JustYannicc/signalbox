import { describe, expect, it } from "vite-plus/test";

import { buildDraftActionMenuItems } from "./threadActionMenu.logic";
import { labelCopyPathItems, resolveWorkspacePathLocation } from "./workspacePathLocation.logic";

describe("resolveWorkspacePathLocation", () => {
  it("keeps paths on a reachable filesystem unlabeled", () => {
    expect(
      resolveWorkspacePathLocation({ localFilesystem: true, environmentLabel: "Signalbox Cloud" }),
    ).toBeNull();
  });

  it("names the environment when its filesystem is out of reach", () => {
    expect(
      resolveWorkspacePathLocation({ localFilesystem: false, environmentLabel: "Signalbox Cloud" }),
    ).toBe("Signalbox Cloud");
    expect(resolveWorkspacePathLocation({ localFilesystem: false, environmentLabel: " " })).toBe(
      "the server",
    );
  });
});

describe("labelCopyPathItems", () => {
  const items = buildDraftActionMenuItems({ hasPath: true, hasBranch: true, hasProject: true });

  it("relabels nested copy-path items and nothing else", () => {
    const copy = labelCopyPathItems(items, "Signalbox Cloud").find((item) => item.id === "copy");
    expect(copy?.label).toBe("Copy");
    expect(copy?.children?.map((child) => child.label)).toEqual([
      "Path on Signalbox Cloud",
      "Branch",
    ]);
  });

  it("returns the menu untouched without a location", () => {
    expect(labelCopyPathItems(items, null)).toBe(items);
  });
});
