// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - This standalone Node adapter owns process deadlines and timestamps.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import {
  defaultAdapter,
  type StartupProcessAdapter,
  type StartupProcessRow,
} from "./processResources.ts";
export type { StartupProcessAdapter, StartupProcessRow } from "./processResources.ts";

export interface StartupProcessLimits {
  readonly deadlineMs: number;
  readonly sampleMs: number;
  readonly terminateMs: number;
  readonly killWaitMs: number;
  readonly rssBytes: number;
  readonly logBytes: number;
  readonly outputBytes: number;
  readonly profileBytes: number;
  readonly diskFloorBytes: number;
}

export type StartupWorkerdEvent =
  | { readonly event: "workerd-spawn"; readonly pid: number; readonly guardPassed?: boolean }
  | {
      readonly event: "workerd-close";
      readonly pid: number;
      readonly streamsClosed?: readonly boolean[];
    };

export interface StartupProfilerInput {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly output: string;
  readonly ledgerFile: string;
  readonly profileFile: string;
  readonly limits: StartupProcessLimits;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const decodeEvents = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      event: Schema.Literals(["workerd-spawn", "workerd-close"]),
      pid: Schema.Number,
      guardPassed: Schema.optionalKey(Schema.Boolean),
      streamsClosed: Schema.optionalKey(Schema.Array(Schema.Boolean)),
    }),
  ),
);

function errorText(cause: unknown) {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}

async function writeClosure(output: string, value: unknown) {
  await NodeFSP.writeFile(NodePath.join(output, "closure.json"), json(value), { flag: "wx" });
}

/** Owns one detached process group until both Wrangler and every owned child have closed. */
export async function runStartupProfiler(
  input: StartupProfilerInput,
  adapter: StartupProcessAdapter = defaultAdapter,
) {
  const startedAt = adapter.now();
  const logPath = NodePath.join(input.output, "stdout-stderr.log");
  const observationPath = NodePath.join(input.output, "resources.jsonl");
  let log: NodeFSP.FileHandle | undefined;
  let observations: NodeFSP.FileHandle | undefined;
  let child: ReturnType<typeof NodeChildProcess.spawn> | undefined;
  let childClosed = false;
  let terminal: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let failure: unknown;
  let failureExportError: unknown;
  let terminating = false;
  let shuttingDown = false;
  let bytesLogged = 0;
  let peakRssBytes = 0;
  let sampling = false;
  let sampleInFlight: Promise<void> = Promise.resolve();
  const stopTimers: ReturnType<typeof setTimeout>[] = [];
  let timerExpired = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  const writes: Promise<unknown>[] = [];
  let parsedEvents: readonly StartupWorkerdEvent[] = [];
  let ledgerError: string | null = null;
  let rows: StartupProcessRow[] = [];
  const terminationErrors: string[] = [];

  const appendFailure = (cause: unknown) => {
    if (failure !== undefined) return;
    failure = cause;
    try {
      // Record the first cause synchronously before sending any signal to the owned group.
      NodeFS.writeFileSync(
        NodePath.join(input.output, "first-failure.json"),
        json({ message: errorText(cause) }),
        { flag: "wx" },
      );
    } catch (writeCause) {
      failureExportError = writeCause;
    }
  };

  const signalGroup = (signal: NodeJS.Signals) => {
    if (child?.pid === undefined || !Number.isSafeInteger(child.pid) || child.pid <= 0) return;
    try {
      adapter.signalGroup(child.pid, signal);
    } catch (cause) {
      terminationErrors.push(errorText(cause));
    }
  };

  const inspectGroup = async (group: number) => {
    return adapter.groupProcesses(group);
  };

  const stop = (cause: unknown) => {
    appendFailure(cause);
    if (terminating || shuttingDown) return;
    terminating = true;
    signalGroup("SIGTERM");
    stopTimers.push(
      setTimeout(() => {
        try {
          signalGroup("SIGKILL");
        } catch (killCause) {
          if (failure === undefined) appendFailure(killCause);
        }
        stopTimers.push(
          setTimeout(() => {
            timerExpired = true;
            try {
              NodeFS.writeFileSync(
                NodePath.join(input.output, "uncertain-closure.json"),
                json({
                  status: "WORKER_STARTUP_UNCERTAIN_CHILD_CLOSURE",
                  wranglerPid: child?.pid ?? null,
                  wranglerWaited: childClosed,
                  terminal: terminal ?? null,
                  lastObservedOwnedGroup: rows,
                  failure: errorText(failure),
                  supervisionRetained: true,
                }),
                { flag: "wx" },
              );
            } catch (cause) {
              terminationErrors.push(errorText(cause));
            }
          }, input.limits.killWaitMs),
        );
      }, input.limits.terminateMs),
    );
  };

  const signalHandler = () => stop(new Error("WORKER_STARTUP_INTERRUPTED"));
  const sample = async () => {
    adapter.admission();
    if (!child?.pid) throw new Error("WORKER_STARTUP_CHILD_PID_MISSING");
    const [nextRows, free, bytes] = await Promise.all([
      inspectGroup(child.pid),
      adapter.freeBytes(input.output),
      adapter.outputBytes(input.output),
    ]);
    rows = nextRows;
    const rss = rows.reduce((total, row) => total + row.rssBytes, 0);
    peakRssBytes = Math.max(peakRssBytes, rss);
    if (!observations) throw new Error("WORKER_STARTUP_OBSERVATION_LOG_UNAVAILABLE");
    writes.push(
      observations
        .write(
          `${JSON.stringify({ at: new Date().toISOString(), rows, rssBytes: rss, freeBytes: free, outputBytes: bytes })}\n`,
        )
        .catch((cause) => {
          stop(cause);
        }),
    );
    const profileSize = await NodeFSP.stat(input.profileFile)
      .then((stats) => stats.size)
      .catch((cause: unknown) => {
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return 0;
        throw cause;
      });
    if (
      rss > input.limits.rssBytes ||
      free < input.limits.diskFloorBytes ||
      bytes > input.limits.outputBytes ||
      profileSize > input.limits.profileBytes
    )
      throw new Error("WORKER_STARTUP_RESOURCE_LIMIT");
  };

  const onOutput = (chunk: Buffer) => {
    const remaining = input.limits.logBytes - bytesLogged;
    const retained = chunk.subarray(0, Math.max(remaining, 0));
    bytesLogged += retained.byteLength;
    if (retained.byteLength) {
      if (!log) {
        stop(new Error("WORKER_STARTUP_LOG_UNAVAILABLE"));
        return;
      }
      writes.push(
        log.write(retained).catch((cause) => {
          stop(cause);
        }),
      );
    }
    if (retained.byteLength < chunk.byteLength) stop(new Error("WORKER_STARTUP_LOG_LIMIT"));
  };

  let closedResolve: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });
  try {
    log = await NodeFSP.open(logPath, "wx");
    observations = await NodeFSP.open(observationPath, "wx");
    if (!input.command.length || !input.command[0])
      throw new Error("WORKER_STARTUP_COMMAND_MISSING");
    child = adapter.spawn(input.command[0], input.command.slice(1), {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    child.once("error", (cause) => stop(cause));
    child.once("close", (code, signal) => {
      childClosed = true;
      terminal = { code, signal };
      closedResolve();
    });
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);
    process.once("SIGTERM", signalHandler);
    process.once("SIGINT", signalHandler);
    process.once("SIGHUP", signalHandler);

    deadline = setTimeout(
      () => stop(new Error("WORKER_STARTUP_DEADLINE")),
      input.limits.deadlineMs,
    );
    const tick = () => {
      if (shuttingDown || sampling || childClosed) return;
      sampling = true;
      sampleInFlight = sample()
        .catch((cause: unknown) => {
          if (!shuttingDown) stop(cause);
        })
        .finally(() => {
          sampling = false;
        });
    };
    tick();
    interval = setInterval(tick, input.limits.sampleMs);

    await closed;
    clearInterval(interval);
    interval = undefined;
    await sampleInFlight;

    if (childClosed) {
      if (!terminal || terminal.code !== 0 || terminal.signal !== null)
        stop(
          new Error(
            `WORKER_STARTUP_WRANGLER_EXIT_FAILED: code=${terminal?.code ?? "unknown"} signal=${terminal?.signal ?? "none"}`,
          ),
        );
      // Capture descendants left behind by an otherwise successful Wrangler exit.
      try {
        rows = child?.pid ? await inspectGroup(child.pid) : [];
        if (rows.length && failure === undefined)
          stop(new Error("WORKER_STARTUP_DESCENDANTS_AFTER_WRANGLER_EXIT"));
      } catch (cause) {
        stop(cause);
      }
    }

    try {
      const raw = await NodeFSP.readFile(input.ledgerFile, "utf8");
      parsedEvents = decodeEvents(
        raw
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      );
    } catch (cause) {
      ledgerError = errorText(cause);
      stop(new Error(`WORKER_STARTUP_LEDGER_INVALID: ${ledgerError}`));
    }

    if (childClosed && child?.pid && failure === undefined) {
      try {
        adapter.admission();
        const [free, bytes, profileStats] = await Promise.all([
          adapter.freeBytes(input.output),
          adapter.outputBytes(input.output),
          NodeFSP.stat(input.profileFile).catch((cause: unknown) => {
            if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
              return { size: 0 };
            throw cause;
          }),
        ]);
        if (
          free < input.limits.diskFloorBytes ||
          bytes > input.limits.outputBytes ||
          profileStats.size > input.limits.profileBytes
        )
          stop(new Error("WORKER_STARTUP_FINAL_RESOURCE_LIMIT"));
      } catch (cause) {
        stop(cause);
      }
    }
  } catch (cause) {
    stop(cause);
  } finally {
    if (interval) clearInterval(interval);
    await sampleInFlight;
    if (child) {
      // A deadline stops profiling and signals once; it cannot transfer ownership of live children.
      await closed;
      if (child.pid !== undefined) {
        const group = child.pid;
        const ownedGroupClosed = async () => {
          try {
            rows = await inspectGroup(group);
            if (rows.length === 0) return true;
            stop(new Error("WORKER_STARTUP_DESCENDANTS_AFTER_WRANGLER_EXIT"));
          } catch (cause) {
            stop(cause);
          }
          return false;
        };
        while (!(await ownedGroupClosed()))
          await new Promise((resolve) => setTimeout(resolve, input.limits.sampleMs));
      }
    }
    shuttingDown = true;
    if (deadline) clearTimeout(deadline);
    for (const timer of stopTimers) clearTimeout(timer);
    process.off("SIGTERM", signalHandler);
    process.off("SIGINT", signalHandler);
    process.off("SIGHUP", signalHandler);
    await Promise.allSettled(writes);
  }
  const streamStates = child ? [child.stdout?.closed === true, child.stderr?.closed === true] : [];
  const spawns = parsedEvents.filter((event) => event.event === "workerd-spawn");
  const exits = parsedEvents.filter((event) => event.event === "workerd-close");
  const spawn = spawns[0];
  const exit = exits[0];
  const exitStreams = exit?.streamsClosed;
  let remainingOwnedGroup: StartupProcessRow[] = rows;
  if (child?.pid) {
    try {
      remainingOwnedGroup = await inspectGroup(child.pid);
    } catch (cause) {
      if (failure === undefined) appendFailure(cause);
    }
  }
  const joined =
    spawns.length === 1 &&
    exits.length === 1 &&
    spawn?.pid === exit?.pid &&
    spawn?.guardPassed === true &&
    exitStreams?.length === 4 &&
    exitStreams.every(Boolean) &&
    childClosed &&
    streamStates.every(Boolean) &&
    remainingOwnedGroup.length === 0;
  await Promise.allSettled(
    [log?.close(), observations?.close()].filter(
      (promise): promise is Promise<void> => promise !== undefined,
    ),
  );
  if (!joined && failure === undefined)
    appendFailure(new Error("WORKER_STARTUP_PROFILER_OR_CLOSURE_FAILED"));
  const closure = {
    command: input.command,
    cwd: input.cwd,
    terminal: terminal ?? null,
    wranglerPid: child?.pid ?? null,
    wranglerWaited: childClosed,
    streamsClosed: streamStates,
    events: parsedEvents,
    ledgerError,
    remainingOwnedGroup,
    joined,
    peakRssBytes,
    wallMs: adapter.now() - startedAt,
    failure: failure === undefined ? null : errorText(failure),
    failureExportError: failureExportError === undefined ? null : errorText(failureExportError),
    terminationErrors,
    terminationDeadlineExceeded: timerExpired,
    limits: input.limits,
  };
  try {
    await writeClosure(input.output, closure);
  } catch (cause) {
    if (failure === undefined) failure = cause;
  }
  if (failure !== undefined) throw failure;
  if (!childClosed || !terminal || !joined)
    throw new Error("WORKER_STARTUP_PROFILER_OR_CLOSURE_FAILED");
  return {
    terminal,
    wranglerPid: child?.pid,
    wranglerWaited: childClosed,
    streamsClosed: streamStates,
    events: parsedEvents,
    remainingOwnedGroup,
    joined,
    peakRssBytes,
    wallMs: adapter.now() - startedAt,
  };
}
