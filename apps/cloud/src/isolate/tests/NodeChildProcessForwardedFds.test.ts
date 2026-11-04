import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  ExecCommandMessage,
  ExecReport,
  type ExecCommand,
} from "@signalbox/runner-protocol/ExecProtocol";

import { makeThreadExecForwarder } from "../../thread/ThreadExecForwarder.ts";
import { inheritedFdsFixture } from "./NodeChildProcessInheritedFds.fixture.ts";

const decodeCommand = Schema.decodeUnknownSync(ExecCommandMessage);
const decodeReport = Schema.decodeUnknownSync(ExecReport);

it("forwards isolate inherited files through Computer and the exec protocol", async () => {
  const socket = {} as WebSocket;
  const starts: Array<Extract<ExecCommand, { readonly type: "start" }>> = [];
  const forwarder = makeThreadExecForwarder({
    lease: { acquire: async () => ({ generation: 1, connection: 1, release: async () => {} }) },
    workspace: { canonicalPath: async (command) => command.cwd },
    policy: { authorize: async () => {} },
  });
  const report = (frame: typeof ExecReport.Type) =>
    forwarder.report(socket, 1, 1, decodeReport(JSON.parse(JSON.stringify(frame))));
  forwarder.connected(socket, {
    generation: 1,
    connection: 1,
    protocolVersion: 8,
    inheritedFds: true,
    exec: true,
    send(message) {
      if (message.type !== "exec.command") return;
      const { command } = decodeCommand(JSON.parse(JSON.stringify(message)));
      if (command.type === "start") starts.push(command);
      report({
        type: "ack",
        generation: 1,
        processId: command.processId,
        operation: command.type,
        ...("writeId" in command ? { writeId: command.writeId } : { requestId: command.requestId }),
        applied: true,
      });
      if (command.type !== "stdin.close") return;
      report({
        type: "output",
        generation: 1,
        processId: command.processId,
        sequence: 1,
        stream: "stdout",
        dataBase64: "c2luZ2xlLWZpbGUgZ3JlcAo=",
      });
      report({
        type: "exit",
        generation: 1,
        processId: command.processId,
        sequence: 2,
        exitCode: 0,
      });
      report({ type: "closed", generation: 1, processId: command.processId, sequence: 3 });
    },
  });
  const h = inheritedFdsFixture("computer", forwarder, "/workspace");
  try {
    const path = "/workspace/target.txt";
    h.fs.writeFileSync(path, "single-file grep\n");
    const fd = h.fs.openSync(path, "r");
    const child = h.childProcess.spawn("/usr/bin/read-fd", ["3"], {
      stdio: ["pipe", "pipe", "pipe", fd],
      cwd: "/workspace",
    });
    h.fs.closeSync(fd);
    const chunks: Uint8Array[] = [];
    child.stdout?.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    const closed = new Promise<void>((resolve, reject) => {
      child.once("close", () => resolve());
      child.once("error", reject);
    });
    child.stdin?.end();
    await closed;
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      executable: "/usr/bin/read-fd",
      argv: ["/usr/bin/read-fd", "3"],
      cwd: "/workspace",
      inheritedFds: [{ childFd: 3, path, flags: 0, offset: 0 }],
    });
    expect(child.exitCode).toBe(0);
    expect(Buffer.concat(chunks).toString()).toBe("single-file grep\n");
  } finally {
    await h.close();
    await forwarder.dispose();
  }
});
