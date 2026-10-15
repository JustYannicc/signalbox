// @effect-diagnostics nodeBuiltinImport:off - Runs merge-main.sh on throwaway git repositories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

const SCRIPT = NodePath.join(import.meta.dirname, "merge-main.sh");
const STACK = "apps/cloud/alchemy.run.ts";

const stack = (...bindings: ReadonlyArray<string>) =>
  `const bindings = {\n${bindings.map((binding) => `  ${binding},\n`).join("")}};\n`;
const BINDINGS = ["BOAT_API_KEY", "SESSION_SECRET", "APNS_TEAM_ID", "APNS_KEY_ID", "FCM_ACCOUNT"];

let repo: string;
const git = (...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const write = (path: string, contents: string) => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(repo, path)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(repo, path), contents);
};
const commit = (path: string, contents: string, message: string) => {
  write(path, contents);
  git("add", "--all");
  git("commit", "--quiet", "-m", message);
};
/** Checks out `branch` merged into `base`, the way GitHub builds `refs/pull/<n>/merge`. */
const pullRequestCheckout = (base: string, branch: string) => {
  git("checkout", "--quiet", "--detach", base);
  git("merge", "--quiet", "--no-ff", "--no-edit", branch);
};
/** Runs the script the way CI does: no git identity configured anywhere. */
const mergeMain = () => {
  const output = NodePath.join(repo, ".git", "github-output");
  NodeFS.writeFileSync(output, "");
  git("config", "--unset", "user.name");
  git("config", "--unset", "user.email");
  const run = NodeChildProcess.spawnSync("bash", [SCRIPT, "main"], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_OUTPUT: output,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.useConfigOnly",
      GIT_CONFIG_VALUE_0: "true",
    },
  });
  return {
    status: run.status,
    stdout: run.stdout,
    output: NodeFS.readFileSync(output, "utf8"),
    stack: NodeFS.readFileSync(NodePath.join(repo, STACK), "utf8"),
  };
};

describe("merge-main.sh", () => {
  let root: string;

  beforeEach(() => {
    repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "merge-main-"));
    git("init", "--quiet", "--initial-branch", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    git("config", "commit.gpgsign", "false");
    commit(STACK, stack(...BINDINGS), "root");
    root = git("rev-parse", "HEAD");
    git("branch", "feature");
  });

  afterEach(() => {
    NodeFS.rmSync(repo, { recursive: true, force: true });
  });

  /** Main binds a new variable after the pull request's checkout was made. */
  const mainAddsBinding = () => {
    git("checkout", "--quiet", "main");
    commit(STACK, stack(...BINDINGS, "EXECUTOR_MCP_URL"), "executor");
  };

  it("brings what main added since into a checkout that only lags it", () => {
    git("checkout", "--quiet", "feature");
    commit("README.md", "unrelated\n", "unrelated");
    pullRequestCheckout(root, "feature");
    const checkout = git("rev-parse", "HEAD");
    mainAddsBinding();
    git("checkout", "--quiet", "--detach", checkout);

    const result = mergeMain();
    expect(result.status).toBe(0);
    expect(result.output).toBe("merged=true\n");
    expect(result.stack).toBe(stack(...BINDINGS, "EXECUTOR_MCP_URL"));
  });

  it("keeps a binding the pull request removes removed", () => {
    git("checkout", "--quiet", "feature");
    commit(STACK, stack(...BINDINGS.slice(1)), "drop the boat key");
    pullRequestCheckout(root, "feature");
    const checkout = git("rev-parse", "HEAD");
    mainAddsBinding();
    git("checkout", "--quiet", "--detach", checkout);

    const result = mergeMain();
    expect(result.status).toBe(0);
    expect(result.stack).toBe(stack(...BINDINGS.slice(1), "EXECUTOR_MCP_URL"));
  });

  it("leaves a checkout that already has main alone", () => {
    git("checkout", "--quiet", "feature");
    commit("README.md", "unrelated\n", "unrelated");
    mainAddsBinding();
    pullRequestCheckout("main", "feature");

    const result = mergeMain();
    expect(result.status).toBe(0);
    expect(result.output).toBe("merged=false\n");
    expect(git("status", "--porcelain")).toBe("");
  });

  it("fails, leaving the checkout clean, when main doesn't merge cleanly", () => {
    git("checkout", "--quiet", "feature");
    commit(STACK, stack(...BINDINGS, "OTHER_URL"), "other");
    pullRequestCheckout(root, "feature");
    const checkout = git("rev-parse", "HEAD");
    mainAddsBinding();
    git("checkout", "--quiet", "--detach", checkout);

    const result = mergeMain();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("::error title=Merge main::");
    expect(result.output).toBe("");
    expect(git("status", "--porcelain")).toBe("");
  });
});
