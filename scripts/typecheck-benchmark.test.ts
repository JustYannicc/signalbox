// @effect-diagnostics nodeBuiltinImport:off - tests create isolated package manifests on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, test } from "vite-plus/test";
import {
  discoverWorkspaces,
  mapBaselineTscCommands,
  planBaselineTypecheckScripts,
  withTemporaryTypecheckScripts,
} from "./lib/typecheck-workspaces.ts";
import { aggregateProcessTreeRss, parseProcessStatus } from "./lib/typecheck-process.ts";

test("discovers only workspace manifests in the supported topology", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "typecheck-benchmark-"));
  try {
    for (const directory of ["apps/a", "packages/b", "infra/c", "scripts", "oxlint-plugin-t3code"])
      NodeFS.mkdirSync(NodePath.join(root, directory), { recursive: true });
    for (const directory of ["apps/a", "packages/b", "infra/c", "scripts", "oxlint-plugin-t3code"])
      NodeFS.writeFileSync(NodePath.join(root, directory, "package.json"), "{}\n");

    expect(discoverWorkspaces(root).map(({ relativePath }) => relativePath)).toEqual([
      "apps/a/package.json",
      "infra/c/package.json",
      "oxlint-plugin-t3code/package.json",
      "packages/b/package.json",
      "scripts/package.json",
    ]);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

test("plans baseline scripts by workspace path and reports missing workspaces and scripts", () => {
  const plan = planBaselineTypecheckScripts(
    [
      { relativePath: "apps/new/package.json", typecheckScript: "tsc-rs --noEmit" },
      { relativePath: "apps/legacy/package.json", typecheckScript: "tsc-rs --noEmit" },
      { relativePath: "infra/current-only/package.json", typecheckScript: "astro check" },
    ],
    new Map([
      ["apps/legacy/package.json", "tsc --noEmit"],
      ["infra/current-only/package.json", undefined],
      ["packages/baseline-only/package.json", "tsc --noEmit"],
    ]),
    new Set([
      "apps/legacy/package.json",
      "infra/current-only/package.json",
      "packages/baseline-only/package.json",
    ]),
    "/opt/effect/tsgo",
  );

  expect([...plan.overrides]).toEqual([
    ["apps/legacy/package.json", "'/opt/effect/tsgo' --noEmit"],
    ["infra/current-only/package.json", undefined],
  ]);
  expect(plan.notes).toEqual({
    newWorkspaces: ["apps/new/package.json"],
    baselineWithoutTypecheck: ["infra/current-only/package.json"],
    baselineOnlyTypecheck: [],
    currentOnlyTypecheck: ["infra/current-only/package.json"],
    baselineOnlyWorkspaces: ["packages/baseline-only/package.json"],
  });
  expect(plan.compilerMappings).toEqual([
    {
      workspace: "apps/legacy/package.json",
      originalScript: "tsc --noEmit",
      effectiveScript: "'/opt/effect/tsgo' --noEmit",
      commandCount: 1,
    },
  ]);
});

test("maps only baseline tsc command tokens to the shell-quoted Effect compiler", () => {
  const effectPath = "/opt/effect's compiler/tsgo";
  const result = mapBaselineTscCommands(
    "  tsc --noEmit && astro check && tsc-rs --noEmit; tsc -p tsconfig.json; printf 'tsc'",
    effectPath,
  );

  expect(result).toEqual({
    script:
      "  '/opt/effect'\\''s compiler/tsgo' --noEmit && astro check && tsc-rs --noEmit; '/opt/effect'\\''s compiler/tsgo' -p tsconfig.json; printf 'tsc'",
    commandCount: 2,
  });
});

test("sums only the command PID and transitive descendants", () => {
  expect(parseProcessStatus(12, "Name:\tnode\nPPid:\t7\nVmRSS:\t12 kB\n")).toEqual({
    pid: 12,
    ppid: 7,
    rssBytes: 12 * 1024,
  });
  expect(
    aggregateProcessTreeRss(
      [
        { pid: 1, ppid: 0, rssBytes: 1_024 },
        { pid: 2, ppid: 1, rssBytes: 2_048 },
        { pid: 3, ppid: 2, rssBytes: 4_096 },
        { pid: 4, ppid: 0, rssBytes: 8_192 },
        { pid: 5, ppid: 4, rssBytes: 16_384 },
      ],
      1,
    ),
  ).toBe(7_168);
});

test("restores exact manifest bytes when a baseline spawn fails", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "typecheck-benchmark-"));
  const file = NodePath.join(root, "apps", "sample", "package.json");
  const original = Buffer.from(
    '{\n "name": "sample",\n "scripts": {"test":"vitest", "typecheck":"tsc-rs"}\n}\n',
  );
  try {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, original);
    const workspaces = discoverWorkspaces(root);

    await expect(
      withTemporaryTypecheckScripts(
        root,
        workspaces,
        new Map([["apps/sample/package.json", "tsc --noEmit"]]),
        async () => {
          const temporary = JSON.parse(NodeFS.readFileSync(file, "utf8")) as {
            scripts: { test: string; typecheck: string };
          };
          expect(temporary.scripts).toEqual({ test: "vitest", typecheck: "tsc --noEmit" });
          throw new Error("spawn failed");
        },
      ),
    ).rejects.toThrow("spawn failed");

    expect(NodeFS.readFileSync(file)).toEqual(original);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
