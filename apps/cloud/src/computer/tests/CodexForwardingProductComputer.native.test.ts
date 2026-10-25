import { describe, expect, it, vi } from "vite-plus/test";
import { kernelOk } from "../../kernel/KernelAbi.ts";
import type { KernelCommandChild } from "../../kernel/KernelCommandForwarder.ts";
import { createNodeComputerChildProcess } from "../../isolate/NodeComputerProcess.ts";
import type { NodeChildProcess } from "../../isolate/NodeChildProcess.ts";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import { openExecConnection } from "./CodexExecConnectionFixture.ts";
import {
  CODEX_UNIFIED_EXEC_ENV,
  createCodexLocaleProductComputer,
  loadCodexLocalePrograms,
} from "./CodexLocaleProductComputerFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const programs = loadCodexLocalePrograms();
const exited = (exitCode = 0) => ({ exitCode, signal: 0, coreDumped: false });

async function observeNode(child: NodeChildProcess) {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (bytes: Uint8Array) => (stdout += new TextDecoder().decode(bytes)));
  child.stderr?.on("data", (bytes: Uint8Array) => (stderr += new TextDecoder().decode(bytes)));
  const status = await new Promise<{ code: number | null; signal: string | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  return { status, stdout, stderr };
}

async function observeComputer(child: KernelCommandChild) {
  try {
    const writer = child.stdin.getWriter();
    await writer.close();
    writer.releaseLock();
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { status: { code: status.exitCode, signal: null }, stdout, stderr };
  } finally {
    await child.dispose();
  }
}

describe.skipIf(programs === undefined)("residual machine descriptor guards", () => {
  it.each([
    { command: "exec 9<proof.txt; grep -P BEFORE proof.txt", label: "surviving inherited fd" },
    { command: "grep -P BEFORE proof.txt 1>&-", label: "closed stdout" },
    { command: "exec 0<&-; grep -P BEFORE proof.txt", label: "closed stdin" },
  ])("retains the unsupported-state guard for $label", async ({ command }) => {
    if (programs === undefined) throw new Error("Pinned programs are unavailable");
    const fixture = createCodexLocaleProductComputer(programs);
    try {
      const result = await observeComputer(
        await fixture.computer.exec(
          {
            executable: "/bin/bash",
            argv: ["/bin/bash", "--noprofile", "--norc", "-c", command],
            cwd: "/workspace",
            env: CODEX_UNIFIED_EXEC_ENV,
          },
          new AbortController().signal,
          undefined,
        ),
      );
      expect(result.status).toEqual({ code: 126, signal: null });
      expect(result.stderr).toContain("/bin/grep: Not supported");
      expect(fixture.machineCalls).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});

describe.skipIf(programs === undefined)(
  "Codex remote exec process state at machine admission",
  () => {
    describe.each(["node", "computer"])("%s command", (api) => {
      it.each([
        {
          command: "grep -P '^ROUTE_ONLY_1070$' route.txt",
          executable: "/bin/grep",
          argv: ["grep", "-P", "^ROUTE_ONLY_1070$", "route.txt"],
        },
        {
          command: "sed --sandbox 's/BEFORE/AFTER/' proof.txt",
          executable: "/bin/sed",
          argv: ["sed", "--sandbox", "s/BEFORE/AFTER/", "proof.txt"],
        },
        {
          command: "/usr/bin/git fetch origin",
          executable: "/usr/bin/git",
          argv: ["/usr/bin/git", "fetch", "origin"],
        },
      ])("forwards $command without inheriting the engine's connection", async (testCase) => {
        if (programs === undefined) throw new Error("Pinned programs are unavailable");
        const receipt = vi.fn(async () => ({
          stdin: new WritableStream<Uint8Array>(),
          stdout: new ReadableStream<Uint8Array>({
            start(stream) {
              stream.enqueue(new TextEncoder().encode("MACHINE_ROUTE_STDOUT_1070\n"));
              stream.close();
            },
          }),
          stderr: new ReadableStream<Uint8Array>({
            start(stream) {
              stream.enqueue(new TextEncoder().encode("MACHINE_ROUTE_STDERR_1070\n"));
              stream.close();
            },
          }),
          exited: Promise.resolve(exited(23)),
          signal: async () => kernelOk(undefined),
          dispose: async () => {},
        }));
        const fixture = createCodexLocaleProductComputer(programs, {
          machine: { spawn: receipt },
          orderedMachineRules: [
            { id: "fetch-on-machine", executable: "/usr/bin/git", argvPrefix: ["fetch"] },
          ],
        });
        const parentDone = Promise.withResolvers<ReturnType<typeof exited>>();
        const parent = fixture.computer.processes.spawn(
          undefined,
          () => ({ completion: parentDone.promise, signal: () => kernelOk(undefined) }),
          () => {},
        );
        if (parent.status !== "ok") throw new Error("Could not create command caller");
        const connection = await openExecConnection(fixture);
        try {
          const fd = fixture.filesystem.open(
            "/workspace/route.txt",
            KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY,
          );
          fixture.filesystem.write(fd, new TextEncoder().encode("ROUTE_ONLY_1070\n"), null);
          fixture.filesystem.close(fd);
          const args = ["--noprofile", "--norc", "-c", testCase.command];
          const signal = new AbortController().signal;
          let observation;
          if (api === "node") {
            const node = createNodeComputerChildProcess(
              fixture.computer.host,
              {
                filesystem: fixture.filesystem,
                parent: parent.value.handle,
                env: CODEX_UNIFIED_EXEC_ENV,
                signal,
              },
              fixture.computer,
            );
            observation = await observeNode(
              node.spawn("/bin/bash", args, {
                env: CODEX_UNIFIED_EXEC_ENV,
                stdio: ["ignore", "pipe", "pipe"],
              }),
            );
          } else {
            observation = await observeComputer(
              await fixture.computer.exec(
                {
                  executable: "/bin/bash",
                  argv: ["/bin/bash", ...args],
                  cwd: "/workspace",
                  env: CODEX_UNIFIED_EXEC_ENV,
                },
                signal,
                undefined,
              ),
            );
          }
          expect({ ...observation, receipts: fixture.machineCalls }).toEqual({
            status: { code: 23, signal: null },
            stdout: "MACHINE_ROUTE_STDOUT_1070\n",
            stderr: "MACHINE_ROUTE_STDERR_1070\n",
            receipts: [
              {
                executable: testCase.executable,
                argv: testCase.argv,
                cwd: "/workspace",
                env: {
                  ...CODEX_UNIFIED_EXEC_ENV,
                  PWD: "/workspace",
                  SHLVL: "0",
                  _: testCase.executable,
                },
              },
            ],
          });
          expect(receipt).toHaveBeenCalledOnce();
          expect(fixture.filesystem.descriptors.has(connection.fd)).toBe(true);
          expect(connection.signal.aborted).toBe(false);
        } finally {
          connection.close();
          parentDone.resolve(exited());
          await fixture.close();
        }
      });
    });
  },
);
