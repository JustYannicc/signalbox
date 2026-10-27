import * as Effect from "effect/Effect";
import { ProviderDriverKind } from "@t3tools/contracts";
import {
  HARNESS_C_PRODUCT_CAPABILITY_KEYS,
  type HarnessCProductCapabilities,
} from "../../HarnessCProductCapabilities.ts";
import type { HarnessCheckpoint } from "../../Harness.ts";
import type { HarnessFacetRequestContext } from "../../HarnessRequestFacet.ts";
import { HarnessRequestFacetError } from "../../HarnessRequestFacet.ts";
import type { HarnessRequestCheckpoint, HarnessRunArtifact } from "../../HarnessRunStore.ts";
import type { HarnessThreadSupervisorPublisher } from "../../HarnessThreadSupervisor.ts";
import type { HarnessFilesCheckpoint } from "../../HarnessFilesStore.ts";
import {
  type HarnessCProductFacetEnvironment,
  type HarnessCProductFacetFactory,
  type HarnessCProductTurnBindings,
  type ProductHostOptions,
  composeHarnessCProductFacetOptions,
} from "../../HarnessCProductFacet.ts";
import { machineInventoryFixture } from "../../../computer/machineInventoryTesting.ts";
import { prepareHarnessFilesCheckpoint as prepareCheckpoint } from "../../HarnessFilesStore.ts";
import { dataForDriver } from "../../adapter/tests/data.ts";
import { createFreshProductNativePeer } from "./freshProductHost.peer.fixture.ts";
import { programFixture } from "../../tests/productHost/commands.ts";
import { releaseSource } from "./artifacts.fixture.ts";

const publisherKey = "p".repeat(32);
const artifact = (id: string): HarnessRunArtifact => ({
  id,
  bytes: 1,
  sha256: "a".repeat(64),
});
export const freshProductHostFixture = Effect.gen(function* () {
  const source = yield* Effect.promise(() => releaseSource("codex"));
  const data = yield* dataForDriver(ProviderDriverKind.make("codex"));
  const order: string[] = [];
  const peer = yield* createFreshProductNativePeer({
    data,
    preparedRelease: source.expected,
    order,
  });
  const verifyCalls: string[] = [];
  const { opened, host } = peer;
  const accessCalls: string[] = [];
  const initialCheckpoints: HarnessCheckpoint[] = [];
  const initialPublishers: HarnessThreadSupervisorPublisher[] = [];
  const nativeArtifact = artifact("initial-checkpoint");
  const initialFiles: HarnessFilesCheckpoint = {
    checkpointId: nativeArtifact.id,
    parentCheckpointId: null,
    files: [
      {
        path: ".codex/sessions/fresh/native.json",
        mode: 0o600,
        bytes: new TextEncoder().encode(peer.nativeSessionId),
      },
    ],
  };
  const initialManifest = yield* Effect.tryPromise({
    try: () => prepareCheckpoint(initialFiles),
    catch: (cause) => new HarnessRequestFacetError("Initial files are invalid.", { cause }),
  });
  const requestCheckpoint: HarnessRequestCheckpoint = {
    native: nativeArtifact,
    filesystem: { ...artifact("initial-files"), sha256: initialManifest.manifestSha256 },
  };
  const options = {
    threadId: data.threadId,
    files: {} as ProductHostOptions<{ readonly token: string }, unknown>["files"],
    native: {},
    commands: {} as ProductHostOptions<{ readonly token: string }, unknown>["commands"],
    save: async () => ({ commit: "unused" }),
    port: async () => ({ fetch: async () => new Response("port") }),
  } as Omit<
    ProductHostOptions<{ readonly token: string }, unknown>,
    | "release"
    | "processResumeArtifact"
    | "programs"
    | "machineInventory"
    | "modelTransport"
    | "executor"
  >;
  const programs = yield* Effect.promise(programFixture);
  const capabilities: HarnessCProductCapabilities<{ readonly token: string }> = {
    release: {
      getArtifact: async () => source.artifact,
      loaderConfig: async () => ({
        trustedComputer: source.trustedComputer,
        maxPreparedModuleBytes: source.maxPreparedModuleBytes,
      }),
      readArtifact: source.readArtifact,
      readArtifactChunk: async (artifactRef, path, offset, length) =>
        (await source.readArtifact(artifactRef, path)).slice(offset, offset + length),
    },
    nativeCheckpoint: {
      read: async () => {
        throw new Error("Fresh creation must not read a prior native checkpoint.");
      },
    },
    access: {
      resolveInitialAccess: async () => ({
        grant: { token: "restore" },
        connections: { servers: [] },
      }),
      resolveFreshAccess: async (input) => {
        accessCalls.push(`fresh:${input.operationId}`);
        order.push("fresh-access");
        return { grant: { token: "initial" }, connections: { servers: [] } };
      },
      resolveTurnAccess: async (input) => {
        accessCalls.push(`turn:${input.requestId}`);
        return { grant: { token: "turn" }, connections: { servers: [] } };
      },
    },
    programs: {
      catalog: async () => ({
        sourceIdentity: programs.seed.sourceIdentity,
        codes: programs.codes,
        files: programs.seed.files,
      }),
      read: (path) => programs.seed.read(path, new AbortController().signal),
    },
    machine: { inventory: async () => machineInventoryFixture() },
    model: { fetch: async () => new Response("model") },
    executor: {
      forward: async () => ({ status: 200, statusText: "OK", headers: [], body: new Uint8Array() }),
    },
  };
  const capabilityMap = Object.fromEntries(
    Object.entries(capabilities).map(([key, value]) => [
      HARNESS_C_PRODUCT_CAPABILITY_KEYS[key as keyof typeof HARNESS_C_PRODUCT_CAPABILITY_KEYS],
      value as unknown as Fetcher,
    ]),
  );
  const runStore = {
    execute: async () => {
      throw new Error("No prior RunStore read expected.");
    },
  };
  const filesStore = {
    execute: async () => {
      throw new Error("No prior files read expected.");
    },
  };
  const supervisor = {
    execute: async () => {
      throw new Error("No prior supervisor read expected.");
    },
  };
  const env = {
    HARNESS_C_PRODUCT_BOOTSTRAP: {
      provider: "codex",
      preparedReleaseId: source.artifact.releaseId,
      restoreMode: "cross-variant-fresh-boot",
    },
    HARNESS_C_TARGET_PREPARED_RELEASE: source.expected,
    HARNESS_C_PRODUCT_CAPABILITIES: capabilityMap,
    HARNESS_RESUME_RUN_ID: "run-fresh",
    HARNESS_RESUME_CREATION: true,
    HARNESS_RESUME_CONTROL: {
      ownerId: "owner",
      incarnationId: "incarnation",
      epoch: 1,
      controlKey: "c".repeat(32),
    },
    HARNESS_RESUME_RUN_STORE: runStore,
    HARNESS_RESUME_FILES_STORE: filesStore,
    HARNESS_RESUME_SUPERVISOR: supervisor,
  } as unknown as HarnessCProductFacetEnvironment;
  const turnBindings: HarnessCProductTurnBindings<{ readonly token: string }> = {
    readTurn: () => Effect.succeed(data.turn),
    onEvent: (_item, context) => Effect.succeed(artifact(`event-${context.requestId}`)),
    writeResult: (_input, context) => Effect.succeed(artifact(`result-${context.requestId}`)),
    writeCheckpoint: () => Effect.succeed(requestCheckpoint),
    verify: (reference, purpose) =>
      Effect.sync(() => {
        verifyCalls.push(`${reference.id}:${purpose}`);
      }),
    writeInitialCheckpoint: (checkpoint, context) =>
      Effect.sync(() => {
        order.push("write-initial");
        initialCheckpoints.push(checkpoint);
        initialPublishers.push(context.publisher);
        return { checkpoint: requestCheckpoint, filesCheckpoint: initialFiles };
      }),
  };
  const factory: HarnessCProductFacetFactory<
    HarnessCProductFacetEnvironment,
    { readonly token: string },
    unknown,
    ProductHostOptions<{ readonly token: string }, unknown> & {
      readonly processResumeArtifact?: import("../../../harnessReleases/HarnessReleaseLedger.ts").HarnessReleaseArtifact;
    },
    typeof host
  > = {
    provider: "codex",
    createHost: () => Effect.succeed(host),
    buildHostOptions: () => Effect.fail(new HarnessRequestFacetError("Restore path must not run.")),
    buildOpenInput: () => Effect.fail(new HarnessRequestFacetError("Restore path must not run.")),
    fresh: {
      buildHostOptions: ({ selectedRelease }) =>
        selectedRelease.artifact === source.artifact
          ? Effect.succeed(options)
          : Effect.fail(new HarnessRequestFacetError("Wrong release selected.")),
      buildOpenInput: () =>
        Effect.succeed({
          session: {
            threadId: data.threadId,
            providerSessionId: data.providerSessionId,
            modelSelection: data.modelSelection,
            runtimePolicy: {
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: "/workspace",
            },
          },
          creation: { providerThread: { ...data.turn.providerThread, nativeThreadRef: null } },
          bootAttemptId: "cold-create",
        }),
    },
    buildTurnBindings: () => Effect.succeed(turnBindings),
  };
  const facetOptions = yield* composeHarnessCProductFacetOptions(
    { ctx: {} as DurableObjectState, env, facetNonce: "facet-fresh" },
    factory,
  );
  const evidence = yield* facetOptions.startFresh!({
    operationId: "create-1",
    targetFacetNonce: "facet-fresh",
    publisherKey,
  });
  const turnContext: HarnessFacetRequestContext = {
    requestId: "first-turn",
    publisher: { generation: 1, facetNonce: "facet-fresh", publisherKey },
    signal: new AbortController().signal,
    check: Effect.void,
    progress: () => Effect.void,
  };

  return {
    source,
    evidence,
    facetOptions,
    order,
    verifyCalls,
    opened,
    accessCalls,
    initialCheckpoints,
    initialPublishers,
    requestCheckpoint,
    initialFiles,
    turnContext,
    firstInput: artifact("first-input"),
    get turnCalls() {
      return peer.turnCalls;
    },
    get exports() {
      return peer.exports;
    },
    get currentCheckpoint() {
      return peer.currentCheckpoint;
    },
  };
});
