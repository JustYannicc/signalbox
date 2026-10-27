import {
  createRecordingHost,
  type Grant,
  type Options,
  type Host,
} from "./recordingHost.fixture.ts";
import { expect } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { encodeHarnessCProductNativeCheckpoint } from "../../HarnessCProductCheckpoint.ts";
import { createMemoryFilePersistencePorts } from "../../../kernel/MemoryFilePersistencePorts.ts";
import { machineInventoryFixture } from "../../../computer/machineInventoryTesting.ts";
import { type HarnessCheckpoint } from "../../Harness.ts";
import type {
  HostOpenInput,
  TurnAccess,
  HarnessMcpTurnGrantSource,
} from "../../HarnessSessionHost.ts";
import type { HarnessFilesStoreResult } from "../../HarnessFilesStore.ts";
import type { HarnessFacetRequestContext } from "../../HarnessRequestFacet.ts";
import { HarnessRequestFacetError } from "../../HarnessRequestFacet.ts";
import type { HarnessThreadSupervisorPublisher } from "../../HarnessThreadSupervisor.ts";
import { hostSqlite } from "../../tests/hostSqlite.ts";
import { dataForDriver } from "../../adapter/tests/data.ts";
import {
  HARNESS_C_PRODUCT_CAPABILITY_KEYS,
  narrowHarnessCProductCapabilities,
} from "../../HarnessCProductCapabilities.ts";
import type { HarnessCProductTurnGrantSource } from "../../HarnessCProductCapabilities.ts";
import type {
  HarnessCProductFacetEnvironment,
  HarnessCProductFacetFactory,
} from "../../HarnessCProductFacet.ts";
import { prepareHarnessCProductHost } from "../../HarnessCProductFacet.ts";
import {
  emptyArtifact,
  reference,
  releaseSource,
  prepareFilesCheckpoint,
} from "./artifacts.fixture.ts";

export const prepareProductFixture = (
  provider: "claude-code" | "codex",
  restoreMode: "same-variant-serialized-checkpoint" | "cross-variant-fresh-boot",
  faults: {
    readonly failSeed?: "assets" | "programs";
    readonly openNativeSessionId?: string;
    readonly turnGrantSource?: HarnessCProductTurnGrantSource<Grant>;
    readonly onDispose?: () => void;
  } = {},
) =>
  Effect.gen(function* () {
    const source = yield* Effect.promise(() => releaseSource(provider));
    const priorProvider =
      restoreMode === "same-variant-serialized-checkpoint"
        ? provider
        : provider === "codex"
          ? "claude-code"
          : "codex";
    const a = yield* dataForDriver(ProviderDriverKind.make(priorProvider));
    const b = yield* dataForDriver(ProviderDriverKind.make(provider));
    const nativeSessionId = a.providerThread.nativeThreadRef!.nativeId;
    const checkpoint: HarnessCheckpoint = {
      release: {
        harness: priorProvider,
        version: "a-release",
        manifestSha256: "a".repeat(64),
        modules: {},
      },
      providerSession: a.providerSession,
      snapshot: {
        providerThread: a.providerThread,
        providerTurns: [],
        messages: [],
        runtimeRequests: [],
      },
      revision: { commit: "a-workspace-revision" },
    };
    const nativeBytes = new TextEncoder().encode(
      encodeHarnessCProductNativeCheckpoint({ schemaVersion: 1, nativeSessionId, checkpoint }),
    );
    const checkpointId = "checkpoint-a";
    const files = [
      {
        path: ".claude/projects/thread/transcript.jsonl",
        mode: 0o600,
        bytes: new TextEncoder().encode("transcript from A\n"),
      },
      { path: ".claude/index", mode: 0o644, bytes: new Uint8Array([73, 68, 88]) },
      { path: "workspace.txt", mode: 0o640, bytes: new Uint8Array([65, 0, 255]) },
    ];
    const manifest = yield* Effect.promise(() =>
      prepareFilesCheckpoint({ checkpointId, parentCheckpointId: null, files }),
    );
    const manifestRevision = manifest.manifestSha256;
    const checkpointRefs = {
      native: yield* Effect.promise(() => reference(checkpointId, nativeBytes)),
      filesystem: { id: "files-a", bytes: manifest.byteCount, sha256: manifestRevision },
    };
    const filesCheckpoint: HarnessFilesStoreResult = {
      action: "read",
      checkpoint: { checkpointId, manifestSha256: manifestRevision },
      parentCheckpointId: null,
      activeStepId: null,
      admissionResolution: null,
      publication: null,
      files,
    };
    const filesPublisher: HarnessThreadSupervisorPublisher = {
      generation: 2,
      facetNonce: "facet-a",
      publisherKey: "p".repeat(32),
    };
    const database = yield* Effect.acquireRelease(Effect.sync(hostSqlite), (value) =>
      Effect.sync(() => value.dispose()),
    );
    const db = database.open();
    yield* Effect.addFinalizer(() => Effect.sync(() => db.close()));
    const hostFiles = {
      identity: "product-bootstrap-thread-files",
      database: db.storage,
      nowNs: () => 0n,
      persistencePorts: createMemoryFilePersistencePorts(),
      rootMetadata: { mode: 0o755, uid: 1000, gid: 1000 },
      posix: { credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 }, umask: 0o022 },
      assetMode: 0o644,
      cwd: "/workspace",
    };
    const initialAccesses: Grant[] = [];
    const turnAccesses: Grant[] = [];
    const observedTurnGrants: TurnAccess<Grant>[] = [];
    const observedTurnGrantSources: Array<HarnessMcpTurnGrantSource<Grant> | undefined> = [];
    const seeded: string[] = [];
    const openInputs: HostOpenInput<Grant>[] = [];
    const resolvedRequests: string[] = [];
    let checkpointWrites = 0;
    let disposed = 0;
    const rpc = (value: object) => value as unknown as Fetcher;
    const capabilityMap: Record<string, Fetcher> = {
      [HARNESS_C_PRODUCT_CAPABILITY_KEYS.release]: rpc({
        getArtifact: async () => source.artifact,
        loaderConfig: async () => ({
          trustedComputer: source.trustedComputer,
          maxPreparedModuleBytes: source.maxPreparedModuleBytes,
        }),
        readArtifact: source.readArtifact,
        readArtifactChunk: async (
          artifactRef: string,
          path: string,
          offset: number,
          length: number,
        ) => {
          const bytes = await source.readArtifact(artifactRef, path);
          return bytes.slice(offset, offset + length);
        },
      }),
      [HARNESS_C_PRODUCT_CAPABILITY_KEYS.nativeCheckpoint]: rpc({
        read: async () => nativeBytes.slice(),
      }),
      [HARNESS_C_PRODUCT_CAPABILITY_KEYS.access]: rpc({
        resolveInitialAccess: async () => {
          const grant: Grant = {
            kind: "initial",
            requestId: "prepare",
            call: initialAccesses.length + 1,
          };
          initialAccesses.push(grant);
          return { grant, connections: { servers: [] } };
        },
        resolveTurnAccess: async (input: { requestId: string }) => {
          const grant: Grant = {
            kind: "turn",
            requestId: input.requestId,
            call: turnAccesses.length + 1,
          };
          resolvedRequests.push(input.requestId);
          turnAccesses.push(grant);
          return { grant, connections: { servers: [] } };
        },
      }),
      [HARNESS_C_PRODUCT_CAPABILITY_KEYS.programs]: rpc({
        catalog: async () => ({ sourceIdentity: "program-source", codes: {}, files: {} }),
        read: async () => new Uint8Array(),
      }),
      [HARNESS_C_PRODUCT_CAPABILITY_KEYS.machine]: rpc({
        inventory: async () => machineInventoryFixture(),
      }),
      [HARNESS_C_PRODUCT_CAPABILITY_KEYS.model]: rpc({ fetch: async () => new Response("model") }),
      [HARNESS_C_PRODUCT_CAPABILITY_KEYS.executor]: rpc({
        forward: async () => ({
          status: 200,
          statusText: "OK",
          headers: [],
          body: new Uint8Array(),
        }),
      }),
    };
    if (faults.turnGrantSource !== undefined)
      capabilityMap[HARNESS_C_PRODUCT_CAPABILITY_KEYS.turnGrantSource] = rpc(
        faults.turnGrantSource,
      );
    const capabilities = narrowHarnessCProductCapabilities<Grant>(capabilityMap);
    const env = {
      HARNESS_C_PRODUCT_BOOTSTRAP: {
        provider,
        preparedReleaseId: source.artifact.releaseId,
        restoreMode,
      },
      HARNESS_C_TARGET_PREPARED_RELEASE: source.expected,
      HARNESS_C_PRODUCT_CAPABILITIES: capabilityMap,
    } as unknown as HarnessCProductFacetEnvironment;
    const turnBindings = {
      readTurn: () => Effect.succeed(b.turn),
      onEvent: () => Effect.succeed(emptyArtifact("event")),
      writeResult: () => Effect.succeed(emptyArtifact("result")),
      writeCheckpoint: () =>
        Effect.sync(() => {
          checkpointWrites++;
          return checkpointRefs;
        }),
      verify: () => Effect.void,
    };
    const factory: HarnessCProductFacetFactory<
      HarnessCProductFacetEnvironment,
      Grant,
      unknown,
      Options,
      Host
    > = {
      provider,
      buildHostOptions: ({ selectedRelease }) => {
        if (selectedRelease.artifact !== source.artifact)
          return Effect.fail(
            new HarnessRequestFacetError("The selected artifact was not the ledger result."),
          );
        return Effect.succeed({
          threadId: b.threadId,
          files: hostFiles,
          native: {},
          commands: {} as Options["commands"],
          save: async () => ({ commit: "unused" }),
          port: async () => ({ fetch: async () => new Response("port") }),
        });
      },
      buildOpenInput: ({ nativeSessionId: sessionId }) =>
        Effect.succeed({
          session: {
            threadId: b.threadId,
            providerSessionId: b.providerSessionId,
            modelSelection: b.modelSelection,
            runtimePolicy: {
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: "/workspace",
            },
            initialNativeThreadId: faults.openNativeSessionId ?? sessionId,
          },
          bootAttemptId: "product-bootstrap",
        }),
      buildTurnBindings: () => Effect.succeed(turnBindings),
      createHost: (options) => {
        observedTurnGrantSources.push(options.turnGrantSource);
        return createRecordingHost({
          options,
          source,
          checkpoint,
          files,
          observedTurnGrants,
          seeded,
          openInputs,
          faults,
          onDispose: () => {
            disposed++;
            faults.onDispose?.();
          },
        });
      },
    };
    const filesStore = {
      execute: async (command: unknown) => {
        expect(command).toEqual({
          type: "readCheckpoint",
          runId: "run-c",
          publisher: filesPublisher,
          checkpointId,
        });
        return filesCheckpoint;
      },
    };
    const preparationSignal = new AbortController().signal;
    const prepared = yield* prepareHarnessCProductHost({
      env,
      ctx: {} as DurableObjectState,
      facetNonce: "facet-b",
      runId: "run-c",
      descriptor: env.HARNESS_C_PRODUCT_BOOTSTRAP!,
      expected: source.expected,
      capabilities,
      resume: {
        runStore: {
          execute: async () => {
            throw new Error("Unexpected RunStore access.");
          },
        },
        filesStore,
        supervisor: {
          execute: async () => {
            throw new Error("Unexpected supervisor access.");
          },
        },
      },
      turnBindings,
      factory,
      checkpointRefs,
      publisher: filesPublisher,
      checkpointId,
      manifestRevision,
      nativeSessionId,
      signal: preparationSignal,
    });
    const context = (requestId: string): HarnessFacetRequestContext => ({
      requestId,
      publisher: { generation: 3, facetNonce: "facet-b", publisherKey: "b".repeat(32) },
      signal: new AbortController().signal,
      check: Effect.void,
      progress: () => Effect.void,
    });
    return {
      prepared,
      checkpointRefs,
      checkpoint,
      openInputs,
      initialAccesses,
      turnAccesses,
      observedTurnGrants,
      observedTurnGrantSources,
      seeded,
      resolvedRequests,
      preparationSignal,
      context,
      checkpointWrites: () => checkpointWrites,
      disposed: () => disposed,
      input: yield* Effect.promise(() => reference("turn-input", new TextEncoder().encode("turn"))),
    };
  });
