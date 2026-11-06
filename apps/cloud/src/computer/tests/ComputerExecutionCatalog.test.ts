import { expect, it, vi } from "vite-plus/test";
import { ComputerExecutionObject } from "../ComputerExecutionObject.ts";
import { createKernelComputerHost } from "../../kernel/KernelComputerHost.ts";
import { createKernelExecutableNamespace } from "../../kernel/KernelExecutableNamespace.ts";
import { commandProgramCodes, exited } from "../commandGatewayTesting.ts";
import { childBusyboxFixture } from "./ChildBusyboxFixture.ts";

vi.mock("cloudflare:workers", () => ({
  RpcTarget: Object,
  DurableObject: class {
    readonly ctx;
    readonly env;
    constructor(ctx: DurableObjectState, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const programs = [
  {
    name: "grep",
    args: ["needle", "/work/input.txt"],
    module: "ugrep.js",
    executable: "/bin/grep",
  },
  {
    name: "sed",
    args: ["-n", "1p", "/work/input.txt"],
    module: "gnu-sed.js",
    executable: "/bin/sed",
  },
  { name: "jq", args: ["."], module: "jq.js", executable: "/usr/bin/jq" },
  { name: "cat", args: [], module: "busybox-applets.js", executable: "/bin/cat" },
  { name: "touch", args: ["output.txt"], module: "busybox-applets.js", executable: "/bin/touch" },
  { name: "env", args: [], module: "busybox-product-applets.js", executable: "/bin/env" },
  { name: "ugrep", args: ["needle"], module: "ugrep.js", executable: "/bin/ugrep" },
];

it.each(
  programs.flatMap((program) =>
    [program.name, `/usr/bin/${program.name}`].map((path) => ({ ...program, path })),
  ),
)(
  "the Computer DO resolves and dispatches $path through its catalog and kernel host",
  async (program) => {
    const kernel = childBusyboxFixture();
    const records = new Map<string, unknown>();
    const ctx = {
      id: "catalog-owner",
      storage: {
        get: async <T>(key: string) => structuredClone(records.get(key)) as T | undefined,
        put: async (key: string, value: unknown) => {
          records.set(key, structuredClone(value));
        },
      },
    } as unknown as DurableObjectState;
    const dispatched: string[] = [];
    let dispatchFailure: unknown;
    const owner = new ComputerExecutionObject(ctx, {
      RESIDENT_BYTE_LIMIT: String(104 * 1024 * 1024),
      CHILD_WORKERS: {
        async run(input, target) {
          if (
            !("host" in target) ||
            typeof target.host !== "function" ||
            !("stopped" in target) ||
            typeof target.stopped !== "function"
          )
            throw new Error("Computer dispatch omitted the admitted kernel capability");
          try {
            expect(await target.host()).toHaveProperty("call");
            expect(input.modules).toHaveProperty(program.module);
            expect(input.modules[input.mainModule]).toContain(
              JSON.stringify(`./${program.module}`),
            );
            expect(input.command.executable).toBe(program.executable);
            expect(input.command.argv).toEqual([program.name, ...program.args]);
            dispatched.push(input.command.executable);
            return exited();
          } catch (error) {
            dispatchFailure = error;
            throw error;
          } finally {
            await target.stopped();
          }
        },
      },
    });
    await owner.configure({
      programs: commandProgramCodes(),
      path: ["/bin", "/usr/bin"],
      limit: 2,
    });
    const commands = await createKernelComputerHost({
      owner,
      filesystem: kernel.filesystem,
      processes: kernel.context.processes,
      wakes: kernel.context.wakes,
      hostname: "catalog-owner",
      namespace: (request) =>
        createKernelExecutableNamespace({ filesystem: request.filesystem, signal: request.signal }),
      machine: {
        spawn: async () => {
          throw new Error("Registered programs must reach the Computer owner");
        },
      },
    });
    try {
      const child = await commands.exec(
        {
          executable: program.path,
          argv: [program.name, ...program.args],
          cwd: "/workspace",
          env: { PATH: "/bin:/usr/bin" },
        },
        kernel.controller.signal,
        undefined,
      );
      try {
        expect(
          await child.exited.catch((error) => {
            throw dispatchFailure ?? error;
          }),
        ).toEqual(exited());
      } finally {
        await child.dispose();
      }
      await commands.drain();
      expect(dispatched).toEqual([program.executable]);
    } finally {
      try {
        await commands.close();
      } finally {
        await kernel.close();
      }
    }
  },
);
