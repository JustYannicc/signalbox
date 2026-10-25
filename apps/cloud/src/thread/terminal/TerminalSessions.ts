import {
  TerminalNotRunningError,
  TerminalOperationError,
  TerminalSessionLookupError,
  type TerminalAttachInput,
  type TerminalAttachStreamEvent,
  type TerminalClearInput,
  type TerminalCloseInput,
  type TerminalError,
  type TerminalObserveInput,
  type TerminalOpenInput,
  type TerminalResizeInput,
  type TerminalRestartInput,
  type TerminalSessionSnapshot,
  type TerminalWriteInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";

import * as Environment from "../../environment.ts";
import * as ThreadEngine from "../ThreadEngine.ts";
import * as ThreadStore from "../ThreadStore.ts";
import * as ThreadRunner from "../runner/ThreadRunner.ts";
import * as TerminalEvents from "./TerminalEvents.ts";
import * as TerminalStore from "./TerminalStore.ts";
import { snapshot, terminalHoldsMachine } from "./terminalState.ts";

type Failure = ThreadEngine.ThreadNotFoundError | TerminalError;
type Result<A> =
  | { readonly _tag: "ok"; readonly value: A }
  | { readonly _tag: "error"; readonly error: Failure };
const ok = <A>(value: A): ThreadEngine.EngineDecision<Result<A>> => ({
  events: [],
  result: { _tag: "ok", value },
});
const no = (error: Failure): ThreadEngine.EngineDecision<Result<never>> => ({
  events: [],
  result: { _tag: "error", error },
});
const unwrap = <A>(result: Result<A>) =>
  result._tag === "ok" ? Effect.succeed(result.value) : Effect.fail(result.error);
const MAX_TERMINALS = 8;
const MAX_COMMANDS = 65_536;
const MAX_PENDING = 256;

export class TerminalSessions extends Context.Service<
  TerminalSessions,
  {
    readonly open: (
      actor: ThreadEngine.Actor,
      input: TerminalOpenInput,
    ) => Effect.Effect<TerminalSessionSnapshot, Failure>;
    readonly restart: (
      actor: ThreadEngine.Actor,
      input: TerminalRestartInput,
    ) => Effect.Effect<TerminalSessionSnapshot, Failure>;
    readonly observe: (
      actor: ThreadEngine.Actor,
      input: TerminalObserveInput,
    ) => Effect.Effect<Stream.Stream<TerminalAttachStreamEvent, Failure>, Failure>;
    readonly attach: (
      actor: ThreadEngine.Actor,
      input: TerminalAttachInput,
    ) => Effect.Effect<Stream.Stream<TerminalAttachStreamEvent, Failure>, Failure>;
    readonly write: (
      actor: ThreadEngine.Actor,
      input: TerminalWriteInput,
    ) => Effect.Effect<void, Failure>;
    readonly resize: (
      actor: ThreadEngine.Actor,
      input: TerminalResizeInput,
    ) => Effect.Effect<void, Failure>;
    readonly clear: (
      actor: ThreadEngine.Actor,
      input: TerminalClearInput,
    ) => Effect.Effect<void, Failure>;
    readonly close: (
      actor: ThreadEngine.Actor,
      input: TerminalCloseInput,
    ) => Effect.Effect<void, Failure>;
  }
>()("@signalbox/cloud/thread/terminal/TerminalSessions") {}

const projectRoot = (projectId: string) =>
  projectId === Environment.SCRATCH_PROJECT_ID
    ? Environment.scratchProject.workspaceRoot
    : projectId.startsWith("context:")
      ? `/contexts/${projectId.slice("context:".length)}`
      : projectId.startsWith("drive:")
        ? `/drives/${projectId.slice("drive:".length)}`
        : null;
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const make = Effect.gen(function* () {
  const engine = yield* ThreadEngine.ThreadEngine;
  const threadStore = yield* ThreadStore.ThreadStore;
  const records = yield* TerminalStore.TerminalStore;
  const events = yield* TerminalEvents.TerminalEvents;
  const crypto = yield* Crypto.Crypto;
  const driveService = yield* Effect.serviceOption(ThreadRunner.ThreadDrives);
  const drivesEnabled = driveService._tag === "Some" && driveService.value.enabled;
  const uuid = Effect.orDie(crypto.randomUUIDv4());
  const visible = (actor: ThreadEngine.Actor, threadId: string) =>
    Effect.flatMap(engine.snapshot(actor), ({ projection }) =>
      projection.thread.id === threadId && projection.thread.deletedAt === null
        ? Effect.void
        : Effect.fail(new ThreadEngine.ThreadNotFoundError()),
    );
  const ensureThread = (
    projection: Parameters<Parameters<typeof engine.apply>[0]>[0],
    id: string,
  ) => projection !== null && projection.thread.id === id && projection.thread.deletedAt === null;

  const start = (actor: ThreadEngine.Actor, input: TerminalOpenInput, force: boolean) =>
    Effect.gen(function* () {
      yield* visible(actor, input.threadId);
      const {
        T3CODE_PROJECT_ROOT: _root,
        T3CODE_WORKTREE_PATH: _worktree,
        ...env
      } = input.env ?? {};
      return yield* unwrap(
        yield* events.apply((projection) =>
          Effect.gen(function* () {
            if (projection === null || !ensureThread(projection, input.threadId))
              return no(new ThreadEngine.ThreadNotFoundError());
            if (
              projection.thread.archivedAt !== null ||
              projection.thread.settledOverride === "settled"
            )
              return no(
                new TerminalOperationError({
                  operation: force ? "restart" : "open",
                  reason: "unavailable",
                }),
              );
            const root = projectRoot(projection.thread.projectId);
            if (root === null)
              return no(
                new TerminalOperationError({
                  operation: force ? "restart" : "open",
                  reason: "unavailable",
                }),
              );
            const existing = yield* Effect.orDie(records.get(input.terminalId));
            if (
              !force &&
              existing !== null &&
              existing.status !== "closing" &&
              terminalHoldsMachine(existing)
            )
              return ok(snapshot(existing));
            if (!drivesEnabled)
              return no(
                new TerminalOperationError({
                  operation: force ? "restart" : "open",
                  reason: "unavailable",
                }),
              );
            const active = (yield* Effect.orDie(records.all)).filter(terminalHoldsMachine);
            if (!existing || !terminalHoldsMachine(existing)) {
              if (active.length >= MAX_TERMINALS)
                return no(new TerminalOperationError({ operation: "open", reason: "limit" }));
            }
            if (existing !== null)
              yield* Effect.orDie(records.abandon(existing.terminalId, existing.generation));
            // Every cloud turn and terminal uses the one thread workspace, including Git worktrees.
            const worktreePath = projection.thread.worktreePath;
            const record: TerminalStore.TerminalRecord = {
              threadId: input.threadId,
              terminalId: input.terminalId,
              cwd: worktreePath ?? root,
              worktreePath,
              generation: (existing?.generation ?? 0) + 1,
              leaseGeneration: 0,
              processId: null,
              cols: input.cols ?? existing?.cols ?? 80,
              rows: input.rows ?? existing?.rows ?? 24,
              env,
              openRequestId: yield* uuid,
              closeRequestId: null,
              status: "starting",
              pid: null,
              label: "",
              hasRunningSubprocess: false,
              deleteHistory: false,
              processLost: false,
              history: "",
              exitCode: null,
              exitSignal: null,
              updatedAt: yield* nowIso,
              sequence: 0,
              revision: 0,
            };
            yield* Effect.orDie(records.save(record));
            yield* Effect.orDie(records.pruneCommands(record.terminalId, record.generation));
            yield* events.emit(record.generation, {
              type: force ? "restarted" : "started",
              threadId: record.threadId,
              terminalId: record.terminalId,
              sequence: 0,
              snapshot: snapshot(record),
            });
            return ok(snapshot(record));
          }),
        ),
      );
    });
  const open: TerminalSessions["Service"]["open"] = (actor, input) => start(actor, input, false);
  const restart: TerminalSessions["Service"]["restart"] = (actor, input) =>
    start(actor, input, true);
  const observe: TerminalSessions["Service"]["observe"] = (actor, input) =>
    Effect.gen(function* () {
      yield* visible(actor, input.threadId);
      const record = yield* Effect.orDie(records.get(input.terminalId));
      if (record === null || record.status === "closed")
        return yield* new TerminalSessionLookupError(input);
      return events.observe(actor, input);
    });
  const attach: TerminalSessions["Service"]["attach"] = (actor, input) =>
    Effect.gen(function* () {
      yield* visible(actor, input.threadId);
      const existing = yield* Effect.orDie(records.get(input.terminalId));
      if (existing === null || existing.status === "closed") {
        yield* open(actor, { ...input, cwd: input.cwd ?? "." });
      } else if (
        input.restartIfNotRunning === true &&
        existing.status !== "running" &&
        existing.status !== "starting"
      ) {
        yield* start(actor, { ...input, cwd: input.cwd ?? "." }, true);
      }
      return yield* observe(actor, input);
    });

  const write: TerminalSessions["Service"]["write"] = (actor, input) =>
    Effect.gen(function* () {
      yield* visible(actor, input.threadId);
      if (input.generation === undefined)
        return yield* new TerminalOperationError({
          operation: "write",
          reason: "generation_required",
        });
      if (input.commandId === undefined)
        return yield* new TerminalOperationError({
          operation: "write",
          reason: "command_id_required",
        });
      const commandId = input.commandId;
      const digest = Hex.encode(
        yield* Effect.orDie(crypto.digest("SHA-256", new TextEncoder().encode(input.data))),
      );
      return yield* unwrap(
        yield* events.apply((projection) =>
          Effect.gen(function* () {
            if (!ensureThread(projection, input.threadId))
              return no(new ThreadEngine.ThreadNotFoundError());
            const record = yield* Effect.orDie(records.get(input.terminalId));
            if (record === null) return no(new TerminalSessionLookupError(input));
            if (record.generation !== input.generation)
              return no(
                new TerminalOperationError({ operation: "write", reason: "stale_generation" }),
              );
            if (record.status === "closed") return no(new TerminalSessionLookupError(input));
            const prior = yield* Effect.orDie(records.byCommandId(input.terminalId, commandId));
            if (prior !== null) {
              if (prior.digest !== digest)
                return no(
                  new TerminalOperationError({ operation: "write", reason: "command_conflict" }),
                );
              if (prior.outcome === "error" || prior.outcome === "abandoned")
                return no(
                  new TerminalOperationError({ operation: "write", reason: "unavailable" }),
                );
              return ok(undefined);
            }
            if (
              (record.status !== "running" && record.status !== "starting") ||
              (record.status === "running" && record.leaseGeneration === 0)
            )
              return no(new TerminalNotRunningError(input));
            const count = yield* Effect.orDie(records.countCommands(record.terminalId));
            const pending = yield* Effect.orDie(records.pending(record.leaseGeneration));
            if (count >= MAX_COMMANDS)
              return no(new TerminalOperationError({ operation: "write", reason: "input_limit" }));
            if (pending.length >= MAX_PENDING)
              return no(
                new TerminalOperationError({ operation: "write", reason: "pending_limit" }),
              );
            yield* Effect.orDie(
              records.addCommand({
                requestId: yield* uuid,
                terminalId: record.terminalId,
                generation: record.generation,
                leaseGeneration: record.leaseGeneration,
                kind: "write",
                commandId,
                digest,
                data: input.data,
                outcome: "pending",
              }),
            );
            return ok(undefined);
          }),
        ),
      );
    });

  const control = (
    actor: ThreadEngine.Actor,
    input: TerminalClearInput | TerminalResizeInput,
    kind: "clear" | "resize",
  ) =>
    Effect.gen(function* () {
      yield* visible(actor, input.threadId);
      return yield* unwrap(
        yield* events.apply((projection) =>
          Effect.gen(function* () {
            if (!ensureThread(projection, input.threadId))
              return no(new ThreadEngine.ThreadNotFoundError());
            const record = yield* Effect.orDie(records.get(input.terminalId));
            if (record === null || record.status === "closed")
              return no(new TerminalSessionLookupError(input));
            if (record.status !== "running" && record.status !== "starting") {
              if (kind === "clear") {
                const next = { ...record, history: "", updatedAt: yield* nowIso };
                yield* Effect.orDie(records.save(next));
                yield* events.emit(record.generation, {
                  type: "cleared",
                  threadId: record.threadId,
                  terminalId: record.terminalId,
                  sequence: record.sequence,
                });
                return ok(undefined);
              }
              return no(new TerminalNotRunningError(input));
            }
            const pending = yield* Effect.orDie(records.pending(record.leaseGeneration));
            if (pending.length >= MAX_PENDING)
              return no(new TerminalOperationError({ operation: kind, reason: "pending_limit" }));
            if ("cols" in input)
              yield* Effect.orDie(records.save({ ...record, cols: input.cols, rows: input.rows }));
            if (record.leaseGeneration === 0) {
              // Opening already starts with empty history and the latest requested dimensions.
              return ok(undefined);
            }
            yield* Effect.orDie(
              records.addCommand({
                requestId: yield* uuid,
                terminalId: record.terminalId,
                generation: record.generation,
                leaseGeneration: record.leaseGeneration,
                kind,
                commandId: null,
                digest: null,
                data: null,
                outcome: "pending",
              }),
            );
            return ok(undefined);
          }),
        ),
      );
    });

  const close: TerminalSessions["Service"]["close"] = (actor, input) =>
    Effect.gen(function* () {
      yield* visible(actor, input.threadId);
      yield* unwrap(
        yield* events.apply((projection) =>
          Effect.gen(function* () {
            if (!ensureThread(projection, input.threadId))
              return no(new ThreadEngine.ThreadNotFoundError());
            const lease = yield* Effect.orDie(threadStore.machine);
            for (const record of yield* Effect.orDie(records.all)) {
              if (input.terminalId !== undefined && record.terminalId !== input.terminalId)
                continue;
              if (record.status === "closing") continue;
              yield* Effect.orDie(records.abandon(record.terminalId, record.generation));
              const processMayExist =
                lease.terminals !== false &&
                record.leaseGeneration > 0 &&
                record.leaseGeneration === lease.generation &&
                lease.status !== "none" &&
                lease.status !== "requested";
              const requestId =
                processMayExist && terminalHoldsMachine(record) ? yield* uuid : null;
              const next: TerminalStore.TerminalRecord = {
                ...record,
                status: requestId === null ? "closed" : "closing",
                closeRequestId: requestId,
                pid: requestId === null ? null : record.pid,
                deleteHistory: input.deleteHistory === true,
                history: input.deleteHistory === true ? "" : record.history,
                hasRunningSubprocess: requestId === null ? false : record.hasRunningSubprocess,
                updatedAt: yield* nowIso,
              };
              yield* Effect.orDie(records.save(next));
              if (requestId !== null)
                yield* Effect.orDie(
                  records.addCommand({
                    requestId,
                    terminalId: record.terminalId,
                    generation: record.generation,
                    leaseGeneration: record.leaseGeneration,
                    kind: "close",
                    commandId: null,
                    digest: null,
                    data: null,
                    outcome: "pending",
                  }),
                );
              else
                yield* events.emit(record.generation, {
                  type: "closed",
                  threadId: record.threadId,
                  terminalId: record.terminalId,
                  sequence: record.sequence,
                });
            }
            return ok(undefined);
          }),
        ),
      );
    });

  return TerminalSessions.of({
    open,
    restart,
    observe,
    attach,
    write,
    resize: (actor, input) => control(actor, input, "resize"),
    clear: (actor, input) => control(actor, input, "clear"),
    close,
  });
});

export const layer = Layer.effect(TerminalSessions, make);
