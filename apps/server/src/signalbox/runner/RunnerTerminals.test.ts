import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import type { DriveAccess } from "@signalbox/runner-protocol/DriveProtocol";
import type { TerminalCommand, TerminalReport } from "@signalbox/runner-protocol/TerminalProtocol";
import { ThreadId } from "@t3tools/contracts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import { expect } from "vite-plus/test";

import * as ProcessRunner from "../../processRunner.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { RunnerConnectionError } from "./RunnerConnectionError.ts";
import type { RunnerDrive } from "./RunnerDrive.ts";
import { RunnerGitError } from "./RunnerGit.ts";
import { makeRunnerTerminals, type RunnerTerminals } from "./RunnerTerminals.ts";

const threadId = ThreadId.make("thread-1");
const terminalId = "term-1";
const driveAccess: DriveAccess = { driveId: "drive-1", token: "access", remoteToken: null };

class FakePtyProcess implements PtyAdapter.PtyProcess {
  readonly writes: Array<string> = [];
  readonly resizes: Array<{ readonly cols: number; readonly rows: number }> = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  readonly pid: number;
  private readonly actions: Array<string>;
  killed = false;

  constructor(pid: number, actions: Array<string>) {
    this.pid = pid;
    this.actions = actions;
  }

  write(data: string) {
    this.writes.push(data);
  }

  resize(cols: number, rows: number) {
    this.resizes.push({ cols, rows });
  }

  kill() {
    this.killed = true;
    this.actions.push(`close:${this.pid}`);
    for (const listener of this.exitListeners) listener({ exitCode: 0, signal: 15 });
  }

  onData(callback: (data: string) => void) {
    this.dataListeners.add(callback);
    return () => this.dataListeners.delete(callback);
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void) {
    this.exitListeners.add(callback);
    return () => this.exitListeners.delete(callback);
  }

  emitData(data: string) {
    for (const listener of this.dataListeners) listener(data);
  }
}

class FakePtyAdapter {
  readonly spawnInputs: Array<PtyAdapter.PtySpawnInput> = [];
  readonly processes: Array<FakePtyProcess> = [];
  private readonly actions: Array<string>;

  constructor(actions: Array<string>) {
    this.actions = actions;
  }

  spawn(input: PtyAdapter.PtySpawnInput) {
    this.spawnInputs.push(input);
    const pid = 5100 + this.processes.length;
    this.actions.push(`spawn:${pid}`);
    const process = new FakePtyProcess(pid, this.actions);
    this.processes.push(process);
    return Effect.succeed(process);
  }
}

const makeDrive = (actions: Array<string>) => {
  const state = { saves: 0, failSave: false };
  const drive = {
    prepare: () => Effect.succeed({ instructions: "", notices: [] }),
    autosave: Effect.void,
    flush: Effect.void,
    saveNow: Effect.suspend(() => {
      state.saves += 1;
      actions.push("save");
      return state.failSave
        ? Effect.fail(new RunnerGitError({ message: "drive unavailable" }))
        : Effect.void;
    }),
    changed: Effect.succeed(true),
    restoreDependencyEdits: Effect.void,
    checkpointViews: (context) => ({ context, shortcuts: [] }),
    recordCheckpoint: () => Effect.void,
    captureCheckpoint: Effect.succeed(null),
    finishTurn: () => Effect.succeed({ checkpoint: null, outcome: { _tag: "nothing_saved" } }),
    continueAfterResolution: Effect.succeed({ _tag: "nothing_saved" }),
    takeInMain: Effect.succeed({ _tag: "nothing_saved" }),
    abandonMerge: Effect.succeed({ _tag: "nothing_saved" }),
    saveBranch: () => Effect.succeed({ _tag: "not_saved", reason: "not remote-backed" }),
    published: () => Effect.void,
    pull: () => Effect.die("Unexpected remote pull in terminal fixture"),
  } satisfies RunnerDrive;
  return { drive, state };
};

const makeFixture = Effect.fn("makeRunnerTerminalFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "runner-terminal-" });
  const actions: Array<string> = [];
  const ptyAdapter = new FakePtyAdapter(actions);
  const manager = yield* TerminalManager.makeWithOptions({
    logsDir: path.join(cwd, "logs"),
    ptyAdapter,
    processKillGraceMs: 0,
  });
  const { drive, state: driveState } = makeDrive(actions);
  const incoming = yield* Queue.unbounded<TerminalReport>();
  let failNextOpenResult = false;
  let onSavedAgain: Effect.Effect<void> | null = null;
  const terminals: RunnerTerminals = yield* makeRunnerTerminals({
    threadId,
    leaseGeneration: 7,
    cwd,
    manager,
    prepareDrive: () => Effect.succeed(drive),
    watchDrive: (_drive, savedAgain) =>
      Effect.sync(() => {
        if (savedAgain !== undefined) onSavedAgain = savedAgain;
      }),
    emit: (report) => {
      if (failNextOpenResult && report.type === "result" && report.result.type === "opened") {
        failNextOpenResult = false;
        return Effect.fail(new RunnerConnectionError({ message: "Dropped open result." }));
      }
      return Queue.offer(incoming, report).pipe(Effect.asVoid);
    },
  });
  return {
    cwd,
    manager,
    ptyAdapter,
    terminals,
    incoming,
    actions,
    driveState,
    failNextOpenResult: () => {
      failNextOpenResult = true;
    },
    savedAgain: () => onSavedAgain,
  };
});

const command = (command: TerminalCommand, requestId: string) => ({
  type: "terminal.command" as const,
  requestId,
  command,
});

const takeReport = <T extends TerminalReport>(
  queue: Queue.Queue<TerminalReport>,
  matches: (report: TerminalReport) => report is T,
) =>
  Effect.gen(function* () {
    while (true) {
      const report = yield* Queue.take(queue);
      if (matches(report)) return report;
    }
  });

const takeResult = (queue: Queue.Queue<TerminalReport>, requestId: string) =>
  takeReport(
    queue,
    (report): report is Extract<TerminalReport, { readonly type: "result" }> =>
      report.type === "result" && report.requestId === requestId,
  );

const openCommand = () => ({
  type: "open" as const,
  threadId,
  terminalId,
  generation: 1,
  leaseGeneration: 7,
  drive: driveAccess,
  cols: 100,
  rows: 30,
});

const layer = Layer.merge(
  Layer.merge(NodeCrypto.layer, NodeServices.layer),
  ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
);

it.layer(layer, { excludeTestServices: true })("RunnerTerminals", (it) => {
  it.effect(
    "writes, replays output, clears, resizes, closes and saves through TerminalManager",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeFixture();
          const base = { threadId, terminalId, generation: 1, leaseGeneration: 7 } as const;

          yield* fixture.terminals.handleCommand(command(openCommand(), "open-1"));
          const opened = yield* takeResult(fixture.incoming, "open-1");
          assert.equal(opened.result.type, "opened");
          const process = fixture.ptyAdapter.processes[0];
          assert.ok(process);
          assert.equal(fixture.ptyAdapter.spawnInputs[0]?.cwd, fixture.cwd);

          const write: TerminalCommand = {
            type: "write",
            ...base,
            commandId: "write-1",
            data: "printf test\n",
          };
          const writeMessage = command(write, "write-request-1");
          yield* fixture.terminals.handleCommand(writeMessage);
          expect((yield* takeResult(fixture.incoming, "write-request-1")).result).toEqual({
            type: "written",
          });
          yield* fixture.terminals.handleCommand(writeMessage);
          yield* takeResult(fixture.incoming, "write-request-1");
          expect(process.writes).toEqual(["printf test\n"]);

          yield* fixture.terminals.handleCommand(
            command({ ...write, data: "different\n" }, "write-request-2"),
          );
          const conflict = yield* takeResult(fixture.incoming, "write-request-2");
          expect(conflict.result).toMatchObject({ type: "error", code: "command_id_conflict" });
          expect(process.writes).toHaveLength(1);

          process.emitData("output from the terminal\n");
          const output = yield* takeReport(
            fixture.incoming,
            (report): report is Extract<TerminalReport, { readonly type: "event" }> =>
              report.type === "event" && report.event.type === "output",
          );
          expect(output.event).toEqual({ type: "output", data: "output from the terminal\n" });

          yield* fixture.terminals.replayEvents(Effect.void);
          const replayed = yield* takeReport(
            fixture.incoming,
            (report): report is Extract<TerminalReport, { readonly type: "snapshot" }> =>
              report.type === "snapshot",
          );
          expect(replayed.snapshot.history).toContain("output from the terminal");
          const replayedOutput = yield* takeReport(
            fixture.incoming,
            (report): report is Extract<TerminalReport, { readonly type: "event" }> =>
              report.type === "event" && report.event.type === "output",
          );
          expect(replayedOutput.sequence).toBe(output.sequence);

          yield* fixture.terminals.handleCommand(command({ type: "clear", ...base }, "clear-1"));
          const cleared = yield* takeReport(
            fixture.incoming,
            (report): report is Extract<TerminalReport, { readonly type: "event" }> =>
              report.type === "event" && report.event.type === "cleared",
          );
          expect(cleared.sequence).toBe(output.sequence + 1);
          yield* takeResult(fixture.incoming, "clear-1");
          yield* fixture.terminals.replayEvents(Effect.void);
          const afterClear = yield* takeReport(
            fixture.incoming,
            (report): report is Extract<TerminalReport, { readonly type: "snapshot" }> =>
              report.type === "snapshot",
          );
          expect(afterClear.snapshot.history).toBe("");

          yield* fixture.terminals.handleCommand(
            command({ type: "resize", ...base, cols: 125, rows: 41 }, "resize-1"),
          );
          expect((yield* takeResult(fixture.incoming, "resize-1")).result).toEqual({
            type: "resized",
          });
          expect(process.resizes).toEqual([{ cols: 125, rows: 41 }]);

          yield* fixture.terminals.handleCommand(command({ type: "close", ...base }, "close-1"));
          expect((yield* takeResult(fixture.incoming, "close-1")).result).toEqual({
            type: "closed",
          });
          expect(process.killed).toBe(true);
          expect(fixture.driveState.saves).toBe(1);
        }),
      ),
  );

  it.effect("emits an authoritative snapshot after an autosave recovery and retries close", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const base = { threadId, terminalId, generation: 1, leaseGeneration: 7 } as const;
        yield* fixture.terminals.handleCommand(command(openCommand(), "open-1"));
        yield* takeResult(fixture.incoming, "open-1");

        fixture.driveState.failSave = true;
        const close = command({ type: "close", ...base }, "close-1");
        const failed = yield* Effect.exit(fixture.terminals.handleCommand(close));
        expect(failed._tag).toBe("Failure");
        expect(fixture.driveState.saves).toBe(1);
        expect(fixture.savedAgain()).not.toBeNull();

        fixture.driveState.failSave = false;
        yield* fixture.savedAgain()!;
        const recovered = yield* takeReport(
          fixture.incoming,
          (report): report is Extract<TerminalReport, { readonly type: "snapshot" }> =>
            report.type === "snapshot",
        );
        expect(recovered).toMatchObject({
          type: "snapshot",
          terminalId,
          generation: 1,
          leaseGeneration: 7,
          snapshot: { status: "exited", pid: null },
        });

        yield* fixture.terminals.handleCommand(close);
        expect((yield* takeResult(fixture.incoming, "close-1")).result).toEqual({ type: "closed" });
        expect(fixture.driveState.saves).toBe(2);
      }),
    ),
  );

  it.effect("replaces a terminal generation and rejects commands from its old process", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const first = { threadId, terminalId, generation: 1, leaseGeneration: 7 } as const;
        yield* fixture.terminals.handleCommand(command(openCommand(), "open-1"));
        expect((yield* takeResult(fixture.incoming, "open-1")).result.type).toBe("opened");
        const oldProcess = fixture.ptyAdapter.processes[0];
        assert.ok(oldProcess);
        oldProcess.emitData("before restart\n");
        yield* takeReport(
          fixture.incoming,
          (report): report is Extract<TerminalReport, { readonly type: "event" }> =>
            report.type === "event" && report.event.type === "output",
        );

        yield* fixture.terminals.handleCommand(
          command({ ...openCommand(), generation: 2 }, "open-2"),
        );
        const restarted = yield* takeResult(fixture.incoming, "open-2");
        expect(restarted).toMatchObject({
          generation: 2,
          result: { type: "opened", snapshot: { sequence: 0, history: "" } },
        });
        expect(oldProcess.killed).toBe(true);
        expect(fixture.ptyAdapter.processes).toHaveLength(2);
        expect(fixture.actions).toEqual(["spawn:5100", "close:5100", "save", "spawn:5101"]);

        yield* fixture.terminals.handleCommand(
          command(
            {
              type: "write",
              ...first,
              commandId: "late-write-1",
              data: "stale input\n",
            },
            "late-write-request",
          ),
        );
        expect((yield* takeResult(fixture.incoming, "late-write-request")).result).toMatchObject({
          type: "error",
          code: "stale_terminal_generation",
        });

        yield* fixture.terminals.replayEvents(Effect.void);
        const snapshot = yield* takeReport(
          fixture.incoming,
          (report): report is Extract<TerminalReport, { readonly type: "snapshot" }> =>
            report.type === "snapshot",
        );
        expect(snapshot).toMatchObject({
          generation: 2,
          snapshot: { sequence: 0 },
        });
      }),
    ),
  );

  it.effect("holds new PTY output until reconnect snapshots have been sent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.terminals.handleCommand(command(openCommand(), "open-1"));
        yield* takeResult(fixture.incoming, "open-1");
        const process = fixture.ptyAdapter.processes[0];
        assert.ok(process);

        yield* fixture.terminals.replayEvents(
          Effect.sync(() => process.emitData("during reconnect\n")),
        );
        const first = yield* Queue.take(fixture.incoming);
        expect(first.type).toBe("snapshot");
        const output = yield* takeReport(
          fixture.incoming,
          (report): report is Extract<TerminalReport, { readonly type: "event" }> =>
            report.type === "event" && report.event.type === "output",
        );
        expect(output.event).toEqual({ type: "output", data: "during reconnect\n" });
      }),
    ),
  );

  it.effect("clears Manager history when an explicit close is followed by a reopen", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const base = { threadId, terminalId, generation: 1, leaseGeneration: 7 } as const;
        yield* fixture.terminals.handleCommand(command(openCommand(), "open-1"));
        yield* takeResult(fixture.incoming, "open-1");
        const process = fixture.ptyAdapter.processes[0];
        assert.ok(process);
        process.emitData("history to delete\n");
        yield* takeReport(
          fixture.incoming,
          (report): report is Extract<TerminalReport, { readonly type: "event" }> =>
            report.type === "event" && report.event.type === "output",
        );

        yield* fixture.terminals.handleCommand(command({ type: "close", ...base }, "close-1"));
        expect((yield* takeResult(fixture.incoming, "close-1")).result).toEqual({
          type: "closed",
        });

        const reopened = yield* fixture.manager.open({
          threadId,
          terminalId,
          cwd: fixture.cwd,
          cols: 100,
          rows: 30,
        });
        expect(reopened.history).toBe("");
      }),
    ),
  );

  it.effect("restores live output after replaying a failed open receipt across reconnect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const opening = command(openCommand(), "open-1");
        fixture.failNextOpenResult();
        const failedOpen = yield* Effect.exit(fixture.terminals.handleCommand(opening));
        expect(failedOpen._tag).toBe("Failure");

        const process = fixture.ptyAdapter.processes[0];
        assert.ok(process);
        process.emitData("queued before reconnect\n");
        yield* fixture.terminals.replayEvents(Effect.void);
        yield* takeReport(
          fixture.incoming,
          (report): report is Extract<TerminalReport, { readonly type: "snapshot" }> =>
            report.type === "snapshot",
        );
        const queuedOutput = yield* takeReport(
          fixture.incoming,
          (report): report is Extract<TerminalReport, { readonly type: "event" }> =>
            report.type === "event" &&
            report.event.type === "output" &&
            report.event.data === "queued before reconnect\n",
        );
        expect(queuedOutput.event).toMatchObject({
          type: "output",
          data: "queued before reconnect\n",
        });

        yield* fixture.terminals.handleCommand({
          ...opening,
          command: { ...openCommand(), cols: 132, rows: 40 },
        });
        expect((yield* takeResult(fixture.incoming, "open-1")).result.type).toBe("opened");
        expect(fixture.ptyAdapter.processes).toHaveLength(1);
        expect(yield* Queue.size(fixture.incoming)).toBe(0);

        process.emitData("live after retry\n");
        const liveOutput = yield* takeReport(
          fixture.incoming,
          (report): report is Extract<TerminalReport, { readonly type: "event" }> =>
            report.type === "event" &&
            report.event.type === "output" &&
            report.event.data === "live after retry\n",
        );
        expect(liveOutput.event).toEqual({ type: "output", data: "live after retry\n" });

        yield* fixture.terminals.replayEvents(Effect.void);
        const finalSnapshot = yield* takeReport(
          fixture.incoming,
          (report): report is Extract<TerminalReport, { readonly type: "snapshot" }> =>
            report.type === "snapshot",
        );
        expect(finalSnapshot.snapshot.history).toContain("queued before reconnect");
        expect(finalSnapshot.snapshot.history).toContain("live after retry");
      }),
    ),
  );
});
