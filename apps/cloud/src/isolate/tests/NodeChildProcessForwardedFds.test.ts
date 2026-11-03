// @effect-diagnostics nodeBuiltinImport:off - this integration owns its native workspace and Runner children.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ThreadId } from "@t3tools/contracts";
import { ExecCommandMessage, ExecReport } from "@signalbox/runner-protocol/ExecProtocol";

import { makeRunnerExecHost } from "../../../../server/src/signalbox/runner/RunnerExecHost.ts";
import { makeRunnerExecProcessHost } from "../../../../server/src/signalbox/runner/RunnerExecProcessHost.ts";
import { makeThreadExecForwarder } from "../../thread/exec/ThreadExecForwarder.ts";
import { driveFileSystem } from "../../../../server/src/signalbox/runner/RunnerInheritedFds.fixture.ts";
import { inheritedFdsFixture } from "./NodeChildProcessInheritedFds.fixture.ts";

const decodeCommand = Schema.decodeUnknownSync(ExecCommandMessage);
const decodeReport = Schema.decodeUnknownSync(ExecReport);

it.effect("reads an isolate file at fd 3 through Computer, the exec wire and native Runner", () =>
  Effect.gen(function* () {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "forwarded-fd-"));
    const native = makeRunnerExecProcessHost({ inheritedFiles: driveFileSystem(root) });
    const runner = yield* makeRunnerExecHost({
      threadId: ThreadId.make("inherited-fd-test"),
      generation: 1,
      workspace: { attestCanonicalCwd: () => true },
      processHost: {
        resolveWorkingDirectory: (cwd) =>
          cwd === "/workspace" ? { _tag: "ready", cwd: root } : { _tag: "invalid_cwd" },
        spawn: native.spawn,
      },
    });
    const socket = {} as WebSocket;
    const commands = yield* Queue.unbounded<typeof ExecCommandMessage.Type>();
    yield* Stream.runForEach(Stream.fromQueue(commands), runner.handleCommand).pipe(
      Effect.forkScoped,
    );
    const forwarder = makeThreadExecForwarder({
      lease: { acquire: async () => ({ generation: 1, connection: 1, release: async () => {} }) },
      workspace: { canonicalCwd: async (command) => command.cwd },
      policy: { authorize: async () => {} },
    });
    forwarder.connected(socket, {
      generation: 1,
      connection: 1,
      protocolVersion: 8,
      inheritedFds: true,
      exec: true,
      send(message) {
        if (message.type !== "exec.command") return;
        Queue.offerUnsafe(commands, decodeCommand(JSON.parse(JSON.stringify(message))));
      },
    });
    yield* Stream.runForEach(runner.reports, (report) =>
      Effect.sync(() =>
        forwarder.report(socket, 1, 1, decodeReport(JSON.parse(JSON.stringify(report)))),
      ),
    ).pipe(Effect.forkScoped);
    const h = inheritedFdsFixture("computer", forwarder, "/workspace");
    try {
      const path = "/workspace/target.txt";
      h.fs.writeFileSync(path, "single-file grep\n");
      // The Runner's Drive view has a different native path from the isolate.
      NodeFS.writeFileSync(NodePath.join(root, "target.txt"), h.fs.readFileSync(path));
      const fd = h.fs.openSync(path, "r");
      const child = h.childProcess.spawn(
        process.execPath,
        ["-e", "process.stdout.write(require('node:fs').readFileSync(3))"],
        {
          stdio: ["pipe", "pipe", "pipe", fd],
          cwd: "/workspace",
        },
      );
      h.fs.closeSync(fd);
      const chunks: Uint8Array[] = [];
      child.stdout?.on("data", (chunk: Uint8Array) => chunks.push(chunk));
      const closed = new Promise<void>((resolve, reject) => {
        child.once("close", () => resolve());
        child.once("error", reject);
      });
      child.stdin?.end();
      yield* Effect.promise(() => closed);
      expect(child.exitCode).toBe(0);
      expect(Buffer.concat(chunks).toString()).toBe("single-file grep\n");
    } finally {
      yield* Effect.promise(async () => {
        await h.close();
        await forwarder.dispose();
        NodeFS.rmSync(root, { recursive: true, force: true });
      });
    }
  }),
);
