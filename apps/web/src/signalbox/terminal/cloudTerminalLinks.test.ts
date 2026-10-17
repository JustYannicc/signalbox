import { describe, expect, it } from "vite-plus/test";

import {
  resolveCloudTerminalFileLinkAction,
  resolveCloudTerminalWorkspaceLink,
} from "./cloudTerminalLinks";

describe("resolveCloudTerminalWorkspaceLink", () => {
  const root = "/drives/drive-1";

  it("opens relative and absolute workspace paths at their line", () => {
    expect(resolveCloudTerminalWorkspaceLink("src/app.ts:42:7", root, root)).toEqual({
      path: "src/app.ts",
      line: 42,
    });
    expect(resolveCloudTerminalWorkspaceLink("./README.md", `${root}/docs`, root)).toEqual({
      path: "docs/README.md",
    });
    expect(resolveCloudTerminalWorkspaceLink(`${root}/src/../lib/x.ts`, root, root)).toEqual({
      path: "lib/x.ts",
    });
    expect(resolveCloudTerminalWorkspaceLink(root, root, root)).toEqual({ path: "." });
  });

  it("refuses paths the Files panel cannot show", () => {
    expect(resolveCloudTerminalWorkspaceLink("../drive-2/secret.txt", root, root)).toBeNull();
    expect(resolveCloudTerminalWorkspaceLink("/drives/drive-10/a.ts", root, root)).toBeNull();
    expect(
      resolveCloudTerminalWorkspaceLink("/home/runner/work/src/app.ts", root, root),
    ).toBeNull();
    expect(resolveCloudTerminalWorkspaceLink("~/notes.md", root, root)).toBeNull();
    expect(resolveCloudTerminalWorkspaceLink("../../../../etc/passwd", root, root)).toBeNull();
  });
});

describe("resolveCloudTerminalFileLinkAction", () => {
  const root = "/drives/drive-1";

  it("opens a workspace link only with file read access", () => {
    expect(resolveCloudTerminalFileLinkAction("src/app.ts:42", root, root, true)).toEqual({
      kind: "open",
      target: { path: "src/app.ts", line: 42 },
    });
    expect(resolveCloudTerminalFileLinkAction("src/app.ts:42", root, root, false)).toEqual({
      kind: "blocked",
    });
  });

  it("blocks links outside the workspace even with file read access", () => {
    expect(resolveCloudTerminalFileLinkAction("../drive-2/secret.txt", root, root, true)).toEqual({
      kind: "blocked",
    });
  });
});
