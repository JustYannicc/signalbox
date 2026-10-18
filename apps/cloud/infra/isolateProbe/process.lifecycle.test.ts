// @effect-diagnostics nodeBuiltinImport:off - observe owned native process groups through explicit IPC milestones.
import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { runProcess } from "./process.ts";
import { runProbe } from "./run.ts";

const source = String.raw`
const net = require('node:net');
const childProcess = require('node:child_process');
const socket = net.connect(process.env.PROBE_TEST_SOCKET);
if (process.env.PROBE_TEST_DESCENDANT === '1') {
  process.on('SIGTERM', () => socket.write('ignored-term\n'));
  socket.on('connect', () => socket.write('descendant:' + process.pid + '\n'));
} else {
  process.on('SIGTERM', () => process.exit(0));
  socket.on('connect', () => {
    socket.write('parent:' + process.pid + '\n');
    const descendant = childProcess.spawn(process.execPath, ['-e', process.env.PROBE_TEST_SOURCE], {
      env: {...process.env, PROBE_TEST_DESCENDANT: '1'},
      stdio: 'ignore',
    });
    descendant.unref();
  });
}
`;

describe("owned probe process group shutdown", () => {
  it("waits for escalation after the direct child closes, then cleans up with the descendant dead", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "probe-group-"));
    const path = NodePath.join(dir, "ipc");
    const parentReady = Promise.withResolvers<number>();
    const descendantReady = Promise.withResolvers<number>();
    const parentClosed = Promise.withResolvers<void>();
    const descendantClosed = Promise.withResolvers<void>();
    const ignoredTerm = Promise.withResolvers<void>();
    const sockets = new Set<NodeNet.Socket>();
    const server = NodeNet.createServer((socket) => {
      sockets.add(socket);
      let role = "";
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        while (buffer.includes("\n")) {
          const index = buffer.indexOf("\n");
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (line.startsWith("parent:")) {
            role = "parent";
            parentReady.resolve(Number(line.slice("parent:".length)));
          } else if (line.startsWith("descendant:")) {
            role = "descendant";
            descendantReady.resolve(Number(line.slice("descendant:".length)));
          } else if (line === "ignored-term") ignoredTerm.resolve();
        }
      });
      socket.on("close", () => {
        sockets.delete(socket);
        if (role === "parent") parentClosed.resolve();
        else if (role === "descendant") descendantClosed.resolve();
      });
    });
    const controller = new AbortController();
    let parentPid: number | undefined;
    let descendantPid: number | undefined;
    let run: Promise<unknown> | undefined;
    let settled = false;
    let cleanupStarted = false;
    const logs: string[] = [];
    let descendantStateAtCleanup = "";
    let descendantStatusAtCleanup: number | null | undefined;
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
        throw error;
      }
    };
    try {
      await new Promise<void>((resolve) => server.listen(path, resolve));
      run = runProbe(
        {},
        {
          log: (line) => logs.push(line),
          run: async (input) => {
            if (input.args[0] === "destroy") {
              cleanupStarted = true;
              expect(parentPid).toBeDefined();
              expect(descendantPid).toBeDefined();
              const state = NodeChildProcess.spawnSync(
                "ps",
                ["-o", "stat=", "-p", String(descendantPid)],
                { encoding: "utf8" },
              );
              descendantStatusAtCleanup = state.status;
              descendantStateAtCleanup = state.stdout.trim();
              return { code: 0, stdout: "", stderr: "" };
            }
            return runProcess({
              ...input,
              command: process.execPath,
              args: ["-e", source],
              env: { ...input.env, PROBE_TEST_SOCKET: path, PROBE_TEST_SOURCE: source },
              signal: controller.signal,
              timeoutMs: 15_000,
            });
          },
        },
      ).then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      [parentPid, descendantPid] = await Promise.all([
        parentReady.promise,
        descendantReady.promise,
      ]);
      controller.abort();
      await Promise.all([parentClosed.promise, ignoredTerm.promise]);
      expect(alive(descendantPid)).toBe(true);
      expect(settled).toBe(false);
      expect(cleanupStarted).toBe(false);
      const error = await run;
      expect(error).toBeInstanceOf(Error);
      expect(error instanceof Error && error.message).toContain("interrupted");
      expect(cleanupStarted).toBe(true);
      expect([0, 1]).toContain(descendantStatusAtCleanup);
      // Signal 0 can still find a dead orphan while init is reaping its zombie.
      expect(descendantStateAtCleanup, logs.join("\n")).toMatch(/^(?:Z\S*)?$/);
      await descendantClosed.promise;
    } finally {
      controller.abort();
      // Only PIDs reported by these spawned processes are ours, including on a failing regression.
      for (const pid of [descendantPid, parentPid]) {
        if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
      }
      await run;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
});
