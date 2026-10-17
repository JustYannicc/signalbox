import type { TerminalEvent } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import type { TerminalCommand, TerminalReport } from "@signalbox/runner-protocol/TerminalProtocol";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type * as ThreadEngine from "../ThreadEngine.ts";
import * as ThreadStore from "../ThreadStore.ts";
import * as ThreadRunner from "../runner/ThreadRunner.ts";
import * as TerminalEvents from "./TerminalEvents.ts";
import * as TerminalSessions from "./TerminalSessions.ts";
import * as TerminalStore from "./TerminalStore.ts";
import { afterEvent, afterResult, snapshot, terminalHoldsMachine } from "./terminalState.ts";
import { terminalHistoryTail } from "./terminalHistory.ts";

export interface TerminalWork {
  readonly requestId: string;
  readonly command: TerminalCommand;
}

export class ThreadTerminals extends Context.Service<
  ThreadTerminals,
  TerminalSessions.TerminalSessions["Service"] & {
    readonly held: Effect.Effect<boolean>;
    readonly reconcile: Effect.Effect<void>;
    readonly connected: (leaseGeneration: number, processId: string) => Effect.Effect<void>;
    readonly work: (leaseGeneration: number) => Effect.Effect<ReadonlyArray<TerminalWork>>;
    readonly report: (
      leaseGeneration: number,
      connection: number,
      report: TerminalReport,
    ) => Effect.Effect<void>;
    readonly lost: (leaseGeneration: number) => Effect.Effect<void>;
  }
>()("@signalbox/cloud/thread/terminal/ThreadTerminals") {}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const retain = <A>(result: A): ThreadEngine.EngineDecision<A> => ({ events: [], result });

const make = Effect.gen(function* () {
  const threadStore = yield* ThreadStore.ThreadStore;
  const records = yield* TerminalStore.TerminalStore;
  const sessions = yield* TerminalSessions.TerminalSessions;
  const runner = yield* ThreadRunner.ThreadRunner;
  const events = yield* TerminalEvents.TerminalEvents;
  const crypto = yield* Crypto.Crypto;
  const uuid = Effect.orDie(crypto.randomUUIDv4());

  const fail = (record: TerminalStore.TerminalRecord, message: string, processLost = true) =>
    Effect.gen(function* () {
      if (processLost || record.status !== "closing")
        yield* Effect.orDie(records.abandon(record.terminalId, record.generation));
      const next: TerminalStore.TerminalRecord = {
        ...record,
        status: record.status === "closing" ? (processLost ? "closed" : "closing") : "error",
        pid: processLost ? null : record.pid,
        processLost,
        hasRunningSubprocess: processLost ? false : record.hasRunningSubprocess,
        updatedAt: yield* nowIso,
      };
      yield* Effect.orDie(records.save(next));
      yield* events.emit(
        record.generation,
        next.status === "closed"
          ? {
              type: "closed",
              threadId: record.threadId,
              terminalId: record.terminalId,
              sequence: record.sequence,
            }
          : {
              type: "error",
              threadId: record.threadId,
              terminalId: record.terminalId,
              sequence: record.sequence,
              message,
            },
      );
    });

  const queueClose = (record: TerminalStore.TerminalRecord) =>
    Effect.gen(function* () {
      if (record.status === "closing" || record.leaseGeneration === 0) return;
      yield* Effect.orDie(records.abandon(record.terminalId, record.generation));
      const requestId = yield* uuid;
      const next: TerminalStore.TerminalRecord = {
        ...record,
        status: "closing",
        closeRequestId: requestId,
        updatedAt: yield* nowIso,
      };
      yield* Effect.orDie(records.save(next));
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
    });

  const bindStarting = (leaseGeneration: number, processId: string | null) =>
    Effect.gen(function* () {
      for (const record of yield* Effect.orDie(records.all)) {
        if (record.status !== "starting" || record.leaseGeneration !== 0) continue;
        yield* Effect.orDie(records.save({ ...record, leaseGeneration, processId }));
        yield* Effect.orDie(
          records.rebindPending(record.terminalId, record.generation, leaseGeneration),
        );
        yield* Effect.orDie(
          records.addCommand({
            requestId: record.openRequestId,
            terminalId: record.terminalId,
            generation: record.generation,
            leaseGeneration,
            kind: "open",
            commandId: null,
            digest: null,
            data: null,
            outcome: "pending",
          }),
        );
      }
    });

  const reconcile: ThreadTerminals["Service"]["reconcile"] = events.apply((projection) =>
    Effect.gen(function* () {
      if (projection === null) return retain(undefined);
      if (projection.thread.deletedAt === null) {
        const lease = yield* Effect.orDie(threadStore.machine);
        if (lease.status === "requested") yield* bindStarting(lease.generation, null);
        return retain(undefined);
      }
      for (const record of yield* Effect.orDie(records.all)) {
        if (!terminalHoldsMachine(record)) continue;
        if (record.leaseGeneration === 0) {
          yield* Effect.orDie(records.abandon(record.terminalId, record.generation));
          const closed: TerminalStore.TerminalRecord = {
            ...record,
            status: "closed",
            closeRequestId: null,
            pid: null,
            hasRunningSubprocess: false,
            updatedAt: yield* nowIso,
          };
          yield* Effect.orDie(records.save(closed));
          yield* events.emit(record.generation, {
            type: "closed",
            threadId: record.threadId,
            terminalId: record.terminalId,
            sequence: record.sequence,
          });
          continue;
        }
        yield* queueClose(record);
      }
      return retain(undefined);
    }),
  );

  const connected: ThreadTerminals["Service"]["connected"] = (leaseGeneration, processId) =>
    events.apply(() =>
      Effect.gen(function* () {
        const lease = yield* Effect.orDie(threadStore.machine);
        if (lease.generation !== leaseGeneration || lease.status !== "connected")
          return retain(undefined);
        yield* Effect.orDie(records.saveProcess(leaseGeneration, processId));
        for (const record of yield* Effect.orDie(records.all)) {
          if (
            record.processId === processId ||
            record.leaseGeneration !== leaseGeneration ||
            !terminalHoldsMachine(record)
          )
            continue;
          if (record.processId === null) {
            yield* Effect.orDie(records.save({ ...record, processId }));
            continue;
          }
          yield* fail(
            record,
            "The terminal process was lost when its runner restarted. Restart the terminal to continue.",
          );
        }
        return retain(undefined);
      }),
    );

  const work: ThreadTerminals["Service"]["work"] = (leaseGeneration) =>
    Effect.andThen(reconcile, () =>
      events.apply((projection) =>
        Effect.gen(function* () {
          const lease = yield* Effect.orDie(threadStore.machine);
          if (lease.generation !== leaseGeneration || lease.status !== "connected")
            return retain([]);
          yield* bindStarting(
            leaseGeneration,
            yield* Effect.orDie(records.processId(leaseGeneration)),
          );
          const threadId = projection?.thread.id;
          if (threadId === undefined) return retain([]);
          const drive = yield* runner.terminalDrive;
          if (drive === null) {
            for (const pending of yield* Effect.orDie(records.pending(leaseGeneration))) {
              if (pending.kind !== "open") continue;
              const record = yield* Effect.orDie(records.get(pending.terminalId));
              if (record?.generation === pending.generation && record.status === "starting")
                yield* queueClose(record);
            }
          }
          const commands: Array<TerminalWork> = [];
          for (const pending of yield* Effect.orDie(records.pending(leaseGeneration))) {
            const record = yield* Effect.orDie(records.get(pending.terminalId));
            if (record === null || record.generation !== pending.generation) continue;
            const common = {
              threadId: ThreadId.make(threadId),
              terminalId: record.terminalId,
              generation: record.generation,
              leaseGeneration,
            };
            if (
              (pending.kind === "write" || pending.kind === "resize" || pending.kind === "clear") &&
              record.status !== "running"
            )
              continue;
            let command: TerminalCommand;
            switch (pending.kind) {
              case "open":
                if (drive === null) continue;
                command = {
                  type: "open",
                  ...common,
                  drive,
                  cols: record.cols,
                  rows: record.rows,
                  env: record.env,
                };
                break;
              case "write":
                if (pending.commandId === null || pending.data === null) continue;
                command = {
                  type: "write",
                  ...common,
                  commandId: pending.commandId,
                  data: pending.data,
                };
                break;
              case "resize":
                command = { type: "resize", ...common, cols: record.cols, rows: record.rows };
                break;
              case "clear":
                command = { type: "clear", ...common };
                break;
              case "close":
                command = { type: "close", ...common };
                break;
            }
            commands.push({ requestId: pending.requestId, command });
          }
          return retain(commands);
        }),
      ),
    );

  const report: ThreadTerminals["Service"]["report"] = (leaseGeneration, connection, report) =>
    events.apply(() =>
      Effect.gen(function* () {
        const lease = yield* Effect.orDie(threadStore.machine);
        if (
          lease.generation !== leaseGeneration ||
          lease.status !== "connected" ||
          lease.connection !== connection ||
          report.leaseGeneration !== leaseGeneration
        )
          return retain(undefined);
        const record = yield* Effect.orDie(records.get(report.terminalId));
        if (
          record === null ||
          record.generation !== report.generation ||
          record.leaseGeneration !== leaseGeneration
        )
          return retain(undefined);
        if (
          (record.status === "closed" ||
            (record.status === "error" && (record.processLost || report.type !== "snapshot"))) &&
          report.type !== "result"
        )
          return retain(undefined);
        if (report.type === "snapshot") {
          const incoming = report.snapshot;
          const sequence = incoming.sequence ?? 0;
          if (
            incoming.threadId !== record.threadId ||
            incoming.terminalId !== record.terminalId ||
            sequence < record.sequence
          )
            return retain(undefined);
          // A reconnect is the same process. It replaces output, never a newer close request.
          const next: TerminalStore.TerminalRecord = {
            ...record,
            status: record.status === "closing" ? "closing" : incoming.status,
            pid: incoming.pid,
            history: terminalHistoryTail(incoming.history),
            label: incoming.label,
            sequence,
            exitCode: incoming.exitCode,
            exitSignal: incoming.exitSignal,
            updatedAt: yield* nowIso,
          };
          yield* Effect.orDie(records.save(next));
          const event: TerminalEvent = {
            type: "started",
            threadId: record.threadId,
            terminalId: record.terminalId,
            sequence,
            snapshot: snapshot(next),
          };
          yield* events.emit(record.generation, event);
          return retain(undefined);
        }
        if (report.type === "result") {
          const command = yield* Effect.orDie(records.command(report.requestId));
          if (
            command === null ||
            command.outcome !== "pending" ||
            command.terminalId !== record.terminalId ||
            command.generation !== report.generation ||
            command.leaseGeneration !== leaseGeneration
          )
            return retain(undefined);
          const expected = {
            open: "opened",
            write: "written",
            resize: "resized",
            clear: "cleared",
            close: "closed",
          } as const;
          if (report.result.type !== "error" && report.result.type !== expected[command.kind])
            return retain(undefined);
          if (
            command.kind === "write" &&
            report.commandId !== undefined &&
            report.commandId !== command.commandId
          )
            return retain(undefined);
          yield* Effect.orDie(
            records.complete(report.requestId, report.result.type === "error" ? "error" : "done"),
          );
          const after = afterResult(record, report, command, yield* nowIso);
          if (after.record !== record) yield* Effect.orDie(records.save(after.record));
          if (after.record.status === "error" || after.record.status === "closed")
            yield* Effect.orDie(records.abandon(record.terminalId, record.generation));
          if (after.event !== null) yield* events.emit(record.generation, after.event);
          return retain(undefined);
        }
        if (report.sequence <= record.sequence) return retain(undefined);
        if (report.sequence !== record.sequence + 1) {
          yield* fail(
            record,
            "Terminal output is incomplete after reconnect. Restart the terminal to continue.",
            false,
          );
          return retain(undefined);
        }
        const after = afterEvent(record, report, yield* nowIso);
        yield* Effect.orDie(records.save(after.record));
        if (
          after.record.status === "error" ||
          after.record.status === "closed" ||
          after.record.status === "exited"
        ) {
          yield* Effect.orDie(records.abandon(record.terminalId, record.generation));
        }
        yield* events.emit(record.generation, after.event);
        return retain(undefined);
      }),
    );

  const lost: ThreadTerminals["Service"]["lost"] = (leaseGeneration) =>
    events.apply(() =>
      Effect.gen(function* () {
        for (const record of yield* Effect.orDie(records.all)) {
          if (record.leaseGeneration !== leaseGeneration || !terminalHoldsMachine(record)) continue;
          yield* fail(
            record,
            "The terminal process was lost when its machine stopped. Restart the terminal to continue.",
          );
        }
        return retain(undefined);
      }),
    );

  return ThreadTerminals.of({
    ...sessions,
    held: Effect.map(Effect.orDie(records.all), (all) => all.some(terminalHoldsMachine)),
    reconcile,
    connected,
    work,
    report,
    lost,
  });
});

export const layer = Layer.effect(ThreadTerminals, make).pipe(
  Layer.provideMerge(TerminalSessions.layer),
  Layer.provideMerge(TerminalEvents.layer),
);

/** The same store instance supplies the terminal hold and the thread's commands. */
export const holdLayer = Layer.effect(
  ThreadRunner.TerminalHold,
  Effect.map(TerminalStore.TerminalStore, (records) => ({
    held: Effect.map(Effect.orDie(records.all), (all) => all.some(terminalHoldsMachine)),
  })),
);
