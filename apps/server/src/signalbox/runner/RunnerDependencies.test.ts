// @effect-diagnostics nodeBuiltinImport:off - fake package managers and assertions work on temp dirs.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeMachineCaches } from "./RunnerCaches.ts";
import { makeRunnerDependencies } from "./RunnerDependencies.ts";

const write = (root: string, file: string, text: string) => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, file), text);
};
const exists = (root: string, file: string) => NodeFS.existsSync(NodePath.join(root, file));

/**
 * A machine with fake `pnpm` and `npm` on PATH. Each install logs where it ran
 * and with which store, then lays down a tree; `FAIL` in the lockfile fails it.
 */
const makeMachine = () => {
  // Real path: the fake logs its working directory as the OS resolves it.
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runner-deps-")),
  );
  const bin = NodePath.join(root, "bin");
  const log = NodePath.join(root, "installs.log");
  const fake = `#!/bin/sh
echo "$(basename "$0") $PWD $pnpm_config_store_dir" >> "${log}"
if grep -q FAIL pnpm-lock.yaml package-lock.json 2>/dev/null; then
  echo "ERR_PNPM_BROKEN_LOCKFILE The lockfile is broken" >&2
  exit 1
fi
mkdir -p node_modules/.pnpm && echo installed > node_modules/.pnpm/lock.yaml
`;
  write(bin, "pnpm", fake);
  write(bin, "npm", fake);
  NodeFS.chmodSync(NodePath.join(bin, "pnpm"), 0o755);
  NodeFS.chmodSync(NodePath.join(bin, "npm"), 0o755);
  const cwd = NodePath.join(root, "threads", "thread-1");
  NodeFS.mkdirSync(cwd, { recursive: true });
  const installs = () =>
    exists(root, "installs.log")
      ? NodeFS.readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
      : [];
  return { home: root, bin, cwd, installs };
};

const prepare = (
  machine: ReturnType<typeof makeMachine>,
  options: { readonly toolchain?: string } = {},
) =>
  Effect.gen(function* () {
    const caches = yield* makeMachineCaches(machine.home, options.toolchain ?? "test-toolchain");
    const dependencies = yield* makeRunnerDependencies({
      cwd: machine.cwd,
      caches,
      environment: { PATH: `${machine.bin}:/usr/bin:/bin`, ...caches.environment },
    });
    const notices: Array<string> = [];
    const results = yield* dependencies.prepare((message) =>
      Effect.sync(() => {
        notices.push(message);
      }),
    );
    return { results, notices, caches };
  }).pipe(Effect.scoped);

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  effect.pipe(Effect.provide(NodeServices.layer));

describe("RunnerDependencies", () => {
  it.effect("installs a new root once, then reuses its tree and the caches built into it", () =>
    run(
      Effect.gen(function* () {
        const machine = makeMachine();
        write(machine.cwd, "app/pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
        write(machine.cwd, "app/package.json", `{"packageManager":"pnpm@11.10.0"}`);

        const first = yield* prepare(machine);
        expect(first.results.map((result) => [result.root.relative, result.outcome._tag])).toEqual([
          ["app", "installed"],
        ]);
        expect(first.notices).toEqual(["Installing dependencies in app/ from pnpm-lock.yaml."]);
        // Installs use the machine's store, outside the checkout.
        expect(machine.installs()).toEqual([
          `pnpm ${NodePath.join(machine.cwd, "app")} ${first.caches.environment.pnpm_config_store_dir}`,
        ]);
        expect(first.caches.environment.pnpm_config_store_dir!.startsWith(machine.cwd)).toBe(false);

        // What the turn built into the tree.
        write(machine.cwd, "app/node_modules/.vite/task-cache/entry", "cached build");
        // A script edit is not an install input.
        write(
          machine.cwd,
          "app/package.json",
          `{"packageManager":"pnpm@11.10.0","scripts":{"build":"vp build"}}`,
        );

        const second = yield* prepare(machine);
        expect(second.results.map((result) => result.outcome._tag)).toEqual(["reused"]);
        expect(second.notices).toEqual([]);
        expect(machine.installs()).toHaveLength(1);
        expect(exists(machine.cwd, "app/node_modules/.vite/task-cache/entry")).toBe(true);
      }),
    ),
  );

  it.effect("rebuilds every tree under a root from scratch when its lockfile changes", () =>
    run(
      Effect.gen(function* () {
        const machine = makeMachine();
        write(machine.cwd, "pnpm-lock.yaml", "packages: {a: 1.0.0}\n");
        yield* prepare(machine);
        write(machine.cwd, "node_modules/.vite/task-cache/entry", "built against a@1");
        write(machine.cwd, "apps/web/node_modules/.vite/deps/a.js", "optimized a@1");

        write(machine.cwd, "pnpm-lock.yaml", "packages: {a: 2.0.0}\n");
        const changed = yield* prepare(machine);
        expect(changed.results.map((result) => result.outcome)).toMatchObject([
          { _tag: "installed", reason: "lockfile" },
        ]);
        expect(changed.notices).toEqual([
          "pnpm-lock.yaml changed, so dependencies in this folder are reinstalled.",
        ]);
        expect(machine.installs()).toHaveLength(2);
        // Nothing built against the old dependencies survives.
        expect(exists(machine.cwd, "node_modules/.vite/task-cache/entry")).toBe(false);
        expect(exists(machine.cwd, "apps/web/node_modules")).toBe(false);
        expect(exists(machine.cwd, "node_modules/.pnpm/lock.yaml")).toBe(true);

        // The same change again is the new seed.
        const again = yield* prepare(machine);
        expect(again.results.map((result) => result.outcome._tag)).toEqual(["reused"]);
      }),
    ),
  );

  it.effect("rebuilds when the machine's toolchain changes", () =>
    run(
      Effect.gen(function* () {
        const machine = makeMachine();
        write(machine.cwd, "package-lock.json", "{}");
        yield* prepare(machine, { toolchain: "linux-x64-glibc2.36-node24" });
        const moved = yield* prepare(machine, { toolchain: "linux-x64-glibc2.36-node26" });
        expect(moved.results.map((result) => result.outcome)).toMatchObject([
          { _tag: "installed", reason: "toolchain" },
        ]);
        expect(moved.notices).toEqual([
          "This machine's toolchain changed, so dependencies in this folder are reinstalled.",
        ]);
        expect(machine.installs().map((line) => line.split(" ")[0])).toEqual(["npm", "npm"]);
      }),
    ),
  );

  it.effect("adopts a tree the agent installed by installing over it, quietly", () =>
    run(
      Effect.gen(function* () {
        const machine = makeMachine();
        write(machine.cwd, "repo/pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
        write(machine.cwd, "repo/node_modules/.vite/task-cache/entry", "the agent's build");

        const adopted = yield* prepare(machine);
        expect(adopted.results.map((result) => result.outcome)).toMatchObject([
          { _tag: "installed", reason: "adopted" },
        ]);
        expect(adopted.notices).toEqual([]);
        expect(exists(machine.cwd, "repo/node_modules/.vite/task-cache/entry")).toBe(true);

        const next = yield* prepare(machine);
        expect(next.results.map((result) => result.outcome._tag)).toEqual(["reused"]);
      }),
    ),
  );

  it.effect("reports a failed install once, and tries again when the lockfile changes", () =>
    run(
      Effect.gen(function* () {
        const machine = makeMachine();
        write(machine.cwd, "pnpm-lock.yaml", "FAIL\n");
        const failed = yield* prepare(machine);
        expect(failed.results.map((result) => result.outcome._tag)).toEqual(["failed"]);
        expect(failed.notices).toEqual([
          "Installing dependencies in this folder from pnpm-lock.yaml.",
          "Installing dependencies in this folder failed: ERR_PNPM_BROKEN_LOCKFILE The lockfile is broken",
        ]);
        const again = yield* prepare(machine);
        expect(again.results.map((result) => result.outcome._tag)).toEqual(["skipped"]);
        expect(again.notices).toEqual([]);
        expect(machine.installs()).toHaveLength(1);

        write(machine.cwd, "pnpm-lock.yaml", "fixed\n");
        const fixed = yield* prepare(machine);
        expect(fixed.results.map((result) => result.outcome)).toMatchObject([
          { _tag: "installed", reason: "lockfile" },
        ]);
      }),
    ),
  );

  it.effect("rebuilds a tree whose install never finished", () =>
    run(
      Effect.gen(function* () {
        const machine = makeMachine();
        write(machine.cwd, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
        yield* prepare(machine);
        // The machine died mid-install: the record still says so, the tree is half there.
        const recordFile = NodePath.join(
          machine.cwd,
          "node_modules",
          ".signalbox-dependencies.json",
        );
        const record = JSON.parse(NodeFS.readFileSync(recordFile, "utf8"));
        NodeFS.writeFileSync(recordFile, JSON.stringify({ ...record, state: "installing" }));
        write(machine.cwd, "node_modules/half-written/index.js", "");

        const resumed = yield* prepare(machine);
        expect(resumed.results.map((result) => result.outcome)).toMatchObject([
          { _tag: "installed", reason: "unfinished" },
        ]);
        expect(resumed.notices).toEqual([
          "The last install in this folder did not finish, so dependencies are reinstalled.",
        ]);
        expect(exists(machine.cwd, "node_modules/half-written")).toBe(false);
      }),
    ),
  );

  it.effect(
    "looks two levels deep, outside dot directories, dependency trees and other repositories",
    () =>
      run(
        Effect.gen(function* () {
          const machine = makeMachine();
          write(machine.cwd, "notes.md", "# Notes\n");
          write(machine.cwd, "code/site/package-lock.json", "{}");
          write(machine.cwd, "code/site/deep/er/pnpm-lock.yaml", "too deep\n");
          write(machine.cwd, ".repos/vendored/pnpm-lock.yaml", "not ours\n");
          write(machine.cwd, "node_modules/pkg/pnpm-lock.yaml", "not ours\n");
          write(machine.cwd, "app/npm-shrinkwrap.json", "{}");
          // A shortcut, mounted read-only as a repository of its own (#142).
          write(machine.cwd, "shared/.git/HEAD", "ref: refs/heads/main\n");
          write(machine.cwd, "shared/package-lock.json", "{}");
          // A link back up never sends the search in circles, or outside the checkout.
          NodeFS.symlinkSync(machine.cwd, NodePath.join(machine.cwd, "code", "loop"));
          NodeFS.symlinkSync(
            NodePath.join(machine.home, "bin"),
            NodePath.join(machine.cwd, "outside"),
          );
          write(machine.home, "bin/package-lock.json", "{}");

          const prepared = yield* prepare(machine);
          expect(
            prepared.results.map((result) => [result.root.relative, result.root.manager]),
          ).toEqual([
            ["app", "npm"],
            ["code/site", "npm"],
          ]);
        }),
      ),
  );

  it.effect("does nothing in a folder with no lockfile", () =>
    run(
      Effect.gen(function* () {
        const machine = makeMachine();
        write(machine.cwd, "README.md", "# Plain files\n");
        const prepared = yield* prepare(machine);
        expect(prepared.results).toEqual([]);
        expect(machine.installs()).toEqual([]);
      }),
    ),
  );
});
