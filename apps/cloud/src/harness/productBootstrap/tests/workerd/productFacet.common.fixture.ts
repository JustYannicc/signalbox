import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { RunnerTurn, RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import type { HarnessCProductFacetEnvironment } from "../../../HarnessCProductFacet.ts";
import type { HarnessProcessExecutionEnvironment } from "../../../HarnessProcessPlacement.ts";
import type { HarnessRequestPublisher, HarnessRunArtifact } from "../../../HarnessRunStore.ts";
import type { HarnessFilesCheckpoint } from "../../../HarnessFilesStore.ts";
import type { FacetStorage } from "../../../../kernel/FacetSqliteStorage.ts";
import { HarnessRequestFacetError } from "../../../HarnessRequestFacet.ts";
import type { HarnessOpenInput } from "../../../Harness.ts";
import type { HarnessCheckpoint } from "../../../Harness.ts";
import type { ProductFixtureCapability } from "./productCapability.workerd.fixture.ts";
import type { ProductFixtureGrant } from "./productGrant.workerd.fixture.ts";
import type { HarnessCProductExecutorService } from "../../../HarnessCProductCapabilities.ts";
import { createMemoryFilePersistencePorts } from "../../../../kernel/MemoryFilePersistencePorts.ts";
import { createHarnessDurableState } from "../../../HarnessDurableState.ts";
import type { HarnessDurableStateBindings } from "../../../HarnessDurableState.ts";
import {
  captureHarnessCProductFiles,
  encodeHarnessCProductNativeCheckpoint,
} from "../../../HarnessCProductCheckpoint.ts";
import {
  productExecutor as makeProductExecutor,
  HARNESS_C_PRODUCT_CAPABILITY_KEYS,
} from "../../../HarnessCProductCapabilities.ts";

export type ProductFixtureEnv = HarnessCProductFacetEnvironment &
  HarnessProcessExecutionEnvironment;
export type { ProductFixtureGrant };
export const nativeSessionId = "product-native-session";
const eventCodec = Schema.fromJsonString(Schema.toCodecJson(RunnerItem));
const encodeEvent = Schema.encodeSync(eventCodec);
const decodeTurn = Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(RunnerTurn)));
const encodeResult = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      turn: Schema.toCodecJson(RunnerTurn),
      terminal: Schema.toCodecJson(RunnerItem),
    }),
  ),
);

export const storageFor = (ctx: DurableObjectState): FacetStorage => ({
  sql: {
    get databaseSize() {
      return ctx.storage.sql.databaseSize;
    },
    exec(query, ...bindings) {
      return ctx.storage.sql.exec(query, ...bindings).toArray();
    },
  },
  transactionSync: (run) => ctx.storage.transactionSync(run),
});

export const fixture = (env: ProductFixtureEnv) =>
  env.HARNESS_C_PRODUCT_CAPABILITIES?.[
    HARNESS_C_PRODUCT_CAPABILITY_KEYS.release
  ] as unknown as ProductFixtureCapability;

export const productExecutor = (env: ProductFixtureEnv) =>
  makeProductExecutor(
    env.HARNESS_C_PRODUCT_CAPABILITIES?.[
      HARNESS_C_PRODUCT_CAPABILITY_KEYS.executor
    ] as unknown as HarnessCProductExecutorService<ProductFixtureGrant>,
  );

export function openInput(input: {
  readonly threadId: HarnessOpenInput["session"]["threadId"];
  readonly providerSessionId: HarnessOpenInput["session"]["providerSessionId"];
  readonly modelSelection: HarnessOpenInput["session"]["modelSelection"];
  readonly nativeSessionId: string;
}) {
  return {
    session: {
      threadId: input.threadId,
      providerSessionId: input.providerSessionId,
      modelSelection: input.modelSelection,
      runtimePolicy: {
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        cwd: "/workspace",
      },
      initialNativeThreadId: input.nativeSessionId,
    },
    bootAttemptId: `product-workerd-${input.threadId}`,
  };
}

export function makeTurnBindings(env: ProductFixtureEnv, ctx: DurableObjectState) {
  const platform = fixture(env);
  const fail = (message: string, cause?: unknown) =>
    new HarnessRequestFacetError(message, cause === undefined ? undefined : { cause });
  let eventOrdinal = 0;
  const store = createHarnessDurableState(
    {
      HARNESS_RUN_STORE: { getByName: () => env.HARNESS_RESUME_RUN_STORE },
      HARNESS_FILES_STORE: { getByName: () => env.HARNESS_RESUME_FILES_STORE },
      HARNESS_THREAD_SUPERVISOR: { getByName: () => env.HARNESS_RESUME_SUPERVISOR },
    } as unknown as HarnessDurableStateBindings,
    env.HARNESS_RESUME_RUN_ID,
  );
  return {
    readTurn: (reference: HarnessRunArtifact) =>
      Effect.tryPromise({
        try: () => platform.readTurn(reference),
        catch: (cause) => fail("Fixture turn input could not be read.", cause),
      }).pipe(
        Effect.flatMap(decodeTurn),
        Effect.mapError((cause) => fail("Fixture turn decoding failed.", cause)),
      ),
    onEvent: (event: RunnerItem, context: { readonly requestId: string }) =>
      Effect.tryPromise({
        try: () =>
          platform.putArtifact(`event:${context.requestId}:${++eventOrdinal}`, encodeEvent(event)),
        catch: (cause) => fail("Fixture progress could not be recorded.", cause),
      }),
    writeResult: (
      input: { readonly turn: RunnerTurn; readonly terminal: RunnerItem },
      context: { readonly requestId: string },
    ) =>
      Effect.tryPromise({
        try: () => platform.putArtifact(`result:${context.requestId}`, encodeResult(input)),
        catch: (cause) => fail("Fixture result could not be recorded.", cause),
      }),
    writeCheckpoint: (
      checkpoint: HarnessCheckpoint,
      context: { readonly requestId: string; readonly publisher: HarnessRequestPublisher },
    ) =>
      Effect.tryPromise({
        try: async () => {
          const current = await store.threadSupervisor.execute({
            type: "read",
            runId: env.HARNESS_RESUME_RUN_ID,
            control: env.HARNESS_RESUME_CONTROL,
          });
          const parentCheckpointId = current.snapshot.checkpoint.checkpointId;
          const paths = ["file.txt", ".claude/projects/-workspace/product-native-session.jsonl"];
          if (env.HARNESS_C_PRODUCT_BOOTSTRAP?.provider === "codex") paths.push("codex-turn.txt");
          const threadId = checkpoint.snapshot.providerThread.appThreadId;
          if (threadId === null) throw fail("Checkpoint thread identity is missing.");
          const files = captureHarnessCProductFiles({
            files: {
              identity: "product-workerd-files",
              database: storageFor(ctx),
              nowNs: () => 0n,
              persistencePorts: createMemoryFilePersistencePorts(),
              rootMetadata: { mode: 0o755, uid: 1000, gid: 1000 },
              posix: {
                credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 },
                umask: 0o022,
              },
              cwd: "/workspace",
              assetMode: 0o644,
            },
            threadId,
            paths,
          });
          const nextFiles: HarnessFilesCheckpoint = {
            checkpointId: `native-${context.requestId}`,
            parentCheckpointId,
            files,
          };
          return await platform.stageCheckpoint(
            context.requestId,
            nextFiles,
            encodeHarnessCProductNativeCheckpoint({
              schemaVersion: 1,
              nativeSessionId,
              checkpoint,
            }),
          );
        },
        catch: (cause) => fail("Fixture checkpoint export could not be committed.", cause),
      }),
    verify: (
      reference: HarnessRunArtifact,
      purpose: "input" | "native" | "filesystem" | "result" | "progress",
    ) =>
      Effect.tryPromise({
        try: async () => {
          if (purpose !== "filesystem") return await platform.verifyArtifact(reference);
          await platform.verifyFiles(reference);
        },
        catch: (cause) => fail("Fixture artifact verification failed.", cause),
      }),
  };
}
