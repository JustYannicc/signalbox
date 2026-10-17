import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { cruise } from "dependency-cruiser";

import config from "../../.dependency-cruiser.cjs";
import { checkBaseline, violationKey } from "./baseline.mjs";
import { workspaceAliases, workspaceTarget, workspaceViolations } from "./workspaces.mjs";

NodeTest.test(
  "exports respect exact keys, wildcard specificity, conditions, and private exceptions",
  () => {
    const workspace = {
      name: "@test/module",
      exports: {
        ".": "./src/index.ts",
        "./feature": { types: "./src/feature.ts", import: "./dist/feature.js" },
        "./*": "./src/*.ts",
        "./private/*": null,
      },
    };
    NodeAssert.equal(workspaceTarget(workspace, "@test/module"), "./src/index.ts");
    NodeAssert.equal(workspaceTarget(workspace, "@test/module/feature"), "./src/feature.ts");
    NodeAssert.equal(
      workspaceTarget(workspace, "@test/module/nested/item"),
      "./src/nested/item.ts",
    );
    NodeAssert.equal(workspaceTarget(workspace, "@test/module/private/secret"), undefined);
    NodeAssert.equal(workspaceTarget(workspace, "@test/module/../../other"), undefined);
  },
);

NodeTest.test(
  "dependency-cruiser sees type imports, dynamic imports, hidden cloud code, tests, and cycles",
  async () => {
    const previous = process.cwd();
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "signalbox-boundaries-"));
    try {
      process.chdir(root);
      const sources = {
        "packages/a/src/index.ts": "export const publicValue = 1;",
        "packages/a/src/private.ts": "export interface Secret { x: string }",
        "packages/a/src/index.test.ts": 'import type { Secret } from "./private.ts";',
        "packages/b/src/use.ts":
          'import { publicValue } from "@test/a/public"; import type { Secret } from "@test/a/src/private"; import "../../a/src/index.ts";',
        "apps/cloud/src/alpha/index.ts": 'import "./lib/private.ts";',
        "apps/cloud/src/alpha/lib/private.ts": "export interface Hidden { x: string }",
        "apps/cloud/src/alpha/lib/production.ts": 'import "./tests/fixture.ts";',
        "apps/cloud/src/alpha/lib/tests/fixture.ts": "export const nestedFixture = 1;",
        "apps/cloud/src/alpha/lib/a.ts": 'import "./b.ts";',
        "apps/cloud/src/alpha/lib/b.ts": 'import "./a.ts";',
        "apps/cloud/src/alpha/lib/private.test.ts": 'import type { Hidden } from "./private.ts";',
        "apps/cloud/src/alpha/tests/fixture.ts": "export const fixture = 1;",
        "apps/cloud/src/alpha/tests/valid.test.ts": 'import "../index.ts"; import "./fixture.ts";',
        "apps/cloud/src/beta/index.ts": 'import type { Hidden } from "../alpha/lib/private.ts";',
        "apps/cloud/src/worker.ts": 'void import("./alpha/lib/private.ts");',
        "packages/b/src/native.mts": 'import type { Secret } from "@test/a/src/private";',
        "packages/b/src/native.cts": 'import type { Secret } from "@test/a/src/private";',
        "apps/web/src/feature.ts": 'import type { DurableObject } from "cloudflare:workers";',
      };
      for (const [file, text] of Object.entries(sources)) {
        NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
        NodeFS.writeFileSync(file, text);
      }
      const workspaces = [
        { name: "@test/a", directory: "packages/a", exports: { "./public": "./src/index.ts" } },
        { name: "@test/b", directory: "packages/b" },
        { name: "@test/cloud", directory: "apps/cloud" },
      ];
      const { output } = await cruise(
        Object.keys(sources),
        {
          ...config.options,
          validate: true,
          ruleSet: { forbidden: config.forbidden },
          outputType: "json",
        },
        { alias: workspaceAliases(workspaces) },
      );
      const graph = JSON.parse(output);
      const issues = [
        ...graph.summary.violations,
        ...workspaceViolations(graph.modules, workspaces),
      ];
      const has = (rule, from) =>
        issues.some((issue) => issue.rule.name === rule && issue.from === from);
      NodeAssert.ok(has("cloud-entrypoints", "apps/cloud/src/worker.ts"));
      NodeAssert.ok(has("cloud-entrypoints-across-modules", "apps/cloud/src/beta/index.ts"));
      NodeAssert.ok(has("tests-through-entrypoints", "apps/cloud/src/alpha/lib/private.test.ts"));
      NodeAssert.ok(issues.some((issue) => issue.rule.name === "no-circular"));
      NodeAssert.ok(has("tests-folder-is-private", "apps/cloud/src/alpha/lib/production.ts"));
      NodeAssert.ok(has("workspace-relative-reach-in", "packages/b/src/use.ts"));
      NodeAssert.ok(has("workspace-exports", "packages/b/src/use.ts"));
      NodeAssert.ok(has("workspace-exports", "packages/b/src/native.mts"));
      NodeAssert.ok(has("workspace-exports", "packages/b/src/native.cts"));
      NodeAssert.ok(has("workspace-tests-through-exports", "packages/a/src/index.test.ts"));
      NodeAssert.ok(has("clients-use-contracts", "apps/web/src/feature.ts"));
      NodeAssert.ok(
        !issues.some((issue) => issue.from === "apps/cloud/src/alpha/tests/valid.test.ts"),
      );
      const validImport = graph.modules
        .find((module) => module.source === "packages/b/src/use.ts")
        .dependencies.find((dependency) => dependency.module === "@test/a/public");
      NodeAssert.equal(validImport.resolved, "packages/a/src/index.ts");
      NodeAssert.ok(
        !issues.some(
          (issue) =>
            issue.to === "packages/a/src/index.ts" && issue.rule.name === "workspace-exports",
        ),
      );
    } finally {
      process.chdir(previous);
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);

NodeTest.test("the baseline can shrink, cannot grow, and cannot hide an extended cycle", () => {
  NodeAssert.deepEqual(checkBaseline(["old"], ["old", "older"]), []);
  NodeAssert.match(checkBaseline(["new"], ["old"])[0], /can only shrink/);
  NodeAssert.match(checkBaseline(["old", "old"], ["old"])[0], /duplicate/);
  const cycle = {
    rule: { name: "no-circular" },
    from: "a.ts",
    to: "b.ts",
    cycle: [{ name: "a.ts" }, { name: "b.ts" }],
  };
  NodeAssert.notEqual(
    violationKey(cycle),
    violationKey({ ...cycle, cycle: [...cycle.cycle, { name: "new.ts" }] }),
  );
});
