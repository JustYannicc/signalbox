import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

NodeTest.test("old PRs use current main's baseline but still fail for their own violations", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "signalbox-old-pr-"));
  const git = (args) =>
    NodeChildProcess.execFileSync(
      "git",
      [
        "-c",
        "user.name=Boundary test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: root, encoding: "utf8", stdio: "pipe" },
    ).trimEnd();
  const write = (file, text) => {
    const target = NodePath.join(root, file);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, text);
  };
  const commit = (message) => {
    git(["add", "."]);
    git(["commit", "-qm", message]);
    return git(["rev-parse", "HEAD"]);
  };
  let legacyBase;
  const check = (head, base = "origin/main") => {
    const code = `import { checkBoundaries } from ${JSON.stringify(new URL("./check.mjs", import.meta.url).href)}; process.exitCode = await checkBoundaries(${JSON.stringify(root)}, { upstream: "upstream/main", base: ${JSON.stringify(base)}, head: ${JSON.stringify(head)} }, ${JSON.stringify(legacyBase)});`;
    return NodeChildProcess.spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      cwd: root,
      encoding: "utf8",
    });
  };
  try {
    git(["init", "--initial-branch=main"]);
    write("README.md", "upstream");
    const upstream = commit("upstream");
    git(["update-ref", "refs/remotes/upstream/main", upstream]);
    write("apps/example/package.json", JSON.stringify({ name: "@test/example" }));
    write("apps/example/a.ts", 'import "./b.ts";');
    write("apps/example/b.ts", 'import "./a.ts";');
    const oldBase = commit("cycles before boundary enforcement");
    git(["checkout", "-b", "old-pr"]);
    write("apps/example/feature.ts", "export const feature = 1;");
    write("apps/cloud/package.json", JSON.stringify({ name: "@test/cloud" }));
    const vendorRoot = "apps/cloud/src/isolate/node/vm/vendor/nimbus/";
    write(`${vendorRoot}a.ts`, 'import "./b.ts";');
    write(`${vendorRoot}b.ts`, 'import "./a.ts";');
    const head = commit("unrelated feature");
    git(["checkout", "main"]);
    write(
      "scripts/boundaries/baseline.json",
      JSON.stringify({ violations: ["no-circular | apps/example/a.ts | apps/example/b.ts"] }),
    );
    legacyBase = commit("introduce incomplete baseline");
    // Main can have new debt too. It must fail on main, not on an unrelated PR.
    write("apps/cloud/package.json", JSON.stringify({ name: "@test/cloud" }));
    write("apps/cloud/src/alpha/lib/private.ts", "export const value = 1;");
    write("apps/cloud/src/alpha/main.test.ts", 'import "./lib/private.ts";');
    const main = commit("simulate inherited boundary debt");
    git(["update-ref", "refs/remotes/origin/main", main]);
    NodeAssert.equal(git(["merge-base", head, "origin/main"]), oldBase);
    git(["checkout", "old-pr"]);
    git(["merge", "--no-ff", "--no-edit", "main"]);
    const checkout = git(["rev-parse", "HEAD"]);
    const stale = check(undefined, oldBase);
    NodeAssert.equal(stale.status, 1, stale.stderr || stale.stdout);
    NodeAssert.match(stale.stdout, /error no-circular: apps\/example\/b.ts -> apps\/example\/a.ts/);
    const refsBefore = git(["show-ref"]);
    const passed = check(head);
    NodeAssert.equal(passed.status, 0, passed.stderr || passed.stdout);
    NodeAssert.match(passed.stdout, /1 inherited target violations/);
    NodeAssert.doesNotMatch(
      passed.stdout,
      /no-circular: apps\/cloud\/src\/isolate\/node\/vm\/vendor\//,
    );
    NodeAssert.equal(git(["rev-parse", "HEAD"]), checkout);
    NodeAssert.equal(git(["show-ref"]), refsBefore);
    NodeAssert.equal(git(["status", "--porcelain"]), "");
    const strict = check(undefined);
    NodeAssert.equal(strict.status, 1);
    NodeAssert.match(strict.stdout, /error tests-through-entrypoints:/);
    write("apps/example/a.ts", 'import "./b.ts"; import "./new.ts";');
    write("apps/example/new.ts", 'import "./a.ts";');
    const badHead = commit("new cycle in an already conflicting file");
    const failed = check(badHead);
    NodeAssert.equal(failed.status, 1, failed.stderr || failed.stdout);
    NodeAssert.match(
      failed.stdout,
      /error no-circular: apps\/example\/a.ts -> apps\/example\/new.ts/,
    );
    const baselineFile = "scripts/boundaries/baseline.json";
    write(
      baselineFile,
      JSON.stringify({
        violations: [
          "no-circular | apps/example/a.ts | apps/example/b.ts",
          "no-circular | apps/example/a.ts | apps/example/new.ts",
        ],
      }),
    );
    const growth = check(commit("try to exempt the new cycle"));
    NodeAssert.equal(growth.status, 1);
    NodeAssert.match(growth.stderr, /Baseline can only shrink; added:/);
    write(baselineFile, JSON.stringify({ violations: [] }));
    const removed = check(commit("delete an exemption without fixing its violation"));
    NodeAssert.equal(removed.status, 1);
    NodeAssert.match(
      removed.stdout,
      /error no-circular: apps\/example\/a.ts -> apps\/example\/b.ts/,
    );
    git(["checkout", "main"]);
    const mainFailure = check(undefined);
    NodeAssert.equal(mainFailure.status, 1, mainFailure.stderr || mainFailure.stdout);
    NodeAssert.match(mainFailure.stdout, /error tests-through-entrypoints:/);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
