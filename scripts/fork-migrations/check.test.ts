// @effect-diagnostics nodeBuiltinImport:off - Uses disposable Git fixture repositories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { check } from "./check.ts";

const MIGRATIONS = "apps/server/src/persistence/Migrations";
const UPSTREAM_FILE = `${MIGRATIONS}/001_Upstream.ts`;
const HISTORICAL_FORK_FILE = `${MIGRATIONS}/061_HistoricalFork.ts`;

describe("fork server migration check", () => {
  let repo: string;
  let rootCommit: string;

  const git = (...args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const write = (path: string, contents = "export default {};\n") => {
    const fullPath = NodePath.join(repo, path);
    NodeFS.mkdirSync(NodePath.dirname(fullPath), { recursive: true });
    NodeFS.writeFileSync(fullPath, contents);
  };
  const commit = (message: string) => {
    git("add", "--all");
    git("commit", "--quiet", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const runCheck = (overrides: Partial<{ base: string; head: string; upstream: string }> = {}) =>
    check(repo, {
      base: "origin/main",
      head: "HEAD",
      upstream: "upstream/main",
      ...overrides,
    });

  beforeEach(() => {
    repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-migrations-"));
    git("init", "--quiet", "--initial-branch=main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    git("config", "commit.gpgsign", "false");
    write(UPSTREAM_FILE);
    rootCommit = commit("shared upstream root");
    git("update-ref", "refs/remotes/upstream/main", rootCommit);
    write(HISTORICAL_FORK_FILE);
    const baseCommit = commit("Signalbox base with historical fork migration");
    git("update-ref", "refs/remotes/origin/main", baseCommit);
    git("switch", "--quiet", "-c", "feature");
  });

  afterEach(() => {
    NodeFS.rmSync(repo, { recursive: true, force: true });
  });

  it("rejects a newly added fork-only migration and names its exact path", () => {
    const path = `${MIGRATIONS}/063_ForkOnly.ts`;
    write(path);
    commit("add fork migration");

    expect(runCheck()).toMatchObject({
      added: [path],
      violations: [path],
    });
  });

  it("does not turn historical fork migrations into global baseline exceptions", () => {
    write("README.md", "unrelated change\n");
    commit("unrelated change");

    expect(runCheck()).toMatchObject({ added: [], violations: [] });
  });

  it("allows an upstream migration introduced after the shared merge base", () => {
    git("switch", "--quiet", "--detach", rootCommit);
    const path = `${MIGRATIONS}/002_UpstreamIntroduced.ts`;
    write(path);
    const upstreamCommit = commit("upstream adds migration");
    git("update-ref", "refs/remotes/upstream/main", upstreamCommit);

    git("switch", "--quiet", "feature");
    git("merge", "--quiet", "--no-ff", "--no-edit", "upstream/main");

    const report = runCheck();
    expect(report.mergeBase).toBe(upstreamCommit);
    expect(report.added).toContain(path);
    expect(report.violations).toEqual([]);
  });

  it("checks the destination of a renamed migration", () => {
    const path = `${MIGRATIONS}/063_RenamedFork.ts`;
    git("mv", HISTORICAL_FORK_FILE, path);
    commit("rename fork migration");

    expect(runCheck().violations).toEqual([path]);
  });

  it("ignores tests, nested implementation files, and non-migration files", () => {
    write(`${MIGRATIONS}/063_ForkOnly.test.ts`);
    write(`${MIGRATIONS}/OrchestrationV2/063_Implementation.ts`);
    write(`${MIGRATIONS}/MigrationHelpers.ts`);
    write(`${MIGRATIONS}/063_Schema.sql`);
    write(`${MIGRATIONS}/063_Types.d.ts`);
    commit("add files outside migration entry scope");

    expect(runCheck()).toMatchObject({ added: [], violations: [] });
  });

  it("fails with fetch instructions when a required ref is missing", () => {
    expect(() => runCheck({ base: "origin/missing" })).toThrow(/pass its ref with --base/);
    expect(() => runCheck({ head: "missing-head" })).toThrow(/pass its ref with --head/);
    expect(() => runCheck({ upstream: "upstream/missing" })).toThrow(
      /Fetch the upstream repository/,
    );
  });

  // Windows forbids the filename characters needed to reproduce Actions command injection.
  it.skipIf(process.platform === "win32")("escapes filenames in CLI workflow annotations", () => {
    const path = `${MIGRATIONS}/063_Fork%\r\n::notice title=filename::injected-notice\n,colon:.ts`;
    write(path);
    const script = NodePath.join(repo, "scripts/fork-migrations/check.ts");
    NodeFS.mkdirSync(NodePath.dirname(script), { recursive: true });
    NodeFS.copyFileSync(NodePath.join(import.meta.dirname, "check.ts"), script);
    commit("add a migration with workflow command characters");

    const result = NodeChildProcess.spawnSync(process.execPath, [script, "--base", "origin/main"], {
      cwd: repo,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    const annotations = result.stderr.split(/\r?\n/).filter((line) => line.startsWith("::"));
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toContain("063_Fork%25%0D%0A%3A%3Anotice title=filename%3A%3A");
    expect(annotations[0]).toContain("%0A%2Ccolon%3A.ts,title=");
    expect(annotations[0]).toContain("063_Fork%25%0D%0A::notice title=filename::");
  });
});
