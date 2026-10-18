// @effect-diagnostics nodeBuiltinImport:off - integration tests need a real child process for byte streams.
import { Buffer } from "node:buffer";
import * as NodeChildProcess from "node:child_process";
import * as NodeOs from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import type {
  ExecCommand,
  ExecCommandMessage,
  ExecReport,
} from "@signalbox/runner-protocol/ExecProtocol";
import type { RunnerMessage } from "@signalbox/runner-protocol/RunnerProtocol";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { expect, vi } from "vite-plus/test";

import { makeRunnerExecHost } from "./RunnerExecHost.ts";
import { makeRunnerExecProcessHost } from "./RunnerExecProcessHost.ts";
import type { RunnerExecProcessHost } from "./RunnerExecProcessHost.ts";
import { makeSecretMask } from "./secretMask.ts";
import type { RunnerSessionInput } from "./RunnerSession.ts";
import { maskingTransport } from "./runnerSocket.ts";

type RunnerTransport = RunnerSessionInput["transport"];

const start = (input: {
  readonly processId: string;
  readonly requestId: string;
  readonly executable: string;
  readonly argv: ReadonlyArray<string>;
  readonly cwd?: string;
}): ExecCommandMessage => ({
  type: "exec.command",
  command: {
    type: "start",
    generation: 1,
    processId: input.processId,
    requestId: input.requestId,
    executable: input.executable,
    argv: [...input.argv],
    cwd: input.cwd ?? "/workspace",
    env: {},
  },
});

/** Simulates an OS workspace mount for process tests; it does not prove production realpath behavior. */
const testProcessHost = (fixtureRoot: string): RunnerExecProcessHost => ({
  resolveWorkingDirectory: (cwd) =>
    cwd === "/workspace" ? { _tag: "ready", cwd: fixtureRoot } : { _tag: "invalid_cwd" },
  spawn: (command) =>
    NodeChildProcess.spawn(command.executable, command.argv.slice(1), {
      argv0: command.argv[0],
      cwd: fixtureRoot,
      env: { ...command.env },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }),
});

const threadId = ThreadId.make("thread-1");
const testWorkspace = {
  attestCanonicalCwd: ({
    threadId: candidate,
    cwd,
  }: {
    readonly threadId: ThreadId;
    readonly cwd: string;
  }) => candidate === threadId && cwd === "/workspace",
};

const nextAck = (reports: Queue.Queue<ExecReport>, seen: Ref.Ref<ReadonlyArray<ExecReport>>) =>
  Effect.gen(function* () {
    while (true) {
      const report = yield* Queue.take(reports);
      if (report.type === "ack") return report;
      yield* Ref.update(seen, (all) => [...all, report]);
    }
  });

const nextStdout = (reports: Queue.Queue<ExecReport>, seen: Ref.Ref<ReadonlyArray<ExecReport>>) =>
  Effect.gen(function* () {
    while (true) {
      const report = yield* Queue.take(reports);
      yield* Ref.update(seen, (all) => [...all, report]);
      if (report.type === "output" && report.stream === "stdout") {
        return Buffer.from(report.dataBase64, "base64").toString();
      }
    }
  });

const nextClosed = (reports: Queue.Queue<ExecReport>, seen: Ref.Ref<ReadonlyArray<ExecReport>>) =>
  Effect.gen(function* () {
    const reportsSeen = [...(yield* Ref.get(seen))];
    if (reportsSeen.some((report) => report.type === "closed")) return reportsSeen;
    while (true) {
      const report = yield* Queue.take(reports);
      reportsSeen.push(report);
      if (report.type === "closed") {
        yield* Ref.set(seen, reportsSeen);
        return reportsSeen;
      }
    }
  });

it.effect("runs byte-exact non-PTY processes and deduplicates applied stdin writes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "runner-exec-" });
    const host = yield* makeRunnerExecHost({
      threadId,
      generation: 1,
      workspace: testWorkspace,
      processHost: testProcessHost(cwd),
    });
    const reports = yield* Queue.unbounded<ExecReport>();
    const seen = yield* Ref.make<ReadonlyArray<ExecReport>>([]);
    yield* Stream.runForEach(host.reports, (report) => Queue.offer(reports, report)).pipe(
      Effect.forkScoped,
    );

    const input = Uint8Array.from([0, 255, 128, 65]);
    const script = [
      "const chunks = []",
      "process.stdin.on('data', chunk => chunks.push(chunk))",
      "process.stdin.resume()",
      "const keepAlive = setInterval(() => {}, 1000)",
      "process.stdin.on('end', () => {",
      "process.stdout.write(Buffer.concat([Buffer.from('prefix:'), Buffer.concat(chunks)]))",
      "process.stderr.write(Buffer.from([255, 0, 65]))",
      "clearInterval(keepAlive)",
      "process.exitCode = 7",
      "}); process.stdout.write('ready')",
    ].join(";");
    const executable = process.execPath;
    const startMessage = start({
      processId: "bytes-1",
      requestId: "start-1",
      executable,
      argv: [executable, "-e", script],
    });

    yield* host.handleCommand(startMessage);
    expect(yield* nextAck(reports, seen)).toMatchObject({
      operation: "start",
      requestId: "start-1",
      applied: true,
    });
    expect(yield* nextStdout(reports, seen)).toBe("ready");

    const write: ExecCommand = {
      type: "stdin.write",
      generation: 1,
      processId: "bytes-1",
      writeId: "write-1",
      dataBase64: Buffer.from(input).toString("base64"),
    };
    const writeMessage: ExecCommandMessage = {
      type: "exec.command",
      command: write,
    };
    yield* host.handleCommand(writeMessage);
    expect(yield* nextAck(reports, seen)).toMatchObject({ writeId: "write-1", applied: true });
    yield* host.handleCommand(writeMessage);
    expect(yield* nextAck(reports, seen)).toMatchObject({ writeId: "write-1", applied: true });

    yield* host.handleCommand({
      type: "exec.command",
      command: { ...write, dataBase64: Buffer.from("different").toString("base64") },
    });
    expect(yield* nextAck(reports, seen)).toMatchObject({
      writeId: "write-1",
      applied: false,
      error: { code: "write_id_conflict" },
    });

    yield* host.handleCommand({
      type: "exec.command",
      command: {
        type: "stdin.close",
        generation: 1,
        processId: "bytes-1",
        requestId: "close-1",
      },
    });
    expect(yield* nextAck(reports, seen)).toMatchObject({
      operation: "stdin.close",
      requestId: "close-1",
      applied: true,
    });

    const terminal = yield* nextClosed(reports, seen);
    const output = terminal.filter((report) => report.type === "output");
    const stdout = Buffer.concat(
      output
        .filter((report) => report.type === "output" && report.stream === "stdout")
        .map((report) => Buffer.from(report.dataBase64, "base64")),
    );
    const stderr = Buffer.concat(
      output
        .filter((report) => report.type === "output" && report.stream === "stderr")
        .map((report) => Buffer.from(report.dataBase64, "base64")),
    );
    expect(stdout).toEqual(Buffer.concat([Buffer.from("readyprefix:"), Buffer.from(input)]));
    expect(stderr).toEqual(Buffer.from([255, 0, 65]));
    expect(terminal.find((report) => report.type === "exit")).toMatchObject({ exitCode: 7 });
    expect(terminal.at(-1)).toMatchObject({ type: "closed" });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "passes native numeric signals through and rejects unknown values without SIGTERM fallback",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "runner-exec-signal-" });
      const host = yield* makeRunnerExecHost({
        threadId,
        generation: 1,
        workspace: testWorkspace,
        processHost: testProcessHost(cwd),
      });
      const reports = yield* Queue.unbounded<ExecReport>();
      const seen = yield* Ref.make<ReadonlyArray<ExecReport>>([]);
      yield* Stream.runForEach(host.reports, (report) => Queue.offer(reports, report)).pipe(
        Effect.forkScoped,
      );
      const executable = process.execPath;
      const script =
        "process.on('SIGINT', () => { process.stdout.write('signal-ok'); process.exit(0) }); process.stdout.write('ready'); setInterval(() => {}, 1000)";
      yield* host.handleCommand(
        start({
          processId: "signal-1",
          requestId: "start-signal",
          executable,
          argv: [executable, "-e", script],
        }),
      );
      expect(yield* nextAck(reports, seen)).toMatchObject({ applied: true });
      expect(yield* nextStdout(reports, seen)).toBe("ready");

      yield* host.handleCommand({
        type: "exec.command",
        command: {
          type: "signal",
          generation: 1,
          processId: "signal-1",
          requestId: "signal-unknown",
          signal: 2_147_483_647,
        },
      });
      expect(yield* nextAck(reports, seen)).toMatchObject({
        applied: false,
        error: { code: "invalid_signal" },
      });

      const sigint = NodeOs.constants.signals.SIGINT;
      yield* host.handleCommand({
        type: "exec.command",
        command: {
          type: "signal",
          generation: 1,
          processId: "signal-1",
          requestId: "signal-int",
          signal: sigint,
        },
      });
      expect(yield* nextAck(reports, seen)).toMatchObject({ applied: true });
      const terminal = yield* nextClosed(reports, seen);
      expect(
        Buffer.concat(
          terminal.flatMap((report) =>
            report.type === "output" && report.stream === "stdout"
              ? [Buffer.from(report.dataBase64, "base64")]
              : [],
          ),
        ).toString(),
      ).toBe("readysignal-ok");
      expect(terminal.find((report) => report.type === "exit")).toMatchObject({ exitCode: 0 });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refuses native execution when the canonical workspace mount is missing", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "runner-exec-unavailable-" });
    const spawn = vi.fn() as unknown as typeof NodeChildProcess.spawn;
    const processHost = makeRunnerExecProcessHost({
      realpath: (path) => {
        if (path === "/workspace") throw new Error("mount is absent");
        return cwd;
      },
      isDirectory: () => true,
      spawn,
    });
    const host = yield* makeRunnerExecHost({
      threadId,
      generation: 1,
      workspace: testWorkspace,
      processHost,
    });
    const reports = yield* Queue.unbounded<ExecReport>();
    const seen = yield* Ref.make<ReadonlyArray<ExecReport>>([]);
    yield* Stream.runForEach(host.reports, (report) => Queue.offer(reports, report)).pipe(
      Effect.forkScoped,
    );

    yield* host.handleCommand(
      start({
        processId: "missing-workspace",
        requestId: "start-missing-workspace",
        executable: process.execPath,
        argv: [process.execPath, "-e", "process.exit(0)"],
      }),
    );
    expect(yield* nextAck(reports, seen)).toMatchObject({
      applied: false,
      error: { code: "workspace_not_ready", message: expect.not.stringContaining(cwd) },
    });
    expect(spawn).not.toHaveBeenCalled();
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps execution unavailable when no per-thread workspace attestation is supplied", () =>
  Effect.gen(function* () {
    const resolveWorkingDirectory = vi.fn(() => ({ _tag: "ready", cwd: "/workspace" }) as const);
    const spawn = vi.fn() as unknown as RunnerExecProcessHost["spawn"];
    const processHost: RunnerExecProcessHost = { resolveWorkingDirectory, spawn };
    const host = yield* makeRunnerExecHost({ threadId, generation: 1, processHost });
    const reports = yield* Queue.unbounded<ExecReport>();
    const seen = yield* Ref.make<ReadonlyArray<ExecReport>>([]);
    yield* Stream.runForEach(host.reports, (report) => Queue.offer(reports, report)).pipe(
      Effect.forkScoped,
    );

    yield* host.handleCommand(
      start({
        processId: "unattested-workspace",
        requestId: "start-unattested-workspace",
        executable: process.execPath,
        argv: [process.execPath, "-e", "process.exit(0)"],
      }),
    );
    expect(yield* nextAck(reports, seen)).toMatchObject({
      applied: false,
      error: { code: "workspace_not_ready" },
    });
    expect(resolveWorkingDirectory).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not scrub opaque exec report bytes", () =>
  Effect.gen(function* () {
    const secret = "opaque-secret-bytes";
    const mask = makeSecretMask();
    mask.add([{ name: "API_KEY", value: secret }]);
    const sent: Array<RunnerMessage> = [];
    const wire: RunnerTransport = {
      connect: Effect.succeed({
        send: (message: RunnerMessage) => Effect.sync(() => void sent.push(message)),
        receive: Effect.never,
        close: Effect.void,
      }),
    };
    const connection = yield* maskingTransport(wire, mask).connect;
    const report: RunnerMessage = {
      type: "exec.report",
      report: {
        type: "output",
        generation: 1,
        processId: "opaque-1",
        sequence: 1,
        stream: "stdout",
        dataBase64: Buffer.from(secret).toString("base64"),
      },
    };

    yield* connection.send(report);
    expect(sent).toEqual([report]);
    const sentReport = sent[0];
    if (sentReport?.type !== "exec.report" || sentReport.report.type !== "output") {
      throw new Error("Expected an opaque exec output report");
    }
    expect(Buffer.from(sentReport.report.dataBase64, "base64").toString()).toBe(secret);
  }),
);
