import type { RunnerItem as RunnerItemType } from "@signalbox/runner-protocol/RunnerProtocol";
import { ProviderDriverKind, ProviderTurnId } from "@t3tools/contracts";
import {
  ProviderAdapterV2Event,
  type ProviderAdapterV2Event as ProviderAdapterV2EventModel,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { HarnessCheckpoint } from "../Harness.ts";
import type { HarnessHostSession, HostOpenInput } from "../HarnessSessionHost.ts";
import type { HarnessProcessResumePreparedRelease } from "../HarnessProcessResume.ts";
import type { ProductHarnessSessionHost } from "../host/product.ts";
import { dataForDriver } from "../adapter/tests/data.ts";

type FreshData = Effect.Success<ReturnType<typeof dataForDriver>>;
type Grant = { readonly token: string };

const nativeSessionId = "123e4567-e89b-12d3-a456-426614174000";
const encodeEvent = Schema.encodeSync(Schema.toCodecJson(ProviderAdapterV2Event));

export const createFreshProductNativePeer = (input: {
  readonly data: FreshData;
  readonly preparedRelease: HarnessProcessResumePreparedRelease;
  readonly order: string[];
}) =>
  Effect.gen(function* () {
    const { data, preparedRelease, order } = input;
    const events = yield* Queue.unbounded<RunnerItemType>();
    const opened: HostOpenInput<Grant>[] = [];
    const release = {
      harness: "codex" as const,
      version: "selected-release",
      manifestSha256: "c".repeat(64),
      modules: {},
    };
    let currentCheckpoint: HarnessCheckpoint = {
      release,
      providerSession: data.providerSession,
      snapshot: {
        providerThread: data.turn.providerThread,
        providerTurns: [],
        messages: [],
        runtimeRequests: [],
      },
      revision: { commit: "initial-native-files" },
    };
    let turnCalls = 0;
    let exports = 0;

    const session: HarnessHostSession<Grant> = {
      release,
      providerSession: data.providerSession,
      events: Stream.fromQueue(events),
      turn: ({ turn }) =>
        Effect.gen(function* () {
          turnCalls++;
          const providerTurnId = ProviderTurnId.make("fresh-native-turn");
          const providerTurn = {
            id: providerTurnId,
            providerThreadId: turn.providerThread.id,
            nodeId: turn.rootNodeId,
            runAttemptId: turn.attemptId,
            nativeTurnRef: {
              driver: ProviderDriverKind.make("codex"),
              nativeId: "fresh-native-turn",
              strength: "strong" as const,
            },
            ordinal: turn.providerTurnOrdinal,
            status: "running" as const,
            startedAt: data.now,
            completedAt: null,
          };
          const emit = (event: ProviderAdapterV2EventModel) =>
            Queue.offer(events, {
              kind: "provider",
              runId: turn.runId,
              event: encodeEvent(event) as unknown as Record<string, unknown>,
            } satisfies RunnerItemType);
          yield* emit({
            type: "provider_turn.updated",
            driver: ProviderDriverKind.make("codex"),
            providerTurn,
          });
          const completed = {
            ...providerTurn,
            status: "completed" as const,
            completedAt: data.now,
          };
          currentCheckpoint = {
            ...currentCheckpoint,
            snapshot: { ...currentCheckpoint.snapshot, providerTurns: [completed] },
            revision: { commit: "turn-native-files" },
          };
          yield* emit({
            type: "provider_turn.updated",
            driver: ProviderDriverKind.make("codex"),
            providerTurn: completed,
          });
          yield* emit({
            type: "turn.terminal",
            driver: ProviderDriverKind.make("codex"),
            providerThreadId: turn.providerThread.id,
            providerTurnId,
            runOrdinal: turn.runOrdinal,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
        }),
      control: () => Effect.void,
      export: () =>
        Effect.sync(() => {
          exports++;
          return currentCheckpoint;
        }),
      dispose: Effect.void,
      retireCheckpointAccess: Effect.sync(() => order.push("retire")),
    };
    const host: ProductHarnessSessionHost<Grant> & {
      loadedPreparedRelease: () => HarnessProcessResumePreparedRelease;
    } = {
      threadId: data.threadId,
      release,
      get computer(): ProductHarnessSessionHost<Grant>["computer"] {
        throw new Error("The recording host has no Computer surface.");
      },
      get commands(): ProductHarnessSessionHost<Grant>["commands"] {
        throw new Error("The recording host has no command surface.");
      },
      seed: (stage) =>
        Effect.sync(() => {
          order.push(`seed:${stage}`);
        }),
      open: (openInput) =>
        Effect.sync(() => {
          order.push("open");
          opened.push(openInput);
          currentCheckpoint = {
            ...currentCheckpoint,
            snapshot: {
              ...currentCheckpoint.snapshot,
              providerThread: {
                ...currentCheckpoint.snapshot.providerThread,
                nativeThreadRef: {
                  driver: ProviderDriverKind.make("codex"),
                  nativeId: nativeSessionId,
                  strength: "strong",
                },
              },
            },
          };
          return session;
        }),
      dispose: Effect.void,
      loadedPreparedRelease: () => preparedRelease,
    };

    return {
      host,
      release,
      opened,
      nativeSessionId,
      get currentCheckpoint() {
        return currentCheckpoint;
      },
      get turnCalls() {
        return turnCalls;
      },
      get exports() {
        return exports;
      },
    };
  });
