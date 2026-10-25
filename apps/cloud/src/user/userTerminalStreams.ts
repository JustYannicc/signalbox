import type {
  TerminalEvent,
  TerminalMetadataStreamEvent,
  TerminalSessionSnapshot,
  TerminalSummary,
  ThreadId,
} from "@t3tools/contracts";
import type { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import type { SqlError } from "effect/sql/SqlError";

import type * as UserContexts from "./UserContexts.ts";

export interface StoredTerminal {
  readonly threadId: ThreadId;
  readonly contextId: SignalboxContextId;
  readonly snapshot: TerminalSessionSnapshot;
  readonly hasRunningSubprocess: boolean;
}

export interface StoredState {
  readonly terminals: ReadonlyArray<StoredTerminal>;
  readonly checkpoints: ReadonlyMap<ThreadId, number>;
}

export interface TerminalChange {
  readonly threadId: ThreadId;
  readonly contextId: SignalboxContextId;
  readonly sequence: number;
  readonly previousSequence: number;
  readonly events: ReadonlyArray<TerminalEvent>;
  readonly metadata: ReadonlyArray<TerminalMetadataStreamEvent>;
}

type StreamNotice =
  | { readonly _tag: "delivery"; readonly change: TerminalChange }
  | { readonly _tag: "contexts" };

export const toSummary = (row: StoredTerminal): TerminalSummary => ({
  generation: row.snapshot.generation,
  threadId: row.threadId,
  terminalId: row.snapshot.terminalId,
  cwd: row.snapshot.cwd,
  worktreePath: row.snapshot.worktreePath,
  status: row.snapshot.status,
  pid: row.snapshot.pid,
  exitCode: row.snapshot.exitCode,
  exitSignal: row.snapshot.exitSignal,
  hasRunningSubprocess: row.hasRunningSubprocess,
  label: row.snapshot.label,
  updatedAt: row.snapshot.updatedAt,
});

const started = (row: StoredTerminal): TerminalEvent => ({
  type: "started",
  threadId: row.threadId,
  terminalId: row.snapshot.terminalId,
  sequence: row.snapshot.sequence,
  snapshot: row.snapshot,
});

export const terminalKey = (threadId: ThreadId, terminalId: string) =>
  JSON.stringify([threadId, terminalId]);

export const makeUserTerminalStreams = Effect.fn("makeUserTerminalStreams")(function* (input: {
  readonly readState: Effect.Effect<StoredState, SqlError>;
  readonly published: PubSub.PubSub<TerminalChange>;
  readonly contexts: UserContexts.UserContexts["Service"];
}) {
  const { readState, published, contexts } = input;
  const contextsChanged = yield* PubSub.sliding<void>(1);
  yield* contexts.contextsChanged.pipe(
    Stream.runForEach(() => PubSub.publish(contextsChanged, undefined).pipe(Effect.asVoid)),
    Effect.forkScoped,
  );

  const metadata: Stream.Stream<TerminalMetadataStreamEvent, SqlError> = Stream.unwrap(
    Effect.gen(function* () {
      const deliverySubscription = yield* PubSub.subscribe(published);
      const contextSubscription = yield* PubSub.subscribe(contextsChanged);
      const terminalNotices = Stream.fromSubscription(deliverySubscription).pipe(
        Stream.map((change): StreamNotice => ({ _tag: "delivery", change })),
      );
      const contextNotices = Stream.fromSubscription(contextSubscription).pipe(
        Stream.as({ _tag: "contexts" as const }),
      );
      let checkpoints = new Map<ThreadId, number>();
      const initialize = Effect.map(readState, (state) => {
        checkpoints = new Map(state.checkpoints);
        return {
          type: "snapshot" as const,
          terminals: state.terminals.map(toSummary),
        } satisfies TerminalMetadataStreamEvent;
      });
      const refresh = Effect.map(readState, (state) => {
        checkpoints = new Map(state.checkpoints);
        return [
          {
            type: "snapshot" as const,
            terminals: state.terminals.map(toSummary),
          } satisfies TerminalMetadataStreamEvent,
        ];
      });
      const handle = (
        notice: StreamNotice,
      ): Effect.Effect<ReadonlyArray<TerminalMetadataStreamEvent>, SqlError> =>
        Effect.gen(function* () {
          if (notice._tag === "contexts") return yield* refresh;
          const previous = checkpoints.get(notice.change.threadId) ?? 0;
          if (notice.change.sequence <= previous) return [];
          const contextIds = yield* contexts.contextIds;
          if (!contextIds.includes(notice.change.contextId)) {
            checkpoints.set(notice.change.threadId, notice.change.sequence);
            return [];
          }
          if (notice.change.previousSequence !== previous) return yield* refresh;
          checkpoints.set(notice.change.threadId, notice.change.sequence);
          return notice.change.metadata;
        });
      const live = Stream.merge(terminalNotices, contextNotices).pipe(
        Stream.mapEffect(handle),
        Stream.flatMap((items) => Stream.fromIterable(items)),
      );
      return Stream.concat(Stream.fromEffect(initialize), live);
    }),
  );

  const events: Stream.Stream<TerminalEvent, SqlError> = Stream.unwrap(
    Effect.gen(function* () {
      const deliverySubscription = yield* PubSub.subscribe(published);
      const contextSubscription = yield* PubSub.subscribe(contextsChanged);
      const terminalNotices = Stream.fromSubscription(deliverySubscription).pipe(
        Stream.map((change): StreamNotice => ({ _tag: "delivery", change })),
      );
      const contextNotices = Stream.fromSubscription(contextSubscription).pipe(
        Stream.as({ _tag: "contexts" as const }),
      );
      let checkpoints = new Map<ThreadId, number>();
      let known = new Map<string, { readonly threadId: ThreadId; readonly terminalId: string }>();
      const snapshot = Effect.map(readState, (state) => {
        checkpoints = new Map(state.checkpoints);
        const visible = new Map(
          state.terminals.map((row) => [
            terminalKey(row.threadId, row.snapshot.terminalId),
            { threadId: row.threadId, terminalId: row.snapshot.terminalId },
          ]),
        );
        const removed: Array<TerminalEvent> = [];
        for (const [key, terminal] of known) {
          if (!visible.has(key)) removed.push({ type: "closed", ...terminal });
        }
        known = visible;
        return [...removed, ...state.terminals.map(started)];
      });
      const handle = (
        notice: StreamNotice,
      ): Effect.Effect<ReadonlyArray<TerminalEvent>, SqlError> =>
        Effect.gen(function* () {
          if (notice._tag === "contexts") return yield* snapshot;
          const previous = checkpoints.get(notice.change.threadId) ?? 0;
          if (notice.change.sequence <= previous) return [];
          const contextIds = yield* contexts.contextIds;
          if (!contextIds.includes(notice.change.contextId)) {
            checkpoints.set(notice.change.threadId, notice.change.sequence);
            return [];
          }
          if (notice.change.previousSequence !== previous) return yield* snapshot;
          checkpoints.set(notice.change.threadId, notice.change.sequence);
          for (const event of notice.change.events) {
            const key = terminalKey(notice.change.threadId, event.terminalId);
            if (event.type === "closed") known.delete(key);
            else if (event.type === "started" || event.type === "restarted") {
              known.set(key, { threadId: notice.change.threadId, terminalId: event.terminalId });
            }
          }
          return notice.change.events;
        });
      const live = Stream.merge(terminalNotices, contextNotices).pipe(
        Stream.mapEffect(handle),
        Stream.flatMap((items) => Stream.fromIterable(items)),
      );
      return Stream.concat(
        Stream.fromEffect(snapshot).pipe(Stream.flatMap((items) => Stream.fromIterable(items))),
        live,
      );
    }),
  );

  return { metadata, events };
});
