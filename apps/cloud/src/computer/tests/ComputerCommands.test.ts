import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ABI_VERSION, KernelProgramRegistry, KernelWakeRegistry } from "../../kernel/KernelAbi.ts";
import type {
  KernelCommand,
  KernelCommandChild,
  KernelCommandForwarder,
} from "../../kernel/KernelCommandForwarder.ts";
import { KernelProgramHost, type KernelInlineProgram } from "../../kernel/KernelProgramHost.ts";
import { ComputerEscalationTable } from "../EscalationTable.ts";
import { COMPUTER_ISOLATE_POLICY } from "../EscalationPolicy.ts";
import { createComputerCommands, type ComputerCommandOptions } from "../ComputerCommands.ts";
import { createTestFilesystem } from "./helpers/filesystem.ts";

const bytes = (...values: number[]) => Uint8Array.from(values);
const probeCommand = (cwd = "/") => ({ executable: "/bin/probe", argv: ["probe"], cwd, env: {} });
const activeContexts: ReturnType<typeof localHost>[] = [];

afterEach(async () => {
  await Promise.all(activeContexts.splice(0).map((context) => context.close()));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function localHost(runInline: KernelInlineProgram) {
  const fixture = createTestFilesystem();
  const wakes = new KernelWakeRegistry();
  const registry = new KernelProgramRegistry();
  const manifest = {
    name: "computer-test-program",
    version: "1",
    abiVersion: ABI_VERSION,
    requiredCapabilities: ["process.wait"] as const,
    entrypoint: "computer-test-program",
  };
  const registered = registry.register(manifest);
  if (registered.status !== "ok") throw new Error("Test program registration failed");
  const host = new KernelProgramHost({
    registry,
    wakes,
    programs: new Map([
      ["/bin/probe", { manifest, implementation: { kind: "javascript", runInline } }],
    ]),
  });
  return {
    filesystem: fixture.filesystem,
    host,
    async close() {
      await host.processes.dispose();
      fixture.close();
      wakes.dispose();
    },
  };
}

function machineForwarder() {
  const child: KernelCommandChild = {
    stdin: new WritableStream<Uint8Array>(),
    stdout: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
    stderr: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
    exited: Promise.resolve({ exitCode: 0, signal: 0, coreDumped: false }),
    signal: async () => ({ status: "ok", value: undefined }),
    dispose: async () => {},
  };
  const spawn = vi.fn(async (_command: KernelCommand, _signal: AbortSignal) => child);
  return { child, machine: { spawn } satisfies KernelCommandForwarder };
}

function computerHarness(
  runInline: KernelInlineProgram,
  options: Partial<Pick<ComputerCommandOptions, "escalation" | "evidence">> = {},
) {
  const context = localHost(runInline);
  activeContexts.push(context);
  const { child, machine } = machineForwarder();
  const commands = createComputerCommands({
    kernel: { host: context.host, filesystem: context.filesystem },
    escalation: options.escalation ?? new ComputerEscalationTable(),
    machine,
    ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
  });
  return { context, commands, child, machine };
}

async function readAll(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
  }
  const output = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

describe("createComputerCommands", () => {
  it("runs the exact canonical command locally and preserves binary output and exit status", async () => {
    const observed: unknown[] = [];
    const stdout = bytes(0, 255, 65);
    const stderr = bytes(128, 0, 254);
    const { context, commands, machine } = computerHarness(({ filesystem, args, env }) => {
      observed.push({ cwd: filesystem.cwd, args, env });
      filesystem.write(1, stdout, null);
      filesystem.write(2, stderr, null);
      return 23;
    });
    context.filesystem.mkdir("/workspace");
    const signal = new AbortController().signal;
    const command = {
      executable: "/bin/probe",
      argv: ["custom-argv0", "--flag", ""],
      cwd: "/workspace",
      env: { EMPTY: "", PATH: "/bin", TOKEN: "exact" },
    };
    const child = await commands.exec(command, signal);
    const [actualStdout, actualStderr, exit] = await Promise.all([
      readAll(child.stdout),
      readAll(child.stderr),
      child.exited,
    ]);
    expect(observed).toEqual([{ cwd: "/workspace", args: command.argv, env: command.env }]);
    expect(actualStdout).toEqual(stdout);
    expect(actualStderr).toEqual(stderr);
    expect(exit).toEqual({ exitCode: 23, signal: 0, coreDumped: false });
    expect(machine.spawn).not.toHaveBeenCalled();
    await child.dispose();
  });

  it("routes an explicit match to the machine exactly once", async () => {
    let localRuns = 0;
    const { commands, child, machine } = computerHarness(
      () => {
        localRuns++;
        return 0;
      },
      {
        escalation: new ComputerEscalationTable([
          { id: "large-probe", executable: "/bin/probe", argvPrefix: ["--large"] },
        ]),
      },
    );
    const command = {
      executable: "/bin/probe",
      argv: ["probe", "--large"],
      cwd: "/",
      env: { EMPTY: "" },
    };
    await expect(commands.exec(command, new AbortController().signal)).resolves.toBe(child);
    expect(machine.spawn).toHaveBeenCalledOnce();
    expect(machine.spawn).toHaveBeenCalledWith(command, expect.any(AbortSignal));
    expect(localRuns).toBe(0);
  });

  it("keeps hook isolate execution local when the escalation table matches", async () => {
    let localRuns = 0;
    const { commands, machine } = computerHarness(
      () => {
        localRuns++;
        return 7;
      },
      {
        escalation: new ComputerEscalationTable([
          { id: "large-probe", executable: "/bin/probe", argvPrefix: ["--large"] },
        ]),
      },
    );
    const child = await commands.isolate.exec(
      { executable: "/bin/probe", argv: ["probe", "--large"], cwd: "/", env: {} },
      new AbortController().signal,
    );
    await expect(child.exited).resolves.toMatchObject({ exitCode: 7 });
    await child.dispose();
    expect(localRuns).toBe(1);
    expect(machine.spawn).not.toHaveBeenCalled();
  });

  it("uses one frozen command snapshot through asynchronous evidence and machine execution", async () => {
    const started = deferred<KernelCommand>();
    const finishEvidence = deferred<{ workspaceBytes: number }>();
    const { commands, child, machine } = computerHarness(() => 0, {
      escalation: new ComputerEscalationTable([
        {
          id: "large-probe",
          executable: "/bin/probe",
          argvPrefix: ["--large"],
          minimumWorkspaceBytes: 10,
        },
      ]),
      evidence: async (captured) => {
        started.resolve(captured);
        return finishEvidence.promise;
      },
    });
    const input = {
      executable: "/bin/probe",
      argv: ["original-argv0", "--large"],
      cwd: "/",
      env: { EMPTY: "", TOKEN: "before" },
    };
    const signal = new AbortController().signal;
    const execution = commands.exec(input, signal);
    const captured = await started.promise;
    expect(captured).toEqual({
      executable: "/bin/probe",
      argv: ["original-argv0", "--large"],
      cwd: "/",
      env: { EMPTY: "", TOKEN: "before" },
    });
    input.executable = "/bin/changed";
    input.argv[0] = "changed-argv0";
    input.argv[1] = "--small";
    input.cwd = "/changed";
    input.env.EMPTY = "changed";
    input.env.TOKEN = "after";
    finishEvidence.resolve({ workspaceBytes: 10 });
    await expect(execution).resolves.toBe(child);
    expect(machine.spawn).toHaveBeenCalledOnce();
    expect(machine.spawn.mock.calls[0]?.[0]).toBe(captured);
  });

  it("does not retry a failed local program on the machine", async () => {
    const failed = new Error("local program failed");
    let localRuns = 0;
    const { commands, machine } = computerHarness(() => {
      localRuns++;
      throw failed;
    });
    const child = await commands.exec(probeCommand(), new AbortController().signal);
    await expect(child.exited).rejects.toThrow("Child process completion failed");
    expect(localRuns).toBe(1);
    expect(machine.spawn).not.toHaveBeenCalled();
    await child.dispose();
  });

  it("does not admit an already-aborted command", async () => {
    let localRuns = 0;
    const evidence = vi.fn(async () => ({ workspaceBytes: 100 }));
    const { commands, machine } = computerHarness(
      () => {
        localRuns++;
        return 0;
      },
      {
        escalation: new ComputerEscalationTable([{ id: "probe", executable: "/bin/probe" }]),
        evidence,
      },
    );
    const controller = new AbortController();
    const reason = new Error("cancel before admission");
    controller.abort(reason);
    await expect(commands.exec(probeCommand(), controller.signal)).rejects.toBe(reason);
    expect(evidence).not.toHaveBeenCalled();
    expect(localRuns).toBe(0);
    expect(machine.spawn).not.toHaveBeenCalled();
  });

  it.each(["/bin/missing", "/usr/bin/apt", "/usr/bin/docker", "/usr/bin/gcc"])(
    "routes unregistered %s to the machine with the exact command",
    async (executable) => {
      const { context, commands, child, machine } = computerHarness(() => 0);
      context.filesystem.mkdir("/workspace");
      const command = {
        executable,
        argv: ["custom-argv0", "--flag", ""],
        cwd: "/workspace",
        env: { EMPTY: "", PATH: "/bin", TOKEN: "exact" },
      };
      const signal = new AbortController().signal;
      await expect(commands.exec(command, signal)).resolves.toBe(child);
      expect(machine.spawn).toHaveBeenCalledExactlyOnceWith(command, signal);
    },
  );

  it("keeps an allowed but unbound exact executable on the normal NOT_FOUND machine fallback", async () => {
    let localRuns = 0;
    const { context, commands, child, machine } = computerHarness(
      () => {
        localRuns++;
        return 0;
      },
      { escalation: new ComputerEscalationTable([], COMPUTER_ISOLATE_POLICY) },
    );
    context.filesystem.mkdir("/workspace");
    const command = {
      executable: "sed",
      argv: ["captured-sed", "-n", "1p", "file"],
      cwd: "/workspace",
      env: { PATH: "/bin", TOKEN: "exact" },
    };
    const signal = new AbortController().signal;

    await expect(commands.exec(command, signal)).resolves.toBe(child);

    expect(machine.spawn).toHaveBeenCalledExactlyOnceWith(command, signal);
    expect(localRuns).toBe(0);
  });

  it("sends a registered executable outside the exact policy to the machine before local start", async () => {
    let localRuns = 0;
    const escalation = new ComputerEscalationTable([], {
      isolateExecutables: ["sed"],
      default: "machine",
    });
    const { commands, child, machine } = computerHarness(
      () => {
        localRuns++;
        return 0;
      },
      { escalation },
    );
    const command = probeCommand();
    const signal = new AbortController().signal;

    expect(escalation.decide(command)).toEqual({
      kind: "machine",
      reason: "unsupported-executable",
    });
    await expect(commands.exec(command, signal)).resolves.toBe(child);

    expect(machine.spawn).toHaveBeenCalledExactlyOnceWith(command, signal);
    expect(localRuns).toBe(0);
  });

  it("rejects unregistered commands on the isolate-only entry point", async () => {
    const { commands, machine } = computerHarness(() => 0, {
      escalation: new ComputerEscalationTable([], {
        isolateExecutables: ["/bin/missing"],
        default: "machine",
      }),
    });
    await expect(
      commands.isolate.exec(
        { ...probeCommand(), executable: "/bin/missing", argv: ["missing"] },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: "KernelForwardingUnavailable", code: "POLICY_NOT_READY" });
    expect(machine.spawn).not.toHaveBeenCalled();
  });

  it.each([
    ["relative", "workspace"],
    ["absolute but noncanonical", "/workspace/.."],
  ])("rejects %s cwd on both command entry points", async (_kind, cwd) => {
    let localRuns = 0;
    const evidence = vi.fn(async () => ({ workspaceBytes: 100 }));
    const { context, commands, machine } = computerHarness(
      () => {
        localRuns++;
        return 0;
      },
      {
        escalation: new ComputerEscalationTable([{ id: "probe", executable: "/bin/probe" }]),
        evidence,
      },
    );
    context.filesystem.mkdir("/workspace");
    const command = probeCommand(cwd);
    const signal = new AbortController().signal;
    await expect(Promise.resolve().then(() => commands.exec(command, signal))).rejects.toThrow();
    await expect(
      Promise.resolve().then(() => commands.isolate.exec(command, signal)),
    ).rejects.toThrow();
    expect(evidence).not.toHaveBeenCalled();
    expect(localRuns).toBe(0);
    expect(machine.spawn).not.toHaveBeenCalled();
  });
});
