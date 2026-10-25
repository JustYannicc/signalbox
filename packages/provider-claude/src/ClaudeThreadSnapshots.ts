import {
  NodeId,
  ProviderTurnId,
  type OrchestrationV2ProviderThread,
  type ProviderInstanceId,
  type ProviderSessionId,
  type ProviderThreadId,
  type ThreadId,
} from "@t3tools/contracts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2ThreadSnapshot,
  ProviderAdapterV2RollbackTarget,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export class ClaudeThreadSnapshotError extends Schema.TaggedError<ClaudeThreadSnapshotError>()(
  "ClaudeThreadSnapshotError",
  {
    reason: Schema.Literals(["identity", "checkpoint-rows", "history-unavailable"]),
    providerThreadId: Schema.String,
  },
) {
  override get message(): string {
    return this.reason === "history-unavailable"
      ? "Claude history needs the checkpoint from the previous runtime."
      : "Claude snapshot does not match this provider session and thread.";
  }
}

interface Entry {
  readonly snapshot: ProviderAdapterV2ThreadSnapshot;
  readonly complete: boolean;
  readonly nodeIds: ReadonlySet<NodeId>;
  readonly nodeTurns: ReadonlyMap<NodeId, ProviderTurnId>;
}

// Conversation rows lack turn ids. Persist observed node links so rollback does not guess from time.
const SnapshotProvenance = Schema.Struct({
  type: Schema.Literal("claude_snapshot_v1"),
  nodeTurns: Schema.Array(Schema.Struct({ nodeId: NodeId, providerTurnId: ProviderTurnId })),
  previousPayload: Schema.optional(Schema.Unknown),
});
const isSnapshotProvenance = Schema.is(SnapshotProvenance);

interface State {
  readonly providerSessionId: ProviderSessionId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly threads: ReadonlyMap<ProviderThreadId, Entry>;
  readonly checkpointThreadId?: ProviderThreadId;
}

function sameThread(left: OrchestrationV2ProviderThread, right: OrchestrationV2ProviderThread) {
  return (
    left.id === right.id &&
    left.appThreadId === right.appThreadId &&
    left.nativeThreadRef?.driver === right.nativeThreadRef?.driver &&
    left.nativeThreadRef?.nativeId === right.nativeThreadRef?.nativeId
  );
}

function validThread(state: State, thread: OrchestrationV2ProviderThread) {
  return (
    thread.driver === "claudeAgent" &&
    thread.providerSessionId === state.providerSessionId &&
    thread.providerInstanceId === state.providerInstanceId &&
    thread.appThreadId !== null &&
    thread.nativeThreadRef?.driver === thread.driver &&
    typeof thread.nativeThreadRef.nativeId === "string" &&
    thread.nativeThreadRef.nativeId.length > 0
  );
}

function replace(state: State, entry: Entry): State {
  return { ...state, threads: new Map(state.threads).set(entry.snapshot.providerThread.id, entry) };
}

function upsert<Row extends { readonly id: string }>(rows: ReadonlyArray<Row>, row: Row) {
  const index = rows.findIndex((current) => current.id === row.id);
  return index < 0
    ? [...rows, row]
    : rows.map((current, offset) => (offset === index ? row : current));
}

export function makeClaudeThreadSnapshots(
  identity: Pick<State, "providerSessionId" | "providerInstanceId"> & {
    readonly threadId?: ThreadId;
    readonly initialNativeThreadId?: string;
  },
  checkpoint?: ProviderAdapterV2ThreadSnapshot,
): Result.Result<State, ClaudeThreadSnapshotError> {
  const state: State = { ...identity, threads: new Map() };
  if (checkpoint === undefined) return Result.succeed(state);
  const thread = checkpoint.providerThread;
  if (
    !validThread(state, thread) ||
    (identity.threadId !== undefined && thread.appThreadId !== identity.threadId) ||
    (identity.initialNativeThreadId !== undefined &&
      thread.nativeThreadRef?.nativeId !== identity.initialNativeThreadId)
  ) {
    return Result.fail(
      new ClaudeThreadSnapshotError({ reason: "identity", providerThreadId: thread.id }),
    );
  }
  const turnIds = new Set(checkpoint.providerTurns.map((turn) => turn.id));
  const provenance = isSnapshotProvenance(checkpoint.providerPayload)
    ? checkpoint.providerPayload
    : undefined;
  if (
    provenance?.nodeTurns.some((row) => !turnIds.has(row.providerTurnId)) ||
    checkpoint.providerTurns.some((turn) => turn.providerThreadId !== thread.id) ||
    checkpoint.messages.some((message) => message.threadId !== thread.appThreadId) ||
    checkpoint.runtimeRequests.some(
      (request) =>
        (request.providerTurnId !== null && !turnIds.has(request.providerTurnId)) ||
        (request.responseCapability.type === "live" &&
          request.responseCapability.providerSessionId !== identity.providerSessionId),
    )
  ) {
    return Result.fail(
      new ClaudeThreadSnapshotError({ reason: "checkpoint-rows", providerThreadId: thread.id }),
    );
  }
  const nodeIds = new Set([
    ...checkpoint.providerTurns.map((turn) => turn.nodeId),
    ...checkpoint.messages.flatMap((message) => (message.nodeId === null ? [] : [message.nodeId])),
    ...checkpoint.runtimeRequests.map((request) => request.nodeId),
  ]);
  const { providerPayload: _payload, ...rows } = checkpoint;
  const snapshot =
    provenance === undefined
      ? checkpoint
      : provenance.previousPayload === undefined
        ? rows
        : { ...rows, providerPayload: provenance.previousPayload };
  return Result.succeed({
    ...replace(state, {
      snapshot,
      complete: true,
      nodeIds,
      nodeTurns: new Map(provenance?.nodeTurns.map((row) => [row.nodeId, row.providerTurnId])),
    }),
    checkpointThreadId: thread.id,
  });
}

export function rememberClaudeSnapshotThread(
  state: State,
  thread: OrchestrationV2ProviderThread,
  origin: "created" | "resumed",
): Result.Result<State, ClaudeThreadSnapshotError> {
  const current = state.threads.get(thread.id);
  if (
    !validThread(state, thread) ||
    (current !== undefined && !sameThread(current.snapshot.providerThread, thread)) ||
    (origin === "resumed" && current === undefined && state.checkpointThreadId !== undefined)
  ) {
    return Result.fail(
      new ClaudeThreadSnapshotError({ reason: "identity", providerThreadId: thread.id }),
    );
  }
  return Result.succeed(
    replace(state, {
      complete: current?.complete ?? origin === "created",
      nodeIds: current?.nodeIds ?? new Set(),
      nodeTurns: current?.nodeTurns ?? new Map(),
      snapshot: {
        ...(current?.snapshot ?? { providerTurns: [], messages: [], runtimeRequests: [] }),
        providerThread: thread,
      },
    }),
  );
}

export function collectClaudeSnapshotEvent(state: State, event: ProviderAdapterV2Event): State {
  if (event.driver !== "claudeAgent") return state;
  if (event.type === "provider_thread.updated") {
    const entry = state.threads.get(event.providerThread.id);
    return entry !== undefined &&
      validThread(state, event.providerThread) &&
      sameThread(entry.snapshot.providerThread, event.providerThread)
      ? replace(state, {
          ...entry,
          snapshot: { ...entry.snapshot, providerThread: event.providerThread },
        })
      : state;
  }
  if (event.type === "provider_turn.updated" || event.type === "node.updated") {
    const row = event.type === "provider_turn.updated" ? event.providerTurn : event.node;
    if (row.providerThreadId === null) return state;
    const entry = state.threads.get(row.providerThreadId);
    if (entry === undefined) return state;
    const threadId = event.type === "provider_turn.updated" ? event.threadId : event.node.threadId;
    if (threadId !== undefined && threadId !== entry.snapshot.providerThread.appThreadId)
      return state;
    return replace(state, {
      ...entry,
      nodeIds: new Set(entry.nodeIds).add(
        event.type === "node.updated" ? event.node.id : event.providerTurn.nodeId,
      ),
      nodeTurns:
        event.type === "node.updated" && event.node.providerTurnId !== null
          ? new Map(entry.nodeTurns).set(event.node.id, event.node.providerTurnId)
          : entry.nodeTurns,
      snapshot:
        event.type === "node.updated"
          ? entry.snapshot
          : {
              ...entry.snapshot,
              providerTurns: upsert(entry.snapshot.providerTurns, event.providerTurn),
            },
    });
  }
  if (event.type === "message.updated") {
    const candidates = [...state.threads.values()].filter(
      (entry) => entry.snapshot.providerThread.appThreadId === event.message.threadId,
    );
    const entry =
      candidates.length === 1
        ? candidates[0]
        : candidates.find(
            (entry) =>
              entry.snapshot.messages.some((message) => message.id === event.message.id) ||
              (event.message.nodeId !== null && entry.nodeIds.has(event.message.nodeId)),
          );
    return entry === undefined
      ? state
      : replace(state, {
          ...entry,
          snapshot: { ...entry.snapshot, messages: upsert(entry.snapshot.messages, event.message) },
        });
  }
  if (event.type === "runtime_request.updated") {
    const request = event.runtimeRequest;
    if (
      request.responseCapability.type === "live" &&
      request.responseCapability.providerSessionId !== state.providerSessionId
    )
      return state;
    const entry = [...state.threads.values()].find(
      (entry) =>
        (event.threadId === undefined ||
          event.threadId === entry.snapshot.providerThread.appThreadId) &&
        (request.providerTurnId === null
          ? entry.nodeIds.has(request.nodeId)
          : entry.snapshot.providerTurns.some((turn) => turn.id === request.providerTurnId)),
    );
    return entry === undefined
      ? state
      : replace(state, {
          ...entry,
          snapshot: {
            ...entry.snapshot,
            runtimeRequests: upsert(entry.snapshot.runtimeRequests, request),
          },
        });
  }
  return state;
}

export function readClaudeThreadSnapshot(
  state: State,
  thread: OrchestrationV2ProviderThread,
): Result.Result<ProviderAdapterV2ThreadSnapshot, ClaudeThreadSnapshotError> {
  const entry = state.threads.get(thread.id);
  if (
    !validThread(state, thread) ||
    entry === undefined ||
    !sameThread(entry.snapshot.providerThread, thread)
  ) {
    return Result.fail(
      new ClaudeThreadSnapshotError({ reason: "identity", providerThreadId: thread.id }),
    );
  }
  return entry.complete
    ? Result.succeed(
        entry.nodeTurns.size === 0
          ? entry.snapshot
          : {
              ...entry.snapshot,
              providerPayload: {
                type: "claude_snapshot_v1",
                nodeTurns: [...entry.nodeTurns].map(([nodeId, providerTurnId]) => ({
                  nodeId,
                  providerTurnId,
                })),
                ...(entry.snapshot.providerPayload === undefined
                  ? {}
                  : { previousPayload: entry.snapshot.providerPayload }),
              },
            },
      )
    : Result.fail(
        new ClaudeThreadSnapshotError({
          reason: "history-unavailable",
          providerThreadId: thread.id,
        }),
      );
}

export function rollbackClaudeThreadSnapshots(
  state: State,
  source: OrchestrationV2ProviderThread,
  providerThread: OrchestrationV2ProviderThread,
  target: ProviderAdapterV2RollbackTarget,
): Result.Result<State, ClaudeThreadSnapshotError> {
  const entry = state.threads.get(source.id);
  if (
    !validThread(state, source) ||
    !validThread(state, providerThread) ||
    source.appThreadId !== providerThread.appThreadId ||
    (entry !== undefined && !sameThread(entry.snapshot.providerThread, source)) ||
    (target.type === "provider_turn" &&
      (!sameThread(source, providerThread) || target.providerTurn.providerThreadId !== source.id))
  ) {
    return Result.fail(
      new ClaudeThreadSnapshotError({ reason: "identity", providerThreadId: source.id }),
    );
  }
  if (target.type === "thread_start") {
    const threads = new Map(state.threads);
    threads.delete(source.id);
    return Result.succeed(
      replace(
        { ...state, threads },
        {
          snapshot: { providerThread, providerTurns: [], messages: [], runtimeRequests: [] },
          complete: true,
          nodeIds: new Set(),
          nodeTurns: new Map(),
        },
      ),
    );
  }
  const observed = entry?.snapshot.providerTurns.find((turn) => turn.id === target.providerTurn.id);
  const matched =
    observed !== undefined &&
    observed.ordinal === target.providerTurn.ordinal &&
    observed.nativeTurnRef?.driver === target.providerTurn.nativeTurnRef?.driver &&
    observed.nativeTurnRef?.nativeId === target.providerTurn.nativeTurnRef?.nativeId;
  const turns = entry?.snapshot.providerTurns ?? [];
  const providerTurns = matched ? turns.filter((turn) => turn.ordinal <= observed.ordinal) : [];
  const retained = new Set(providerTurns.map((turn) => turn.id));
  const nodeTurn = (nodeId: NodeId | null) =>
    nodeId === null
      ? undefined
      : (entry?.nodeTurns.get(nodeId) ??
        entry?.snapshot.providerTurns.find((turn) => turn.nodeId === nodeId)?.id);
  const unchanged = matched && providerTurns.length === turns.length;
  const messages = entry?.snapshot.messages ?? [];
  const requests = entry?.snapshot.runtimeRequests ?? [];
  const known =
    unchanged ||
    (messages.every((message) => nodeTurn(message.nodeId) !== undefined) &&
      requests.every(
        (request) => request.providerTurnId !== null || nodeTurn(request.nodeId) !== undefined,
      ));
  const nodeTurns = new Map(
    [...(entry?.nodeTurns ?? [])].filter(([, turnId]) => retained.has(turnId)),
  );
  const retainedTurn = (turnId: ProviderTurnId | undefined | null) =>
    turnId != null && retained.has(turnId);
  return Result.succeed(
    replace(state, {
      complete: entry?.complete === true && matched && known,
      nodeIds: new Set(nodeTurns.keys()),
      nodeTurns,
      snapshot: {
        providerThread,
        providerTurns,
        messages: unchanged
          ? messages
          : messages.filter((message) => retainedTurn(nodeTurn(message.nodeId))),
        runtimeRequests: unchanged
          ? requests
          : requests.filter((request) =>
              retainedTurn(request.providerTurnId ?? nodeTurn(request.nodeId)),
            ),
      },
    }),
  );
}
