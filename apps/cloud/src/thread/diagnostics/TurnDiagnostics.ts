import type {
  MachineUsage,
  RunnerHello,
  RunnerItem,
} from "@signalbox/runner-protocol/RunnerProtocol";
import type { RunId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ModelGatewayRecord } from "../../modelGateway/modelGatewayRecord.ts";
import { MachineBackend, type MachineStatus } from "../runner/MachineBackend.ts";
import {
  type DiagnosedRun,
  DiagnosticsStore,
  type LogLine,
  type MachineSession,
  type RunDiagnostics,
  type StopReason,
} from "./DiagnosticsStore.ts";
import { traceIdOf } from "./traceId.ts";

/**
 * Records what explains a thread's turns as it happens: the machine lease's
 * lifecycle, the Runner's usage and log lines, and the ModelGateway's
 * requests. Every line carries the machine generation and, while a turn is
 * live, its run, so a turn's record (`TurnReports`) holds its machines'
 * lifecycle receipts, the Runner's own lines and its model requests.
 *
 * Callers hold the thread's lock (`ThreadEngine.apply`), so a read-then-save
 * here never races another.
 */

type Run = DiagnosedRun;

export class TurnDiagnostics extends Context.Service<
  TurnDiagnostics,
  {
    /** The lease asked for a machine at `generation`, for `run`. */
    readonly machineRequested: (input: {
      readonly generation: number;
      readonly run: Run;
      readonly now: number;
    }) => Effect.Effect<void>;
    /** What the backend answered, or why it failed. Repeats of the same answer are not logged. */
    readonly machineReported: (input: {
      readonly generation: number;
      readonly runId: RunId | null;
      readonly operation: "ensure" | "stop" | "refresh" | "inspect";
      readonly status?: MachineStatus;
      readonly error?: string;
      readonly now: number;
    }) => Effect.Effect<void>;
    /** The thread let a Runner in; `connection` counts its connections in the generation. */
    readonly runnerConnected: (input: {
      readonly hello: RunnerHello;
      readonly connection: number;
      readonly run: Run | null;
      readonly now: number;
    }) => Effect.Effect<void>;
    readonly runnerClosed: (input: {
      readonly generation: number;
      readonly runId: RunId | null;
      readonly detail: string;
      readonly now: number;
    }) => Effect.Effect<void>;
    /**
     * A Runner batch committed: its usage samples and log lines. A turn's
     * last sample follows its end, so samples are matched to `runs`, not just
     * the live one.
     */
    readonly batch: (input: {
      readonly generation: number;
      readonly sequence: number;
      readonly items: ReadonlyArray<RunnerItem>;
      readonly liveRunId: RunId | null;
      readonly runs: ReadonlyArray<Run>;
      readonly now: number;
    }) => Effect.Effect<void>;
    /** The lease let the machine go: the session ends. */
    readonly released: (input: {
      readonly generation: number;
      readonly reason: StopReason;
      readonly detail: string | null;
      readonly idleSince: number | null;
      readonly runId: RunId | null;
      readonly now: number;
    }) => Effect.Effect<void>;
    /** A better stop reason, learned after release (the backend says its TTL stopped it). */
    readonly refineStop: (generation: number, reason: StopReason) => Effect.Effect<void>;
    /** A request the ModelGateway served for a turn of this thread. */
    readonly modelRequest: (record: ModelGatewayRecord, now: number) => Effect.Effect<void>;
  }
>()("@signalbox/cloud/thread/diagnostics/TurnDiagnostics") {}

const describeStatus = (status: MachineStatus) =>
  [status.actual, status.machineId === null ? null : `machine ${status.machineId}`, status.detail]
    .filter((part) => part != null && part !== "")
    .join(": ");

/** Adds one usage sample: the first on a machine is the baseline, later ones add what was used since. */
const withUsage = (
  diagnostics: RunDiagnostics,
  sample: MachineUsage,
  generation: number,
): RunDiagnostics => {
  const sameGeneration = diagnostics.lastUsageGeneration === generation;
  const previousCpu = sameGeneration ? (diagnostics.lastUsage?.cpuSeconds ?? null) : null;
  return {
    ...diagnostics,
    cpuSeconds:
      sample.cpuSeconds === null
        ? diagnostics.cpuSeconds
        : (diagnostics.cpuSeconds ?? 0) +
          (previousCpu === null ? 0 : Math.max(0, sample.cpuSeconds - previousCpu)),
    lastUsage: sample,
    lastUsageGeneration: generation,
    memoryPeakBytes:
      sample.memoryBytes === null
        ? diagnostics.memoryPeakBytes
        : Math.max(diagnostics.memoryPeakBytes ?? 0, sample.memoryBytes),
    usageSamples: diagnostics.usageSamples + 1,
  };
};

/** Notes that the run is on `generation`. A second machine for one turn is a recovery. */
const attach = (diagnostics: RunDiagnostics, generation: number): RunDiagnostics =>
  diagnostics.generations.includes(generation)
    ? diagnostics
    : {
        ...diagnostics,
        generations: [...diagnostics.generations, generation],
        recoveries: diagnostics.recoveries + (diagnostics.generations.length > 0 ? 1 : 0),
      };

const make = Effect.gen(function* () {
  const store = yield* DiagnosticsStore;
  const backend = yield* MachineBackend;
  const crypto = yield* Crypto.Crypto;
  /** The last answer logged per generation and operation, so a polled backend logs once per change. */
  const lastReported = new Map<string, string>();

  const log = (
    line: Omit<LogLine, "level"> & { readonly level?: LogLine["level"] },
    key?: string,
  ) => store.log({ level: "info", ...line }, key);

  const runOf = (run: Run) =>
    Effect.gen(function* () {
      const existing = yield* store.run(run.id);
      if (existing !== null) return existing;
      return {
        runId: run.id,
        ordinal: run.ordinal,
        traceId: yield* traceIdOf(run.id).pipe(Effect.provideService(Crypto.Crypto, crypto)),
        generations: [],
        recoveries: 0,
        cpuSeconds: null,
        lastUsage: null,
        lastUsageGeneration: null,
        memoryPeakBytes: null,
        usageSamples: 0,
        modelRequests: 0,
        modelTokens: {},
      } satisfies RunDiagnostics;
    });

  /** Saves the session's update, unless it returned the session unchanged. */
  const updateSession = (generation: number, update: (session: MachineSession) => MachineSession) =>
    Effect.flatMap(store.session(generation), (session) => {
      if (session === null) return Effect.void;
      const next = update(session);
      return next === session ? Effect.void : store.saveSession(next);
    });

  const machineRequested: TurnDiagnostics["Service"]["machineRequested"] = ({
    generation,
    run,
    now,
  }) =>
    Effect.gen(function* () {
      yield* store.saveRun(attach(yield* runOf(run), generation));
      yield* store.saveSession({
        generation,
        runId: run.id,
        backend: backend.kind,
        shape: backend.shape,
        image: backend.image,
        machineId: null,
        wake: null,
        requestedAt: now,
        readyAt: null,
        firstEventAt: null,
        runner: null,
        connections: 0,
        usage: null,
        runs: [run.id],
        endedAt: null,
        idleTailMs: null,
        stopReason: null,
        stopDetail: null,
      });
      yield* log({
        at: now,
        generation,
        runId: run.id,
        source: "thread",
        message: `Asked the ${backend.kind} backend for machine generation ${generation}${
          backend.image === null ? "" : ` running ${backend.image}`
        }.`,
      });
    });

  const machineReported: TurnDiagnostics["Service"]["machineReported"] = (input) =>
    Effect.gen(function* () {
      const status = input.status;
      const message =
        input.error === undefined
          ? `${input.operation}: ${status === undefined ? "ok" : describeStatus(status)}`
          : `${input.operation} failed: ${input.error}`;
      const key = `${input.generation}:${input.operation}`;
      if (lastReported.get(key) === message) return;
      lastReported.set(key, message);
      if (status !== undefined) {
        yield* updateSession(input.generation, (session) =>
          (status.machineId === null || status.machineId === session.machineId) &&
          (session.wake !== null || status.wake === undefined)
            ? session
            : {
                ...session,
                machineId: status.machineId ?? session.machineId,
                wake: session.wake ?? status.wake ?? null,
              },
        );
      }
      yield* log({
        at: input.now,
        generation: input.generation,
        runId: input.runId,
        source: "machine",
        level: input.error !== undefined || status?.actual === "failed" ? "error" : "info",
        message,
      });
    });

  const runnerConnected: TurnDiagnostics["Service"]["runnerConnected"] = ({
    hello,
    connection,
    run,
    now,
  }) =>
    Effect.gen(function* () {
      yield* updateSession(hello.generation, (session) => ({
        ...session,
        readyAt: session.readyAt ?? now,
        connections: session.connections + 1,
        runner: {
          protocolVersion: hello.protocolVersion,
          imageVersion: hello.imageVersion,
          machineId: hello.machineId,
          build: hello.build ?? null,
        },
      }));
      if (run !== null && connection > 1) {
        const diagnostics = yield* runOf(run);
        yield* store.saveRun({ ...diagnostics, recoveries: diagnostics.recoveries + 1 });
      }
      const machine = `Runner ${hello.imageVersion} on ${hello.machineId}`;
      yield* log({
        at: now,
        generation: hello.generation,
        runId: run?.id ?? null,
        source: "thread",
        message:
          connection === 1
            ? `${machine} connected.`
            : `${machine} reconnected (connection ${connection}), resending after batch ${hello.lastAckedSequence}.`,
      });
    });

  const runnerClosed: TurnDiagnostics["Service"]["runnerClosed"] = (input) =>
    log({
      at: input.now,
      generation: input.generation,
      runId: input.runId,
      source: "thread",
      level: "warning",
      message: `Runner socket closed: ${input.detail}`,
    });

  const batch: TurnDiagnostics["Service"]["batch"] = ({
    generation,
    sequence,
    items,
    liveRunId,
    runs,
    now,
  }) =>
    Effect.gen(function* () {
      const usage = items.findLast((item) => item.kind === "usage");
      yield* updateSession(generation, (session) =>
        session.firstEventAt !== null &&
        usage === undefined &&
        (liveRunId === null || session.runs.includes(liveRunId))
          ? session
          : {
              ...session,
              firstEventAt: session.firstEventAt ?? now,
              usage: usage?.kind === "usage" ? usage.usage : session.usage,
              runs:
                liveRunId === null || session.runs.includes(liveRunId)
                  ? session.runs
                  : [...session.runs, liveRunId],
            },
      );
      // The run records this batch changes, saved once at the end.
      const changed = new Map<string, RunDiagnostics>();
      const recordOf = (run: Run) => {
        const known = changed.get(run.id);
        return known === undefined ? runOf(run) : Effect.succeed(known);
      };
      const live = runs.find((run) => run.id === liveRunId);
      if (live !== undefined) {
        const diagnostics = yield* recordOf(live);
        const attached = attach(diagnostics, generation);
        if (attached !== diagnostics) changed.set(live.id, attached);
      }
      for (const [index, item] of items.entries()) {
        if (item.kind === "log") {
          yield* log(
            {
              at: now,
              generation,
              runId: item.runId,
              source: "runner",
              level: item.level,
              message: item.message,
            },
            `runner:${generation}:${sequence}:${index}`,
          );
        }
        if (item.kind !== "usage" || item.runId === null) continue;
        const sampled = runs.find((run) => run.id === item.runId);
        if (sampled === undefined) continue;
        changed.set(sampled.id, withUsage(yield* recordOf(sampled), item.usage, generation));
      }
      yield* Effect.forEach(changed.values(), store.saveRun, { discard: true });
    });

  const released: TurnDiagnostics["Service"]["released"] = (input) =>
    Effect.gen(function* () {
      yield* updateSession(input.generation, (session) =>
        session.endedAt !== null
          ? session
          : {
              ...session,
              endedAt: input.now,
              idleTailMs: input.idleSince === null ? 0 : input.now - input.idleSince,
              stopReason: input.reason,
              stopDetail: input.detail,
            },
      );
      yield* log({
        at: input.now,
        generation: input.generation,
        runId: input.runId,
        source: "thread",
        level: input.reason === "error" ? "error" : "info",
        message: `Released machine generation ${input.generation} (${input.reason})${
          input.detail === null ? "." : `: ${input.detail}`
        }`,
      });
    });

  const refineStop: TurnDiagnostics["Service"]["refineStop"] = (generation, reason) =>
    updateSession(generation, (session) =>
      session.stopReason === reason ? session : { ...session, stopReason: reason },
    );

  const modelRequest: TurnDiagnostics["Service"]["modelRequest"] = (record, now) =>
    Effect.gen(function* () {
      if (record.runId === null) return;
      const diagnostics = yield* store.run(record.runId);
      // Not a turn this thread handed to a machine.
      if (diagnostics === null) return;
      const tokens = record.usage;
      const parts = [
        `${record.provider} ${record.method} ${record.path} ${record.status}`,
        record.outcome,
        record.model,
        record.firstChunkMs === null ? null : `first chunk ${record.firstChunkMs} ms`,
        record.addedMs === null ? null : `gateway added ${record.addedMs} ms`,
        `${record.totalMs} ms`,
        tokens === null
          ? null
          : `tokens in ${tokens.input} out ${tokens.output} cache read ${tokens.cacheRead} write ${tokens.cacheWrite}`,
      ];
      yield* log({
        at: now,
        generation: diagnostics.generations.at(-1) ?? null,
        runId: record.runId,
        source: "gateway",
        level: record.status >= 400 ? "warning" : "info",
        message: parts.filter((part) => part != null).join(", "),
      });
      const model = record.model ?? "unknown";
      const before = diagnostics.modelTokens[model] ?? {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
      yield* store.saveRun({
        ...diagnostics,
        modelRequests: diagnostics.modelRequests + 1,
        modelTokens:
          tokens === null
            ? diagnostics.modelTokens
            : {
                ...diagnostics.modelTokens,
                [model]: {
                  input: before.input + tokens.input,
                  output: before.output + tokens.output,
                  cacheRead: before.cacheRead + tokens.cacheRead,
                  cacheWrite: before.cacheWrite + tokens.cacheWrite,
                },
              },
      });
    });

  return TurnDiagnostics.of({
    machineRequested,
    machineReported,
    runnerConnected,
    runnerClosed,
    batch,
    released,
    refineStop,
    modelRequest,
  });
});

export const layer = Layer.effect(TurnDiagnostics, make);
