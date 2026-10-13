// @effect-diagnostics nodeBuiltinImport:off - Builds throwaway git repositories on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { conflictingFiles, git, introducedConflicts, isAncestor } from "./mergeTree.ts";

let repo: string;

function commit(files: Record<string, string>, message: string): string {
  for (const [file, contents] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(repo, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(repo, file), contents);
  }
  git(repo, ["add", "--all"]);
  git(repo, ["commit", "--quiet", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function branch(name: string, from: string) {
  git(repo, ["checkout", "--quiet", "-B", name, from]);
}

beforeEach(() => {
  repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "upstream-sync-"));
  git(repo, ["init", "--quiet", "--initial-branch", "main"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  commit({ "a.ts": "a\n", "b.ts": "b\n", "c.ts": "c\n" }, "root");
});

afterEach(() => {
  NodeFS.rmSync(repo, { recursive: true, force: true });
});

describe("conflictingFiles", () => {
  it("is empty when edits touch different files", () => {
    const root = git(repo, ["rev-parse", "HEAD"]);
    const upstream = commit({ "a.ts": "upstream\n" }, "upstream");
    branch("fork", root);
    const fork = commit({ "b.ts": "fork\n" }, "fork");

    expect(conflictingFiles(repo, fork, upstream)).toEqual([]);
  });

  it("lists every file both sides changed differently, sorted", () => {
    const root = git(repo, ["rev-parse", "HEAD"]);
    const upstream = commit({ "c.ts": "upstream\n", "a.ts": "upstream\n" }, "upstream");
    branch("fork", root);
    const fork = commit({ "c.ts": "fork\n", "a.ts": "fork\n", "b.ts": "fork\n" }, "fork");

    expect(conflictingFiles(repo, fork, upstream)).toEqual(["a.ts", "c.ts"]);
  });

  it("throws when the commits share no history", () => {
    const upstream = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "--quiet", "--orphan", "unrelated"]);
    const unrelated = commit({ "a.ts": "other\n" }, "unrelated");

    expect(() => conflictingFiles(repo, unrelated, upstream)).toThrow(/merge-tree/);
  });
});

describe("introducedConflicts", () => {
  it("separates conflicts the PR adds from ones already on its base", () => {
    const root = git(repo, ["rev-parse", "HEAD"]);
    const upstream = commit({ "a.ts": "upstream\n", "b.ts": "upstream\n" }, "upstream");
    branch("main", root);
    const base = commit({ "a.ts": "main\n" }, "main renames a");
    branch("pr", base);
    const head = commit({ "b.ts": "pr\n" }, "pr edits b");

    expect(introducedConflicts(repo, { base, head, upstream })).toEqual({
      introduced: ["b.ts"],
      preexisting: ["a.ts"],
    });
  });

  it("passes a PR that only touches fork files", () => {
    const root = git(repo, ["rev-parse", "HEAD"]);
    const upstream = commit({ "a.ts": "upstream\n" }, "upstream");
    branch("main", root);
    const base = commit({ "a.ts": "main\n" }, "main renames a");
    branch("pr", base);
    const head = commit({ "fork/feature.ts": "new\n" }, "fork feature");

    expect(introducedConflicts(repo, { base, head, upstream }).introduced).toEqual([]);
  });

  it("passes once main has merged upstream", () => {
    const root = git(repo, ["rev-parse", "HEAD"]);
    const upstream = commit({ "a.ts": "upstream\n" }, "upstream");
    branch("main", root);
    commit({ "b.ts": "main\n" }, "main");
    git(repo, ["merge", "--quiet", "--no-ff", "--no-edit", upstream]);
    const base = git(repo, ["rev-parse", "HEAD"]);

    expect(isAncestor(repo, upstream, base)).toBe(true);
    expect(introducedConflicts(repo, { base, head: base, upstream })).toEqual({
      introduced: [],
      preexisting: [],
    });
  });
});
