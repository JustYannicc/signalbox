import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as AlchemyArtifacts from "alchemy/Artifacts";
import {
  SourceProviderError,
  type SourceContext,
  type SourceHash,
  type SourceServices,
  type SourceError,
} from "alchemy/Cloudflare";
import { describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import { profileWorkerStartup } from "./profile.ts";
import { sha256, startupPayload } from "./payload.ts";
import { readStartupBundle } from "./prebuilt.ts";

const runtimeMock = vi.hoisted(() => {
  const identity = {
    node: "v24.18.0",
    nodeSha256: "b".repeat(64),
    wrangler: "4.151.1",
    wranglerSha256: "c".repeat(64),
    miniflare: "5.20261012.1-beta",
    miniflareSha256: "d".repeat(64),
    workerd: "1.20261012.1",
    workerdSha256: "a".repeat(64),
    platform: "darwin",
    arch: "arm64",
  };
  return {
    identity,
    profilerRuntime: vi.fn(async () => ({
      nodeExecutable: "node",
      wranglerCli: "wrangler",
      workerdExecutable: "workerd",
      identity,
    })),
  };
});

vi.mock("./runtime.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime.ts")>()),
  profilerRuntime: runtimeMock.profilerRuntime,
}));

vi.mock("../harnessReleases/workerdLaunchAdmission.ts", () => ({
  requireWorkerdLaunchAdmissionSync: vi.fn(),
}));
vi.mock("./processResources.ts", async (original) => ({
  ...(await original<typeof import("./processResources.ts")>()),
  freeBytes: async () => 64 * 1_024 ** 3,
}));
vi.mock("./process.ts", () => ({
  runStartupProfiler: vi.fn(async (input: import("./process.ts").StartupProfilerInput) => {
    const events = [
      { event: "workerd-spawn", pid: 9002, guardPassed: true },
      { event: "workerd-close", pid: 9002, streamsClosed: [true, true, true, true] },
    ];
    await NodeFSP.writeFile(
      input.profileFile,
      JSON.stringify({
        startTime: 1,
        endTime: 218_441,
        nodes: [{ id: 1, callFrame: { functionName: "startup" } }],
        samples: [1],
        timeDeltas: [218_440],
      }),
    );
    await NodeFSP.writeFile(
      input.ledgerFile,
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
    await NodeFSP.writeFile(
      NodePath.join(input.output, "closure.json"),
      JSON.stringify({
        command: input.command,
        cwd: input.cwd,
        terminal: { code: 0, signal: null },
        wranglerPid: 9001,
        wranglerWaited: true,
        streamsClosed: [true, true],
        events,
        remainingOwnedGroup: [],
        joined: true,
        failure: null,
        failureExportError: null,
        terminationErrors: [],
        terminationDeadlineExceeded: false,
      }),
    );
    return { terminal: { code: 0, signal: null }, wallMs: 200, peakRssBytes: 1_000 };
  }),
}));

import sourceModule from "./source.ts";

const compatibility = { date: "2026-10-19", flags: ["nodejs_compat"] };
const rules = [{ globs: ["**/*.mjs"] }];
const mainBytes = 'export default { fetch() { return new Response("ok"); } };\n';
const moduleBytes = 'export const runtime = "profiled";\n';

function services() {
  return Layer.merge(
    NodeServices.layer,
    Layer.succeed(
      AlchemyArtifacts.Artifacts,
      AlchemyArtifacts.makeScopedArtifacts(
        AlchemyArtifacts.createArtifactStore(),
        "worker-startup-source-test",
      ),
    ),
  );
}

function runWithServices<A, E>(effect: Effect.Effect<A, E, SourceServices>) {
  return effect.pipe(Effect.scoped, Effect.provide(services()));
}

function workerContext(
  currentCompatibility: SourceContext["compatibility"] = compatibility,
): SourceContext {
  return {
    id: "worker-startup-test",
    fqn: "test/worker-startup",
    workerName: "worker-startup-test",
    compatibility: {
      date: currentCompatibility.date,
      flags: [...currentCompatibility.flags],
    },
    entry: { kind: "external" },
    stack: { name: "test", stage: "test" },
    env: undefined,
    extraOptions: undefined,
    assets: undefined,
  };
}

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "worker-startup-source-"));
  const main = NodePath.join(root, "worker.mjs");
  const extraModule = NodePath.join(root, "modules", "runtime.mjs");
  await NodeFSP.mkdir(NodePath.dirname(extraModule), { recursive: true });
  await NodeFSP.writeFile(main, mainBytes);
  await NodeFSP.writeFile(extraModule, moduleBytes);

  return {
    main,
    writeEvidence: (currentCompatibility = compatibility) =>
      profileWorkerStartup({ main, rules, compatibility: currentCompatibility }),
    dispose: () => NodeFSP.rm(root, { recursive: true, force: true }),
  };
}

const makeSource = (main: string) => runWithServices(sourceModule.make({ main, rules }));

function expectStartupFailure(
  effect: Effect.Effect<unknown, SourceError, SourceServices>,
  causeMessage?: string,
) {
  return Effect.gen(function* () {
    const result = yield* runWithServices(Effect.result(effect));
    if (!Result.isFailure(result)) throw new Error("Expected the startup gate to fail");
    const error = result.failure;
    expect(error).toBeInstanceOf(SourceProviderError);
    if (!(error instanceof SourceProviderError))
      throw new Error("Expected the startup gate to fail through the Worker source boundary");
    expect(error.message).toBe("The exact Worker startup gate did not pass");
    if (causeMessage !== undefined) expect(error.cause).toMatchObject({ message: causeMessage });
  });
}

describe("worker startup source provider", () => {
  it.effect("rejects missing startup evidence from both build and hash", () =>
    Effect.gen(function* () {
      const f = yield* Effect.acquireRelease(Effect.promise(fixture), (f) =>
        Effect.promise(f.dispose),
      );
      const source = yield* makeSource(f.main);
      yield* expectStartupFailure(source.build(workerContext()));
      yield* expectStartupFailure(source.hash(workerContext(), undefined));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "accepts current payload, runtime, and profile through the normal Alchemy build and hash",
    () =>
      Effect.gen(function* () {
        const f = yield* Effect.acquireRelease(Effect.promise(fixture), (f) =>
          Effect.promise(f.dispose),
        );
        yield* Effect.promise(() => f.writeEvidence());
        const source = yield* makeSource(f.main);
        const built = yield* runWithServices(source.build(workerContext()));
        expect(built.bundle?.files.map((file) => file.path)).toEqual([
          "worker.mjs",
          "modules/runtime.mjs",
        ]);
        expect(built.bundle?.files.map((file) => Buffer.from(file.content).toString())).toEqual([
          mainBytes,
          moduleBytes,
        ]);
        expect(built.hash.bundle).toBe(built.bundle?.hash);
        if (!built.bundle) throw new Error("Expected the prebuilt source to return its bundle");
        const previous: SourceHash = {
          bundle: built.bundle.hash,
          assets: undefined,
          input: undefined,
          additionalWorkspaces: undefined,
        };
        expect(yield* runWithServices(source.hash(workerContext(), previous))).toEqual({
          bundle: built.bundle.hash,
        });
      }).pipe(Effect.scoped),
  );

  it.effect("rechecks changed payload and compatibility on the no-change hash path", () =>
    Effect.gen(function* () {
      const f = yield* Effect.acquireRelease(Effect.promise(fixture), (f) =>
        Effect.promise(f.dispose),
      );
      yield* Effect.promise(() => f.writeEvidence());
      const source = yield* makeSource(f.main);
      const built = yield* runWithServices(source.build(workerContext()));
      if (!built.bundle) throw new Error("Expected the prebuilt source to return its bundle");
      const previous: SourceHash = {
        bundle: built.bundle.hash,
        assets: undefined,
        input: undefined,
        additionalWorkspaces: undefined,
      };
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          f.main,
          'export default { fetch() { return new Response("changed"); } };\n',
        ),
      );
      yield* expectStartupFailure(
        source.hash(workerContext(), previous),
        "WORKER_STARTUP_PROFILE_STALE_PAYLOAD",
      );
      yield* Effect.promise(() => NodeFSP.writeFile(f.main, mainBytes));
      for (const changed of [
        { ...compatibility, date: "2026-10-20" },
        { ...compatibility, flags: [] },
      ])
        yield* expectStartupFailure(
          source.hash(workerContext(changed), previous),
          "WORKER_STARTUP_PROFILE_STALE_PAYLOAD",
        );
    }).pipe(Effect.scoped),
  );
  it.effect("rejects a standalone profile sidecar without its profiler invocation", () =>
    Effect.gen(function* () {
      const f = yield* Effect.acquireRelease(Effect.promise(fixture), (f) =>
        Effect.promise(f.dispose),
      );
      yield* Effect.promise(async () => {
        const bundle = await readStartupBundle({ main: f.main, rules }, compatibility);
        const bytes = Buffer.from(
          JSON.stringify({
            startTime: 1,
            endTime: 2,
            nodes: [{ id: 1, callFrame: { functionName: "startup" } }],
            samples: [1],
            timeDeltas: [1],
          }),
        );
        await NodeFSP.writeFile(
          NodePath.join(NodePath.dirname(f.main), "fabricated.cpuprofile"),
          bytes,
        );
        await NodeFSP.writeFile(
          `${f.main}.startup-profile.json`,
          JSON.stringify({
            schema: "signalbox/worker-startup-profile/v2",
            status: "passed",
            payloadSha256: startupPayload(bundle, compatibility).sha256,
            budgetMs: 500,
            profileFile: "fabricated.cpuprofile",
            profileSha256: sha256(bytes),
            invocationSha256: "e".repeat(64),
            runtime: runtimeMock.identity,
            invocation: {
              wranglerExitCode: 0,
              workerdStarts: 1,
              workerdClosed: true,
              guardPassed: true,
            },
          }),
        );
      });
      const source = yield* makeSource(f.main);
      yield* expectStartupFailure(source.build(workerContext()));
      yield* expectStartupFailure(source.hash(workerContext(), undefined));
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a changed child ledger after a completed producer receipt", () =>
    Effect.gen(function* () {
      const f = yield* Effect.acquireRelease(Effect.promise(fixture), (f) =>
        Effect.promise(f.dispose),
      );
      yield* Effect.promise(() => f.writeEvidence());
      yield* Effect.promise(() =>
        NodeFSP.appendFile(`${f.main}.startup-profile/native-children.jsonl`, "{}\n"),
      );
      const source = yield* makeSource(f.main);
      yield* expectStartupFailure(
        source.hash(workerContext(), undefined),
        "WORKER_STARTUP_INVOCATION_FILES_CHANGED",
      );
    }).pipe(Effect.scoped),
  );
});
