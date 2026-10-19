import { it } from "@effect/vitest";
import type {
  RunnerBuild,
  RunnerMessage,
  ThreadMessage,
} from "@signalbox/runner-protocol/RunnerProtocol";
import { ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import { expect } from "vite-plus/test";

import type { RunnerExecWorkspaceAttestation } from "./RunnerExecHost.ts";
import type { RunnerTransport } from "./RunnerSession.ts";
import { RunnerConnectionError } from "./RunnerConnectionError.ts";
import { runRunnerCommandSession } from "./RunnerCommandSession.ts";

const threadId = ThreadId.make("command-thread");
const build: RunnerBuild = { imageDigest: null, revision: "test-revision", cliVersions: {} };
const workspace: RunnerExecWorkspaceAttestation = {
  attestCanonicalCwd: ({ threadId: candidate, cwd }) =>
    candidate === threadId && cwd === "/workspace",
};

const makeThread = Effect.gen(function* () {
  const sent = yield* Queue.unbounded<RunnerMessage>();
  const incoming = yield* Queue.unbounded<ThreadMessage, RunnerConnectionError>();
  const closed = yield* Ref.make(false);
  const connectCount = yield* Ref.make(0);
  const transport: RunnerTransport = {
    connect: Effect.gen(function* () {
      yield* Ref.update(connectCount, (count) => count + 1);
      yield* Effect.addFinalizer(() => Ref.set(closed, true));
      return {
        send: (message) => Effect.asVoid(Queue.offer(sent, message)),
        receive: Queue.take(incoming),
        close: Ref.set(closed, true).pipe(Effect.asVoid),
      };
    }),
  };
  return { sent, incoming, closed, connectCount, transport };
});

const sessionInput = (transport: RunnerTransport) => ({
  threadId,
  generation: 7,
  token: "session-token",
  machineId: "machine-1",
  imageVersion: "runner-test",
  build,
  transport,
  workspace,
});

const welcome: ThreadMessage = {
  type: "welcome",
  generation: 7,
  ackedSequence: 0,
  activeRunId: null,
};

it.effect("opens an exec-only session and preserves command receipts until end", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeThread;
      const fiber = yield* runRunnerCommandSession(sessionInput(thread.transport)).pipe(
        Effect.forkScoped,
      );

      expect(yield* Queue.take(thread.sent)).toEqual({
        type: "hello",
        protocolVersion: 8,
        imageVersion: "runner-test",
        machineId: "machine-1",
        threadId,
        generation: 7,
        token: "session-token",
        lastAckedSequence: 0,
        build,
        exec: true,
      });

      yield* Queue.offer(thread.incoming, welcome);
      const command = {
        type: "exec.command",
        command: {
          type: "signal",
          generation: 7,
          processId: "missing-process",
          requestId: "signal-request",
          signal: 2,
        },
      } satisfies Extract<ThreadMessage, { readonly type: "exec.command" }>;
      yield* Queue.offer(thread.incoming, command);
      const firstReport = yield* Queue.take(thread.sent);
      expect(firstReport).toMatchObject({
        type: "exec.report",
        report: {
          type: "ack",
          generation: 7,
          processId: "missing-process",
          requestId: "signal-request",
          applied: false,
          error: { code: "process_not_found" },
        },
      });

      yield* Queue.offer(thread.incoming, command);
      expect(yield* Queue.take(thread.sent)).toEqual(firstReport);
      yield* Queue.offer(thread.incoming, {
        ...command,
        command: { ...command.command, signal: 15 },
      });
      expect(yield* Queue.take(thread.sent)).toMatchObject({
        type: "exec.report",
        report: {
          type: "ack",
          requestId: "signal-request",
          applied: false,
          error: { code: "request_id_conflict" },
        },
      });

      yield* Queue.offer(thread.incoming, { type: "end", reason: "released" });
      yield* Fiber.join(fiber);
      expect(yield* Ref.get(thread.closed)).toBe(true);
    }),
  ),
);

it.effect("rejects commands before a compatible welcome", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeThread;
      const fiber = yield* runRunnerCommandSession(sessionInput(thread.transport)).pipe(
        Effect.forkScoped,
      );
      const hello = yield* Queue.take(thread.sent);
      expect(hello.type).toBe("hello");

      yield* Queue.offer(thread.incoming, {
        ...welcome,
        generation: 8,
      });
      const error = yield* Effect.flip(Fiber.join(fiber));
      expect(error.message).toContain("incompatible welcome");
      expect(yield* Queue.take(thread.sent)).toMatchObject({
        type: "end",
        reason: expect.stringContaining("incompatible welcome"),
      });
      expect(yield* Ref.get(thread.closed)).toBe(true);
    }),
  ),
);

it.effect("rejects commands from another generation before the host sees them", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeThread;
      const fiber = yield* runRunnerCommandSession(sessionInput(thread.transport)).pipe(
        Effect.forkScoped,
      );
      yield* Queue.take(thread.sent);
      yield* Queue.offer(thread.incoming, welcome);
      yield* Queue.offer(thread.incoming, {
        type: "exec.command",
        command: {
          type: "signal",
          generation: 8,
          processId: "missing-process",
          requestId: "stale-request",
          signal: 2,
        },
      });

      const error = yield* Effect.flip(Fiber.join(fiber));
      expect(error.message).toContain("stale generation command");
      expect(yield* Queue.take(thread.sent)).toMatchObject({
        type: "end",
        reason: expect.stringContaining("stale generation command"),
      });
      expect(yield* Ref.get(thread.closed)).toBe(true);
    }),
  ),
);

it.effect("rejects terminal commands instead of opening a PTY", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeThread;
      const fiber = yield* runRunnerCommandSession(sessionInput(thread.transport)).pipe(
        Effect.forkScoped,
      );
      yield* Queue.take(thread.sent);
      yield* Queue.offer(thread.incoming, welcome);
      yield* Queue.offer(thread.incoming, {
        type: "terminal.command",
        requestId: "terminal-request",
        command: {
          type: "close",
          threadId,
          terminalId: "terminal-1",
          generation: 1,
          leaseGeneration: 7,
        },
      });

      const error = yield* Effect.flip(Fiber.join(fiber));
      expect(error.message).toContain("unsupported message");
      expect(yield* Queue.take(thread.sent)).toMatchObject({
        type: "end",
        reason: expect.stringContaining("unsupported message"),
      });
      expect(yield* Ref.get(thread.connectCount)).toBe(1);
      expect(yield* Ref.get(thread.closed)).toBe(true);
    }),
  ),
);

it.effect("ends after a socket drop without reconnecting or replaying commands", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeThread;
      const fiber = yield* runRunnerCommandSession(sessionInput(thread.transport)).pipe(
        Effect.forkScoped,
      );
      yield* Queue.take(thread.sent);
      yield* Queue.offer(thread.incoming, welcome);
      yield* Queue.offer(thread.incoming, {
        type: "exec.command",
        command: {
          type: "signal",
          generation: 7,
          processId: "missing-process",
          requestId: "before-drop",
          signal: 2,
        },
      });
      expect(yield* Queue.take(thread.sent)).toMatchObject({
        type: "exec.report",
        report: { type: "ack", requestId: "before-drop" },
      });
      yield* Queue.fail(thread.incoming, new RunnerConnectionError({ message: "socket dropped" }));

      const error = yield* Effect.flip(Fiber.join(fiber));
      expect(error.message).toBe("socket dropped");
      expect(yield* Ref.get(thread.connectCount)).toBe(1);
      expect(yield* Ref.get(thread.closed)).toBe(true);
    }),
  ),
);

it.effect("ends the session when a serialized exec report cannot be sent", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const helloSent = yield* Deferred.make<void>();
      const incoming = yield* Queue.unbounded<ThreadMessage, RunnerConnectionError>();
      const transport: RunnerTransport = {
        connect: Effect.succeed({
          send: (message) =>
            message.type === "hello"
              ? Deferred.succeed(helloSent, undefined).pipe(Effect.asVoid)
              : Effect.fail(new RunnerConnectionError({ message: "send failed" })),
          receive: Queue.take(incoming),
          close: Effect.void,
        }),
      };
      const fiber = yield* runRunnerCommandSession(sessionInput(transport)).pipe(Effect.forkScoped);
      yield* Deferred.await(helloSent);
      yield* Queue.offer(incoming, welcome);
      yield* Queue.offer(incoming, {
        type: "exec.command",
        command: {
          type: "signal",
          generation: 7,
          processId: "missing-process",
          requestId: "signal-request",
          signal: 2,
        },
      });

      const error = yield* Effect.flip(Fiber.join(fiber));
      expect(error.message).toContain("Failed to send an exec report");
    }),
  ),
);
