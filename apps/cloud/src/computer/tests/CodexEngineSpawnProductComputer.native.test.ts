import { describe, expect, it, vi } from "vite-plus/test";
import { kernelOk } from "../../kernel/KernelAbi.ts";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import type { AgentOsSpawnRequest } from "../../kernel/AgentOsProcessWire.ts";
import { openExecConnection } from "./CodexExecConnectionFixture.ts";
import {
  CODEX_UNIFIED_EXEC_ENV,
  createCodexLocaleProductComputer,
  loadCodexLocalePrograms,
} from "./CodexLocaleProductComputerFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));
const programs = loadCodexLocalePrograms();
const exited = (exitCode = 0) => ({ exitCode, signal: 0, coreDumped: false });

describe.skipIf(programs === undefined)("Codex engine POSIX spawn", () => {
  it("forwards grep without inheriting the live engine connection", async () => {
    if (programs === undefined) throw new Error("Pinned programs are unavailable");
    const receipt = vi.fn(async () => ({
      stdin: new WritableStream<Uint8Array>(),
      stdout: new ReadableStream<Uint8Array>({ start: (stream) => stream.close() }),
      stderr: new ReadableStream<Uint8Array>({ start: (stream) => stream.close() }),
      exited: Promise.resolve(exited(23)),
      signal: async () => kernelOk(undefined),
      dispose: async () => {},
    }));
    const fixture = createCodexLocaleProductComputer(programs, { machine: { spawn: receipt } });
    const parentDone = Promise.withResolvers<ReturnType<typeof exited>>();
    const parent = fixture.computer.processes.spawn(
      undefined,
      () => ({ completion: parentDone.promise, signal: () => kernelOk(undefined) }),
      () => {},
    );
    if (parent.status !== "ok") throw new Error("Could not create engine process");
    const connection = await openExecConnection(fixture);
    try {
      const actions: AgentOsSpawnRequest["actions"] = [0, 1, 2].map((fd) => ({
        kind: "dup2",
        fd,
        sourceFd: fixture.filesystem.open(
          "/dev/null",
          (fd === 0 ? KernelOpenFlags.O_RDONLY : KernelOpenFlags.O_WRONLY) |
            KernelOpenFlags.O_CLOEXEC,
        ),
        flags: 0,
        mode: 0,
      }));
      const fd = fixture.filesystem.open(
        "/workspace/route.txt",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY,
      );
      fixture.filesystem.write(fd, new TextEncoder().encode("ROUTE_ONLY_1070\n"), null);
      fixture.filesystem.close(fd);
      const command = {
        executable: "/bin/grep",
        argv: ["grep", "-P", "^ROUTE_ONLY_1070$", "route.txt"],
        cwd: "/workspace",
        env: CODEX_UNIFIED_EXEC_ENV,
      };
      const spawned = await fixture.computer.host.spawn(
        {
          filesystem: fixture.filesystem,
          parent: parent.value.handle,
          signal: new AbortController().signal,
        },
        {
          execPath: command.executable,
          argv: command.argv,
          cwd: command.cwd,
          env: command.env,
          actions,
          pidPointer: 0,
          attributes: {
            flags: 0,
            defaultMask: { low: 0, high: 0 },
            signalMask: { low: 0, high: 0 },
            processGroup: 0,
          },
        },
      );
      if (spawned.status !== "ok") throw new Error("Engine spawn failed", { cause: spawned });
      await expect(fixture.computer.host.exitStatus(spawned.value)).resolves.toEqual(
        kernelOk(exited(23)),
      );
      expect(fixture.computer.host.reap(spawned.value).status).toBe("ok");
      expect(fixture.machineCalls).toEqual([command]);
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
