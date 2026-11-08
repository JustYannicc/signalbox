import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ABI_VERSION, KernelProgramRegistry, KernelWakeRegistry } from "../../kernel/KernelAbi.ts";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import type { KernelCommand, KernelCommandChild } from "../../kernel/KernelCommandForwarder.ts";
import {
  KernelProgramHost,
  type KernelProgramAdmissionRequest,
} from "../../kernel/KernelProgramHost.ts";
import { createComputerCommands } from "../ComputerCommands.ts";
import { ComputerEscalationTable } from "../EscalationTable.ts";
import { createTestFilesystem } from "./helpers/filesystem.ts";

const fixtures: ReturnType<typeof harness>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

function harness(mode: "legacy" | "admitted", capture?: (command: KernelCommand) => Promise<void>) {
  const fixture = createTestFilesystem();
  const filesystem = fixture.filesystem;
  const wakes = new KernelWakeRegistry();
  const registry = new KernelProgramRegistry();
  const manifest = {
    name: "cwd-probe",
    version: "1",
    abiVersion: ABI_VERSION,
    entrypoint: "cwd-probe",
    requiredCapabilities: [],
  };
  registry.register(manifest);
  const observed = vi.fn(async (command: KernelCommand) => capture?.(command));
  const run = vi.fn(({ filesystem }: { filesystem: typeof fixture.filesystem }) => {
    filesystem.write(1, new TextEncoder().encode(filesystem.cwd), null);
    return 0;
  });
  const host = new KernelProgramHost({
    registry,
    wakes,
    programs: new Map([
      ["/bin/probe", { manifest, implementation: { kind: "javascript", runInline: run } }],
    ]),
    ...(mode === "admitted"
      ? {
          admit: async (request: KernelProgramAdmissionRequest) => {
            await observed(request.command);
            return { kind: "local" as const };
          },
        }
      : {}),
  });
  const machine = {
    spawn: vi.fn(async (): Promise<never> => {
      throw new Error("Unexpected machine execution");
    }),
  };
  const kernel = { host, filesystem };
  const commands = createComputerCommands(
    mode === "admitted"
      ? { mode, kernel, isolateKernel: kernel }
      : {
          kernel,
          escalation: new ComputerEscalationTable(),
          machine,
          evidence: async (command) => {
            await observed(command);
            return {};
          },
        },
  );
  filesystem.mkdir("/work");
  filesystem.mkdir("/other");
  filesystem.symlink("/work", "/alias");
  filesystem.symlink("/missing", "/broken");
  filesystem.close(filesystem.open("/file", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY));
  return {
    filesystem,
    commands,
    observed,
    run,
    machine,
    async close() {
      await host.processes.dispose();
      fixture.close();
      wakes.dispose();
    },
  };
}

const command = (cwd: string) => ({ executable: "/bin/probe", argv: ["probe"], cwd, env: {} });
const signal = () => new AbortController().signal;

async function childCwd(child: KernelCommandChild) {
  try {
    const [cwd, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(exit.exitCode).toBe(0);
    return cwd;
  } finally {
    await child.dispose();
  }
}

describe.each(["legacy", "admitted"] as const)("%s command cwd", (mode) => {
  describe.each(["exec", "isolate"] as const)("%s", (entry) => {
    const execute = (fixture: ReturnType<typeof harness>, input: KernelCommand) =>
      entry === "exec"
        ? fixture.commands.exec(input, signal(), undefined)
        : fixture.commands.isolate.exec(input, signal(), undefined);

    it.each([
      ["/alias", "/work"],
      ["/work", "/work"],
      ["/work/..", "/"],
    ])(`${entry} resolves %s to child cwd %s`, async (cwd, canonical) => {
      const fixture = harness(mode);
      fixtures.push(fixture);
      const input = command(cwd);
      expect(await childCwd(await execute(fixture, input))).toBe(canonical);
      expect(input.cwd).toBe(cwd);
      for (const [captured] of fixture.observed.mock.calls) {
        expect(captured.cwd).toBe(canonical);
        expect(Object.isFrozen(captured)).toBe(true);
      }
    });

    it.each([
      ["/missing", "ENOENT"],
      ["/file", "ENOTDIR"],
      ["/broken", "ENOENT"],
    ])(`${entry} rejects %s with %s before admission or spawn`, async (cwd, code) => {
      const fixture = harness(mode);
      fixtures.push(fixture);
      await expect(
        Promise.resolve().then(() => execute(fixture, command(cwd))),
      ).rejects.toMatchObject({ code });
      expect(fixture.observed).not.toHaveBeenCalled();
      expect(fixture.run).not.toHaveBeenCalled();
      expect(fixture.machine.spawn).not.toHaveBeenCalled();
    });
  });

  it("keeps the resolved snapshot when the input and alias change during admission", async () => {
    const captured = Promise.withResolvers<KernelCommand>();
    const resume = Promise.withResolvers<void>();
    const fixture = harness(mode, async (command) => {
      captured.resolve(command);
      await resume.promise;
    });
    fixtures.push(fixture);
    const realpath = vi.spyOn(fixture.filesystem, "realpath");
    const input = command("/alias");
    const pending = fixture.commands.exec(input, signal(), undefined);
    const admitted = await captured.promise;
    expect(admitted.cwd).toBe("/work");
    expect(Object.isFrozen(admitted)).toBe(true);
    input.cwd = "/other";
    fixture.filesystem.unlink("/alias");
    fixture.filesystem.symlink("/other", "/alias");
    resume.resolve();
    expect(await childCwd(await pending)).toBe("/work");
    expect(realpath.mock.calls.filter(([path]) => path === "/alias")).toHaveLength(1);
  });
});
