import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import { MessageId, RunAttemptId, RunId } from "@t3tools/contracts";
import type { RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import type { HarnessCheckpoint } from "../../Harness.ts";
import {
  HarnessRequestFacetError,
  type HarnessFacetRequestContext,
} from "../../HarnessRequestFacet.ts";
import {
  prepareHarnessFilesCheckpoint,
  type HarnessFilesCheckpoint,
} from "../../HarnessFilesStore.ts";
import type { HarnessRunArtifact, HarnessRequestCheckpoint } from "../../HarnessRunStore.ts";
import {
  createProductClaudeHarnessSessionHost,
  type ProductClaudeHarnessHostOptions,
  type ProductClaudeHarnessSessionHost,
} from "../../ProductClaudeHarnessSessionHost.ts";
import {
  createHarnessCProductExecutorService,
  createHarnessCProductTurnGrantSource,
  type HarnessCProductCapabilities,
} from "../../HarnessCProductCapabilities.ts";
import {
  prepareFreshHarnessCProductHost,
  type HarnessCProductFacetEnvironment,
  type HarnessCProductFacetFactory,
  type HarnessCProductTurnBindings,
} from "../../HarnessCProductFacet.ts";
import { freshClaudeHostOptions } from "./freshClaudeHostOptions.fixture.ts";
import type { FreshClaudeGrant } from "./freshClaudeNativeHandoff.peer.fixture.ts";

const publisherKey = "p".repeat(32);
const artifact = (id: string): HarnessRunArtifact => ({ id, bytes: 1, sha256: "a".repeat(64) });
const failed = (cause: unknown) =>
  new HarnessRequestFacetError("Fresh Claude fixture failed.", { cause });

export const freshClaudeNativeHandoff = () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* freshClaudeHostOptions();
      const { source, data, options, peer } = f;
      const accessCalls: string[] = [];
      const checkpoints: HarnessCheckpoint[] = [];
      const initialCheckpoints: HarnessCheckpoint[] = [];
      let requestCheckpoint: HarnessRequestCheckpoint | undefined;
      let creationAccessRetired = false;
      const firstTurn = data.turn;
      const secondTurn: RunnerTurn = {
        ...firstTurn,
        runId: RunId.make("fresh-claude-second-turn"),
        runOrdinal: 2,
        providerTurnOrdinal: 2,
        attemptId: RunAttemptId.make("fresh-claude-second-attempt"),
        message: {
          ...firstTurn.message,
          messageId: MessageId.make("fresh-claude-second-message"),
          text: "Second fresh Claude turn",
        },
      };
      const capabilities: HarnessCProductCapabilities<FreshClaudeGrant> = {
        release: {
          getArtifact: async () => source.artifact,
          loaderConfig: async () => ({
            trustedComputer: source.trustedComputer,
            maxPreparedModuleBytes: source.maxPreparedModuleBytes,
          }),
          readArtifact: source.readArtifact,
          readArtifactChunk: async (ref, path, offset, length) =>
            (await source.readArtifact(ref, path)).slice(offset, offset + length),
        },
        nativeCheckpoint: {
          read: async () => {
            throw new Error("Fresh creation cannot read a prior checkpoint.");
          },
        },
        access: {
          resolveInitialAccess: async () => {
            throw new Error("Fresh creation cannot restore access.");
          },
          resolveFreshAccess: async ({ operationId }) => {
            accessCalls.push(`fresh:${operationId}`);
            return { grant: { token: "creation" }, connections: { servers: [] } };
          },
          resolveTurnAccess: async ({ requestId }) => {
            accessCalls.push(`turn:${requestId}`);
            return { grant: { token: requestId }, connections: { servers: [] } };
          },
        },
        programs: {
          catalog: async () => ({
            sourceIdentity: options.programs.seed.sourceIdentity,
            codes: options.programs.codes,
            files: options.programs.seed.files,
          }),
          read: (path) => options.programs.seed.read(path, new AbortController().signal),
        },
        machine: { inventory: async () => options.machineInventory },
        model: { fetch: options.modelTransport },
        executor: createHarnessCProductExecutorService(options.executor),
        turnGrantSource: createHarnessCProductTurnGrantSource(options.turnGrantSource!),
      };
      const turnBindings: HarnessCProductTurnBindings<FreshClaudeGrant> = {
        readTurn: (_reference, context) =>
          Effect.succeed(context.requestId === "first-turn" ? firstTurn : secondTurn),
        onEvent: (_event, context) => Effect.succeed(artifact(`event-${context.requestId}`)),
        writeResult: (_result, context) => Effect.succeed(artifact(`result-${context.requestId}`)),
        writeCheckpoint: (checkpoint) =>
          Effect.sync(() => {
            if (requestCheckpoint === undefined)
              throw new Error("The initial checkpoint was not written.");
            checkpoints.push(checkpoint);
            return requestCheckpoint;
          }),
        verify: () => Effect.void,
        writeInitialCheckpoint: (checkpoint) =>
          Effect.gen(function* () {
            if (!creationAccessRetired)
              return yield* Effect.fail(failed(new Error("The initial access is still live.")));
            initialCheckpoints.push(checkpoint);
            const nativeId = checkpoint.snapshot.providerThread.nativeThreadRef?.nativeId;
            if (nativeId == null)
              return yield* Effect.fail(
                failed(new Error("Fresh creation omitted its native UUID.")),
              );
            const filesCheckpoint: HarnessFilesCheckpoint = {
              checkpointId: "initial-native",
              parentCheckpointId: null,
              files: [
                {
                  path: ".claude/projects/workspace/native.jsonl",
                  mode: 0o600,
                  bytes: new TextEncoder().encode(nativeId),
                },
              ],
            };
            const manifest = yield* Effect.tryPromise({
              try: () => prepareHarnessFilesCheckpoint(filesCheckpoint),
              catch: failed,
            });
            requestCheckpoint = {
              native: artifact("initial-native"),
              filesystem: { ...artifact("initial-files"), sha256: manifest.manifestSha256 },
            };
            return { checkpoint: requestCheckpoint, filesCheckpoint };
          }),
      };
      type Options = ProductClaudeHarnessHostOptions<FreshClaudeGrant>;
      const factory: HarnessCProductFacetFactory<
        HarnessCProductFacetEnvironment,
        FreshClaudeGrant,
        Options["native"],
        Options,
        ProductClaudeHarnessSessionHost<FreshClaudeGrant>
      > = {
        provider: "claude-code",
        createHost: (input) =>
          createProductClaudeHarnessSessionHost(input).pipe(
            Effect.map(
              (host) =>
                new Proxy(host, {
                  get(target, key, receiver) {
                    if (key !== "open") return Reflect.get(target, key, receiver);
                    return (open: Parameters<typeof target.open>[0]) =>
                      target.open(open).pipe(
                        Effect.map(
                          (session) =>
                            new Proxy(session, {
                              get(current, method, sessionReceiver) {
                                if (method !== "retireCheckpointAccess")
                                  return Reflect.get(current, method, sessionReceiver);
                                return current.retireCheckpointAccess.pipe(
                                  Effect.tap(() =>
                                    Effect.sync(() => {
                                      creationAccessRetired = true;
                                    }),
                                  ),
                                );
                              },
                            }),
                        ),
                      );
                  },
                }),
            ),
          ),
        buildHostOptions: () => Effect.fail(failed(new Error("Restore options must not run."))),
        buildOpenInput: () => Effect.fail(failed(new Error("Restore open must not run."))),
        fresh: {
          buildHostOptions: () => Effect.succeed(options),
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
              creation: { providerThread: data.providerThread },
              bootAttemptId: "fresh-claude-native-handoff",
            }),
        },
        buildTurnBindings: () => Effect.succeed(turnBindings),
      };
      const prepared = yield* prepareFreshHarnessCProductHost({
        env: {} as HarnessCProductFacetEnvironment,
        ctx: {} as DurableObjectState,
        targetFacetNonce: "fresh-claude-facet",
        operationId: "fresh-create",
        publisherKey,
        signal: new AbortController().signal,
        runId: "fresh-claude-handoff",
        descriptor: {
          provider: "claude-code",
          preparedReleaseId: source.artifact.releaseId,
          restoreMode: "cross-variant-fresh-boot",
        },
        expected: source.expected,
        capabilities,
        turnBindings,
        factory,
      });
      const context = (requestId: string): HarnessFacetRequestContext => ({
        requestId,
        publisher: { generation: 1, facetNonce: "fresh-claude-facet", publisherKey },
        signal: new AbortController().signal,
        check: Effect.void,
        progress: () => Effect.void,
      });
      const creationUrls = peer.mcpUrls.slice();
      const first = yield* Effect.exit(
        prepared.runtime.run(artifact("first-input"), context("first-turn")),
      );
      const second = Exit.isSuccess(first)
        ? yield* Effect.exit(prepared.runtime.run(artifact("second-input"), context("second-turn")))
        : undefined;
      const creationRouteStatus = creationUrls.length === 0 ? "never-queried" : "queried";
      return {
        nativeId: prepared.evidence.nativeSessionId,
        creationAccessRetired,
        initialNativeId: initialCheckpoints[0]?.snapshot.providerThread.nativeThreadRef?.nativeId,
        firstCheckpointNativeId: checkpoints[0]?.snapshot.providerThread.nativeThreadRef?.nativeId,
        secondCheckpointNativeId: checkpoints[1]?.snapshot.providerThread.nativeThreadRef?.nativeId,
        accessCalls,
        turnGrantIssues: f.turnGrantIssues,
        executorGrants: f.executorGrants,
        executorEndpoints: f.executorEndpoints,
        firstStatus: Exit.isSuccess(first) ? first.value.status : null,
        firstFailure: Exit.isFailure(first) ? Cause.pretty(first.cause) : null,
        secondStatus: second !== undefined && Exit.isSuccess(second) ? second.value.status : null,
        secondFailure:
          second !== undefined && Exit.isFailure(second) ? Cause.pretty(second.cause) : null,
        firstCheckpointCompleted:
          checkpoints[0]?.snapshot.providerTurns.some(
            (turn) => turn.ordinal === 1 && turn.status === "completed",
          ) === true,
        secondCheckpointCompleted:
          checkpoints[1]?.snapshot.providerTurns.some(
            (turn) => turn.ordinal === 2 && turn.status === "completed",
          ) === true,
        sdkThreadIds: peer.queryThreadIds,
        consumedMessages: peer.consumedMessages,
        mcpInstallations: peer.mcpInstallations.map((servers) => Object.keys(servers)),
        mcpResponses: peer.mcpResponses,
        creationRouteStatus,
      };
    }),
  );
