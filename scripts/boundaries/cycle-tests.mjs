import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { cruise } from "dependency-cruiser";

import config from "../../.dependency-cruiser.cjs";
import { checkBaseline, unrecordedBaseCycles, violationKey } from "./baseline.mjs";
import { cyclicViolations } from "./cycles.mjs";

NodeTest.test("complete cycle edges match reachability for every three-node graph", () => {
  const nodes = ["a", "b", "c"];
  const edges = nodes.flatMap((from) => nodes.map((to) => [from, to]));
  for (let mask = 0; mask < 2 ** edges.length; mask++) {
    const present = edges.filter((_, index) => mask & (1 << index));
    const reachable = (start, goal) => {
      const visited = new Set();
      const pending = [start];
      while (pending.length) {
        const source = pending.pop();
        if (source === goal) return true;
        if (visited.has(source)) continue;
        visited.add(source);
        for (const [from, to] of present) if (from === source) pending.push(to);
      }
      return false;
    };
    const modules = nodes.map((source) => ({
      source,
      dependencies: present
        .filter(([from]) => from === source)
        .map(([, resolved]) => ({ resolved })),
    }));
    const expected = present
      .filter(([from, to]) => reachable(to, from))
      .map(([from, to]) => `no-circular | ${from} | ${to}`)
      .sort();
    NodeAssert.deepEqual(cyclicViolations(modules).map(violationKey).sort(), expected);
    NodeAssert.deepEqual(
      cyclicViolations(
        modules
          .toReversed()
          .map((module) => ({ ...module, dependencies: module.dependencies.toReversed() })),
      )
        .map(violationKey)
        .sort(),
      expected,
    );
  }
});

NodeTest.test("deleting an edge cannot unmask a previously unreported cyclic edge", async () => {
  const previous = process.cwd();
  const roots = [];
  const scan = async (remove) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "signalbox-cycle-order-"));
    roots.push(root);
    process.chdir(root);
    const sources = {
      "a.ts": 'import "./b.ts";',
      "b.ts": remove
        ? 'import "./a.ts"; import "./c.ts";'
        : 'import "./a.ts"; import "./c.ts"; import "./e.ts";',
      "c.ts": 'import "./b.ts"; import "./e.ts";',
      "d.ts": 'import "./b.ts";',
      "e.ts": 'import "./c.ts"; import "./d.ts";',
    };
    for (const [file, text] of Object.entries(sources)) NodeFS.writeFileSync(file, text);
    const { output } = await cruise(Object.keys(sources), {
      ...config.options,
      validate: true,
      ruleSet: {
        forbidden: [
          ...config.forbidden,
          { name: "no-circular", severity: "warn", from: {}, to: { circular: true } },
        ],
      },
      outputType: "json",
    });
    return JSON.parse(output);
  };
  try {
    const before = await scan(false);
    const after = await scan(true);
    const base = before.summary.violations.map(violationKey);
    NodeAssert.ok(!base.includes("no-circular | e.ts | d.ts"));
    NodeAssert.ok(after.summary.violations.map(violationKey).includes("no-circular | e.ts | d.ts"));
    const current = cyclicViolations(after.modules).map(violationKey);
    const legacy = unrecordedBaseCycles(
      cyclicViolations(before.modules),
      base,
      cyclicViolations(before.modules),
      base,
    );
    NodeAssert.deepEqual(
      checkBaseline(
        current.filter((key) => !legacy.has(key)),
        base,
      ),
      [],
    );
    NodeAssert.equal(cyclicViolations(before.modules).length, 9);
    NodeAssert.equal(cyclicViolations(after.modules).length, 8);
  } finally {
    process.chdir(previous);
    for (const root of roots) NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

NodeTest.test(
  "the checker prunes existing debt without additions and rejects new cycle edges",
  async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "signalbox-cycle-baseline-"));
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
    const baselineFile = NodePath.join(root, "scripts/boundaries/baseline.json");
    let legacyBase;
    const writeBaseline = (keys) =>
      write("scripts/boundaries/baseline.json", JSON.stringify({ violations: keys }));
    const check = (update = false) => {
      const code = `import { checkBoundaries } from ${JSON.stringify(new URL("./check.mjs", import.meta.url).href)}; process.exitCode = await checkBoundaries(${JSON.stringify(root)}, { upstream: "upstream/main", base: "origin/main", "write-baseline": ${update} }, ${JSON.stringify(legacyBase)});`;
      return NodeChildProcess.spawnSync(process.execPath, ["--input-type=module", "-e", code], {
        cwd: root,
        encoding: "utf8",
      });
    };
    try {
      git(["init", "--initial-branch=main"]);
      write("README.md", "Fixture upstream.");
      git(["add", "."]);
      git(["commit", "-qm", "upstream"]);
      git(["update-ref", "refs/remotes/upstream/main", "HEAD"]);
      write("apps/example/package.json", JSON.stringify({ name: "@test/example" }));
      write("apps/example/a.ts", 'import "./b.ts";');
      write("apps/example/b.ts", 'import "./a.ts"; import "./c.ts"; import "./e.ts";');
      write("apps/example/c.ts", 'import "./b.ts"; import "./e.ts";');
      write("apps/example/d.ts", 'import "./b.ts";');
      write("apps/example/e.ts", 'import "./c.ts"; import "./d.ts";');
      const tracked = ["no-circular | apps/example/a.ts | apps/example/b.ts"];
      writeBaseline(tracked);
      git(["add", "."]);
      git(["commit", "-qm", "existing cycles with incomplete baseline"]);
      git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
      legacyBase = git(["rev-parse", "HEAD"]);
      write("apps/example/b.ts", 'import "./a.ts"; import "./c.ts";');
      const pruned = check(true);
      NodeAssert.equal(pruned.status, 0, pruned.stderr || pruned.stdout);
      NodeAssert.deepEqual(
        JSON.parse(NodeFS.readFileSync(baselineFile, "utf8")).violations,
        tracked,
      );

      // Explicit baseline debt cannot become implicitly exempt just by deleting its entry.
      writeBaseline([]);
      const removed = check();
      NodeAssert.equal(removed.status, 1);
      NodeAssert.match(
        removed.stdout,
        /error no-circular: apps\/example\/a.ts -> apps\/example\/b.ts/,
      );
      writeBaseline(tracked);
      const unchanged = NodeFS.readFileSync(baselineFile, "utf8");
      write("apps/example/e.ts", 'import "./c.ts"; import "./d.ts"; import "./a.ts";');
      const added = check(true);
      NodeAssert.equal(added.status, 1);
      NodeAssert.match(
        added.stderr,
        /Baseline can only shrink; added: no-circular \| apps\/example\/e.ts \| apps\/example\/a.ts/,
      );
      NodeAssert.equal(NodeFS.readFileSync(baselineFile, "utf8"), unchanged);

      // A cycle that slipped into main must not become legacy debt on the next PR.
      git(["add", "."]);
      git(["commit", "-qm", "simulate an unchecked concurrent merge"]);
      git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
      const escaped = check();
      NodeAssert.equal(escaped.status, 1);
      NodeAssert.match(
        escaped.stdout,
        /error no-circular: apps\/example\/e.ts -> apps\/example\/a.ts/,
      );

      // Once an unrecorded cycle is fixed in the base, bringing it back is a new error.
      write("apps/example/e.ts", 'import "./c.ts";');
      NodeAssert.equal(check(true).status, 0);
      git(["add", "."]);
      git(["commit", "-qm", "fix an unrecorded cycle"]);
      git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
      write("apps/example/e.ts", 'import "./c.ts"; import "./d.ts";');
      const regression = check();
      NodeAssert.equal(regression.status, 1);
      NodeAssert.match(
        regression.stdout,
        /error no-circular: apps\/example\/e.ts -> apps\/example\/d.ts/,
      );
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);
