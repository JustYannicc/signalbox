// @effect-diagnostics nodeBuiltinImport:off - Builds throwaway git repositories on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { deletedUpstream, droppedHooks, hookChanges, hookText, mergesUpstream } from "./hooks.ts";
import { git } from "./mergeTree.ts";

let repo: string;

function commit(files: Record<string, string | null>, message: string): string {
  for (const [file, contents] of Object.entries(files)) {
    const path = NodePath.join(repo, file);
    if (contents === null) {
      NodeFS.rmSync(path);
      continue;
    }
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, contents);
  }
  git(repo, ["add", "--all"]);
  git(repo, ["commit", "--quiet", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

beforeEach(() => {
  repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "upstream-hooks-"));
  git(repo, ["init", "--quiet", "--initial-branch", "main"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  commit({ "app.ts": "export const a = 1;\n" }, "root");
});

afterEach(() => {
  NodeFS.rmSync(repo, { recursive: true, force: true });
});

describe("hookText", () => {
  it("reads every hook form, and ignores signalbox:// links", () => {
    expect(hookText('import x from "./x"; // signalbox: accounts')).toBe("accounts");
    expect(hookText("# signalbox: optional accounts")).toBe("optional accounts");
    expect(hookText("{/* signalbox: rail */}")).toBe("rail");
    expect(hookText("/* signalbox: brand colors */")).toBe("brand colors");
    expect(hookText("<!-- signalbox: fork docs -->")).toBe("fork docs");
    expect(hookText('const url = "signalbox://open";')).toBeUndefined();
  });
});

describe("hookChanges", () => {
  it("sees a hook that moved files as removed and added, and skips .repos", () => {
    const base = commit(
      { "a.ts": "x(); // signalbox: accounts\n", ".repos/v.ts": "// signalbox: vendored\n" },
      "hooks",
    );
    const head = commit(
      { "a.ts": null, "moved/a.ts": "y(); // signalbox: accounts\n", ".repos/v.ts": null },
      "upstream moved it",
    );
    const { removed, added } = hookChanges(repo, { base, head });
    expect(removed).toEqual([{ file: "a.ts", text: "accounts" }]);
    expect(added).toEqual([{ file: "moved/a.ts", text: "accounts" }]);
    expect(droppedHooks(removed, added)).toEqual([]);
  });

  it("doesn't blame an old PR for a hook current main already removed", () => {
    const fork = commit({ "hook.ts": "x(); // signalbox: old hook\n" }, "hook");
    const base = commit(
      { "hook.ts": "x();\n", "new.ts": "// signalbox: replacement\n" },
      "main replaces hook",
    );
    git(repo, ["checkout", "--quiet", "-b", "old-sync", fork]);
    const head = commit({ "hook.ts": "x();\n", "up.ts": "upstream\n" }, "old sync drops old hook");
    const { removed, added } = hookChanges(repo, { base, head });
    expect(droppedHooks(removed, added)).toEqual([]);
  });

  it("doesn't count hooks the base gained after the head branched off", () => {
    const root = git(repo, ["rev-parse", "HEAD"]);
    const base = commit({ "new.ts": "z(); // signalbox: new on main\n" }, "main moves on");
    git(repo, ["checkout", "--quiet", "-b", "sync", root]);
    const head = commit({ "up.ts": "upstream\n" }, "sync");
    expect(hookChanges(repo, { base, head })).toEqual({ removed: [], added: [] });
  });
});

describe("droppedHooks", () => {
  it("keeps a hook that moved to another file, and counts repeated texts", () => {
    const base = [
      { file: "a.ts", text: "accounts" },
      { file: "b.ts", text: "accounts" },
      { file: "c.ts", text: "rail" },
    ];
    const head = [
      { file: "moved/a.ts", text: "accounts" },
      { file: "c.ts", text: "rail" },
    ];
    expect(droppedHooks(base, head)).toEqual([{ file: "b.ts", text: "accounts" }]);
  });
});

describe("mergesUpstream", () => {
  it("is true only for a head that brings in upstream commits the base lacks", () => {
    const root = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "--quiet", "-b", "upstream", root]);
    const upstream = commit({ "up.ts": "new\n" }, "upstream");
    git(repo, ["checkout", "--quiet", "main"]);
    const base = commit({ "fork.ts": "// signalbox: fork\n" }, "fork");

    git(repo, ["checkout", "--quiet", "-b", "feature", base]);
    const feature = commit({ "feature.ts": "x\n" }, "feature");
    expect(mergesUpstream(repo, { base, head: feature, upstream })).toBe(false);

    git(repo, ["checkout", "--quiet", "-b", "sync", base]);
    git(repo, ["merge", "--quiet", "--no-ff", "--no-edit", upstream]);
    const sync = git(repo, ["rev-parse", "HEAD"]);
    expect(mergesUpstream(repo, { base, head: sync, upstream })).toBe(true);

    // Once main has the merge, a later PR doesn't count as one.
    expect(mergesUpstream(repo, { base: sync, head: sync, upstream })).toBe(false);
  });

  it("an upstream merge that loses a hook is caught", () => {
    const base = commit({ "app.ts": "export const a = 1; // signalbox: accounts\n" }, "hook");
    const head = commit({ "app.ts": "export const a = 2;\n" }, "lost it");
    const { removed, added } = hookChanges(repo, { base, head });
    expect(droppedHooks(removed, added)).toEqual([{ file: "app.ts", text: "accounts" }]);
  });
});

describe("deletedUpstream", () => {
  it("lists files upstream deleted since the last merge, not ones it renamed", () => {
    const root = commit(
      { "gone.ts": "gone(); // signalbox: no beta\n", "moved.ts": "export const long = 1;\n" },
      "both",
    );
    git(repo, ["checkout", "--quiet", "-b", "upstream", root]);
    git(repo, ["rm", "--quiet", "gone.ts"]);
    git(repo, ["mv", "moved.ts", "renamed.ts"]);
    git(repo, ["commit", "--quiet", "-m", "upstream deletes and renames"]);
    const upstream = git(repo, ["rev-parse", "HEAD"]);
    expect([...deletedUpstream(repo, { base: root, upstream })]).toEqual(["gone.ts"]);
  });
});
