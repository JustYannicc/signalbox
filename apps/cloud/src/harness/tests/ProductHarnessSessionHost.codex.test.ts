import { expect, vi } from "vite-plus/test";
import { ProviderDriverKind, type OrchestrationV2ProviderThread } from "@t3tools/contracts";
import { dataForDriver } from "../adapter/tests/data.ts";
import type { ProductComputerOptions } from "../../computer/ProductComputer.ts";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import type { CodexHarnessProcess, CodexHarnessProcessOptions } from "../CodexHarnessProcess.ts";
import { codexFixture, claudeFixture } from "../releaseLoader/tests/artifactFixtures.ts";
import {
  processFixture,
  readyLine,
  session as codexSession,
} from "../codex/tests/preinitializedFixture.ts";
import { productOptions } from "./productHost/codex.ts";
import { createNodeFs } from "../../isolate/NodeFs.ts";

const launch = vi.hoisted(() =>
  vi.fn<(input: CodexHarnessProcessOptions) => Promise<CodexHarnessProcess>>(),
);
const captureProductComputer = vi.hoisted(() =>
  vi.fn<(options: Pick<ProductComputerOptions, "home" | "machineInventory">) => void>(),
);
vi.mock("../CodexHarnessProcess.ts", () => ({ startCodexHarnessProcess: launch }));
vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));
vi.mock("../../computer/ProductComputer.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../computer/ProductComputer.ts")>();
  return {
    ...actual,
    createProductComputer: (options: Parameters<typeof actual.createProductComputer>[0]) => {
      captureProductComputer(options);
      return actual.createProductComputer(options);
    },
  };
});

const services = Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer);

const productThread = (
  thread: Effect.Success<ReturnType<typeof dataForDriver>>["providerThread"],
): OrchestrationV2ProviderThread => ({
  ...thread,
  appThreadId: codexSession.threadId,
  providerSessionId: codexSession.providerSessionId,
  providerInstanceId: codexSession.modelSelection.instanceId,
  nativeThreadRef: null,
});

const productTurn = (
  turn: Effect.Success<ReturnType<typeof dataForDriver>>["turn"],
  providerThread: OrchestrationV2ProviderThread,
) => ({
  ...turn,
  threadId: codexSession.threadId,
  appThread: {
    ...turn.appThread,
    id: codexSession.threadId,
    providerInstanceId: codexSession.modelSelection.instanceId,
    modelSelection: codexSession.modelSelection,
    activeProviderThreadId: providerThread.id,
    lineage: { ...turn.appThread.lineage, rootThreadId: codexSession.threadId },
  },
  providerThread,
  modelSelection: codexSession.modelSelection,
});

const openColdProductSession = (
  product: Effect.Success<ReturnType<typeof productOptions>>,
  bootAttemptId: string,
  rejectTurnReads = false,
) =>
  Effect.gen(function* () {
    const data = yield* dataForDriver(ProviderDriverKind.make("codex"));
    const path = "/separate/config/codex/sessions/preinitialized.jsonl";
    const peer = processFixture(undefined, {
      path,
      rejectTurnReads,
      archive: () => {
        const fs = createNodeFs(product.host.computer.files).fs;
        fs.mkdirSync("/separate/config/codex/sessions", { recursive: true });
        fs.writeFileSync(
          path,
          JSON.stringify({
            type: "session_meta",
            payload: { id: "preinitialized-native-thread" },
          }) + "\n",
        );
      },
    });
    yield* Effect.addFinalizer(() => Effect.promise(() => peer.process.abort()));
    (yield* Effect.promise(() => peer.output)).enqueue(new TextEncoder().encode(readyLine));
    launch.mockImplementation(async () => peer.process);
    const providerThread = productThread(data.providerThread);
    const access = {
      grant: {},
      connections: { servers: [] },
      signal: new AbortController().signal,
      publisher: { generation: 1, facetNonce: "product-codex-test-publisher" },
    };
    const session = yield* product.host.open({
      session: codexSession,
      bootAttemptId,
      creation: { providerThread },
      initialAccess: access,
    });
    yield* Effect.addFinalizer(() => Effect.orDie(session.dispose));
    return { data, peer, providerThread, access, session };
  });

it.effect(
  "routes the public Codex composition through its bound Computer and native transports",
  () =>
    Effect.gen(function* () {
      launch.mockReset();
      const release = yield* Effect.promise(() => codexFixture());
      const product = yield* productOptions(release.options);
      const peer = processFixture();
      yield* Effect.addFinalizer(() => Effect.promise(() => peer.process.abort()));
      (yield* Effect.promise(() => peer.output)).enqueue(new TextEncoder().encode(readyLine));
      let processOptions: CodexHarnessProcessOptions | undefined;
      launch.mockImplementation(async (input) => {
        processOptions = input;
        return peer.process;
      });
      const session = yield* product.host.open({
        session: codexSession,
        bootAttemptId: "product-codex-open",
      });
      yield* Effect.addFinalizer(() => Effect.orDie(session.dispose));
      if (processOptions === undefined) throw new Error("Codex process did not start");
      expect(processOptions.computer).toBe(product.host.computer);
      expect(processOptions.host).toBe(product.host.commands.host);
      expect(processOptions.stdio.filesystem).toBe(product.host.computer.files);
      processOptions.stdio.assertBound(product.host.computer.files);

      const model = yield* Effect.promise(() =>
        processOptions!.fetch(new Request("https://models.product.test/v1")),
      );
      expect(yield* Effect.promise(() => model.text())).toBe("product model transport");
      expect(product.modelCalls).toBe(1);
      const local = yield* Effect.promise(() =>
        processOptions!.fetch(new Request("http://127.0.0.1:8787/")),
      );
      expect(yield* Effect.promise(() => local.text())).toBe("port");
      yield* Effect.promise(() =>
        expect(
          processOptions!.fetch(new Request("https://harness-mcp.invalid/no-active-route")),
        ).rejects.toMatchObject({ message: "Harness MCP request is unavailable." }),
      );
      const external = yield* Effect.promise(() =>
        processOptions!.fetch(new Request("https://external.product.test/")),
      );
      expect(yield* Effect.promise(() => external.text())).toBe("fallback fetch");
      expect(product.fallbackCalls).toBe(1);

      const computerOptions = captureProductComputer.mock.calls.at(-1)?.[0];
      expect(computerOptions?.home).toBe("/home/product-codex");
      expect(computerOptions?.machineInventory).toBe(product.options.machineInventory);
      const native = product.options.native;
      if (native.harness !== "codex") throw new Error("Expected Codex native options");
      expect(computerOptions?.home).toBe(native.process.environment.HOME);
      expect(computerOptions?.home).not.toBe(native.process.bootstrap.codex_home);
    }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("returns the caller-selected artifact with the actual product loader projection", () =>
  Effect.gen(function* () {
    launch.mockReset();
    const release = yield* Effect.promise(() => codexFixture());
    const selected = {
      provider: "codex" as const,
      releaseId: "selected-codex-process-release",
      artifactHash: release.options.identity.artifactHash,
      artifactRef: release.options.identity.artifactRef,
      sourceIdentity: release.options.identity.sourceIdentity,
      fixtureIdentity: "codex-process-resume-fixture",
      createdAt: "2026-10-26T00:00:00.000Z",
    };
    const product = yield* productOptions(release.options, "/home/product-codex", selected);
    expect(() => product.host.loadedPreparedRelease()).toThrow(
      "The product host has not completed its verified release load.",
    );

    const peer = processFixture();
    yield* Effect.addFinalizer(() => Effect.promise(() => peer.process.abort()));
    (yield* Effect.promise(() => peer.output)).enqueue(new TextEncoder().encode(readyLine));
    launch.mockImplementation(async () => peer.process);
    const session = yield* product.host.open({
      session: codexSession,
      bootAttemptId: "product-codex-release-observation",
    });
    yield* Effect.addFinalizer(() => Effect.orDie(session.dispose));

    const observed = product.host.loadedPreparedRelease();
    expect(observed.artifact).toEqual(selected);
    expect(observed.plan.release).toMatchObject({
      harness: "codex",
      manifestSha256: selected.artifactHash,
    });
    expect(observed.plan.sourceIdentity).toBe(selected.sourceIdentity);
    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(observed.plan.release.modules)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("requires an explicit full release artifact for process resume observation", () =>
  Effect.gen(function* () {
    const release = yield* Effect.promise(() => codexFixture());
    const product = yield* productOptions(release.options);
    expect(() => product.host.loadedPreparedRelease()).toThrow(
      "Product process resume requires a caller-selected full HarnessReleaseArtifact.",
    );
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect(
  "rejects a Codex binding against a Claude release before starting the native engine",
  () =>
    Effect.gen(function* () {
      launch.mockReset();
      const release = yield* Effect.promise(() => claudeFixture());
      const product = yield* productOptions(release.options);
      const outcome = yield* product.host
        .open({ session: codexSession, bootAttemptId: "mismatched-product-release" })
        .pipe(Effect.exit);
      expect(Exit.isFailure(outcome)).toBe(true);
      expect(launch).not.toHaveBeenCalled();
    }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("rejects a non-absolute Codex HOME before starting the native engine", () =>
  Effect.gen(function* () {
    launch.mockReset();
    const release = yield* Effect.promise(() => codexFixture());
    const product = yield* productOptions(release.options, "relative/home");
    const outcome = yield* product.host
      .open({ session: codexSession, bootAttemptId: "invalid-product-home" })
      .pipe(Effect.exit);
    expect(Exit.isFailure(outcome)).toBe(true);
    expect(launch).not.toHaveBeenCalled();
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("closes product stdio and Computer after native acquisition fails", () =>
  Effect.gen(function* () {
    launch.mockReset();
    const release = yield* Effect.promise(() => codexFixture());
    const product = yield* productOptions(release.options);
    const nativeFailure = new Error("native initialization failed", {
      cause: new Error("missing WASI import"),
    });
    let processOptions: CodexHarnessProcessOptions | undefined;
    launch.mockImplementation(async (input) => {
      processOptions = input;
      throw nativeFailure;
    });
    const result = yield* product.host
      .open({
        session: codexSession,
        bootAttemptId: "failed-product-native",
      })
      .pipe(Effect.exit);
    expect(Exit.isFailure(result)).toBe(true);
    if (processOptions === undefined) throw new Error("Native acquisition was not attempted");
    expect(processOptions.signal.aborted).toBe(true);
    expect(() => processOptions!.stdio.assertBound(product.host.computer.files)).toThrow(
      "disposed",
    );
    expect(() => product.host.computer.files.stat("/bin/bash")).toThrow("disposed");
    if (Exit.isSuccess(result)) throw new Error("Expected native failure");
    expect(Cause.pretty(result.cause)).toContain("native initialization failed");
    const rows = [
      ...product.options.files.database.sql.exec("SELECT error_json FROM harness_host_failures"),
    ];
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.error_json)).toContain("missing WASI import");
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("uses the cold native Codex thread for the first fresh-grant turn", () =>
  Effect.gen(function* () {
    launch.mockReset();
    const release = yield* Effect.promise(() => codexFixture());
    const issuedRuns: string[] = [];
    const product = yield* productOptions(release.options, undefined, undefined, {
      issue: async ({ runId }) => {
        issuedRuns.push(runId);
        return { grant: { runId }, endpoint: "https://gateway.product.test" };
      },
    });
    const { data, peer, providerThread, access, session } = yield* openColdProductSession(
      product,
      "product-codex-cold-open",
    );
    expect(launch).toHaveBeenCalledTimes(1);
    expect(peer.sent.filter((method) => method === "thread/start")).toHaveLength(1);
    expect(peer.sent).not.toContain("thread/resume");
    expect(peer.sent).not.toContain("turn/start");
    const initial = yield* session.export();
    expect(initial.snapshot.providerThread.nativeThreadRef?.nativeId).toBe(
      "preinitialized-native-thread",
    );
    expect(initial.snapshot.providerTurns).toEqual([]);
    yield* session.retireCheckpointAccess;
    const turn = productTurn(data.turn, providerThread);
    expect(turn.providerThread.nativeThreadRef).toBeNull();
    yield* session.turn({ turn, access });
    expect(issuedRuns).toEqual([turn.runId]);
    expect(peer.sent.filter((method) => method === "thread/start")).toHaveLength(1);
    expect(peer.sent.filter((method) => method === "thread/resume")).toHaveLength(1);
    expect(peer.sent.filter((method) => method === "turn/start")).toHaveLength(1);
    expect(peer.sent).toEqual([
      "thread/start",
      "thread/read",
      "thread/archive",
      "thread/unarchive",
      "thread/read",
      "thread/read",
      "thread/resume",
      "turn/start",
    ]);
    expect(
      peer.requests.find((request) => request.method === "thread/resume")?.params,
    ).toMatchObject({ threadId: initial.snapshot.providerThread.nativeThreadRef?.nativeId });
    expect(peer.requests.find((request) => request.method === "turn/start")?.params).toMatchObject({
      threadId: initial.snapshot.providerThread.nativeThreadRef?.nativeId,
    });
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("exports the native rollout when paginated turn reads are unsupported", () =>
  Effect.gen(function* () {
    launch.mockReset();
    const release = yield* Effect.promise(() => codexFixture());
    const product = yield* productOptions(release.options);
    const { peer, session } = yield* openColdProductSession(
      product,
      "product-codex-checkpoint-without-turns",
      true,
    );
    yield* session.retireCheckpointAccess;
    const checkpoint = yield* session.export();
    const nativeId = checkpoint.snapshot.providerThread.nativeThreadRef?.nativeId;
    expect(nativeId).toBe("preinitialized-native-thread");
    expect(checkpoint.snapshot.providerTurns).toEqual([]);
    expect(checkpoint.snapshot.messages).toEqual([]);
    const reads = peer.requests.filter((request) => request.method === "thread/read");
    expect(reads.length).toBeGreaterThan(0);
    for (const request of reads)
      expect(request.params).toEqual({ threadId: nativeId, includeTurns: false });
    expect(
      peer.requests
        .filter((request) => ["thread/archive", "thread/unarchive"].includes(request.method))
        .map((request) => request.params),
    ).toEqual([{ threadId: nativeId }, { threadId: nativeId }]);
    const fs = createNodeFs(product.host.computer.files).fs;
    expect(
      fs.readFileSync("/separate/config/codex/sessions/preinitialized.jsonl", "utf8"),
    ).toContain(`"id":"${nativeId}"`);
    expect(peer.sent).not.toContain("turn/start");
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("rejects a known native thread ID mismatch before native load or turn", () =>
  Effect.gen(function* () {
    launch.mockReset();
    const release = yield* Effect.promise(() => codexFixture());
    let grantIssueCount = 0;
    const product = yield* productOptions(release.options, undefined, undefined, {
      issue: async () => {
        grantIssueCount++;
        return { grant: {}, endpoint: "https://gateway.product.test" };
      },
    });
    const { data, peer, providerThread, access, session } = yield* openColdProductSession(
      product,
      "product-codex-cold-open-wrong-native-id",
    );
    const initial = yield* session.export();
    yield* session.retireCheckpointAccess;
    const beforeTurn = [...peer.sent];
    const turn = productTurn(data.turn, {
      ...providerThread,
      nativeThreadRef: {
        driver: providerThread.driver,
        nativeId: "wrong-native-thread",
        strength: "strong",
      },
    });

    const outcome = yield* session.turn({ turn, access }).pipe(Effect.exit);
    expect(Exit.isFailure(outcome)).toBe(true);
    expect(initial.snapshot.providerThread.nativeThreadRef?.nativeId).toBe(
      "preinitialized-native-thread",
    );
    expect(grantIssueCount).toBe(0);
    expect(peer.sent).toEqual(beforeTurn);
    expect(peer.sent).not.toContain("turn/start");
  }).pipe(Effect.scoped, Effect.provide(services)),
);
