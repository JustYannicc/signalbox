import { afterAll, expect, it, vi } from "vite-plus/test";
import { KernelProgramRegistry } from "../../kernel/KernelAbi.ts";
import { createChildProgramCatalog } from "../ChildProgramCatalog.ts";
import { ComputerProgramResolver } from "../ComputerProgramResolver.ts";
import { commandGatewayFixture, commandProgramCodes, exited } from "../commandGatewayTesting.ts";
import { childBusyboxFixture } from "./ChildBusyboxFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const kernel = childBusyboxFixture();
const catalog = createChildProgramCatalog({
  registry: new KernelProgramRegistry(),
  filesystem: kernel.filesystem,
  loader: {
    run: async () => {
      throw new Error("Catalog discovery must not launch a child");
    },
  },
  capacity: {
    run: async () => {
      throw new Error("Catalog discovery must not acquire capacity");
    },
  },
  programs: commandProgramCodes(),
  hostname: "catalog-path-test",
});
afterAll(() => kernel.close());

const programs = [
  ...new Map(
    [...catalog.bindings].map(([path, binding]) => [
      path.slice(path.lastIndexOf("/") + 1),
      binding,
    ]),
  ),
];
const paths = programs.flatMap(([name, binding]) =>
  [name, `/bin/${name}`, `/usr/bin/${name}`].map((executable) => ({ name, executable, binding })),
);

it.each(paths)(
  "resolves registered $name through $executable with the same body",
  async ({ name, executable, binding }) => {
    expect(catalog.bindings.get(executable)?.implementation).toBe(binding.implementation);
    const dispatched: string[] = [];
    const fixture = commandGatewayFixture({
      run: async (input, invocation) => {
        dispatched.push(input.command.executable);
        invocation.acknowledge();
        return exited();
      },
    });
    try {
      const argv =
        name === "grep"
          ? [name, "needle", "/work/input.txt"]
          : name === "sed"
            ? [name, "-n", "1p", "/work/input.txt"]
            : name === "ugrep" || name === "claude"
              ? ["ugrep", "needle"]
              : [name];
      const child = await fixture.gateway.exec(
        { executable, argv, cwd: "/", env: { PATH: "/usr/bin:/bin" } },
        fixture.controller.signal,
        undefined,
      );
      try {
        expect(await child.exited).toEqual(exited());
      } finally {
        await child.dispose();
      }
      await fixture.gateway.drain();
      expect(fixture.machineSpawn).not.toHaveBeenCalled();
      expect(dispatched).toHaveLength(1);
      expect(fixture.capacity.active).toBe(0);
    } finally {
      await fixture.close();
    }
  },
);

it.each(paths)(
  "selects the catalog body for filesystem/PATH lookup of $executable",
  async ({ name, executable, binding }) => {
    const fixture = childBusyboxFixture();
    fixture.filesystem.mkdir("/bin");
    fixture.filesystem.mkdir("/usr");
    fixture.filesystem.mkdir("/usr/bin");
    fixture.write(`/bin/${name}`, "catalog executable", 0o755);
    fixture.write(`/usr/bin/${name}`, "catalog executable", 0o755);
    const resolver = new ComputerProgramResolver({
      path: ["/usr/bin", "/bin"],
      overlay: { prepare: async () => {}, isLower: async () => true },
    });
    try {
      const command = { executable, argv: [name], cwd: "/", env: { PATH: "/usr/bin:/bin" } };
      const resolved = await resolver.resolve({
        kind: "command",
        stdio: "piped",
        command,
        baseCwd: "/",
        actions: [],
        attributes: undefined,
        filesystem: fixture.filesystem,
        processes: fixture.context.processes,
        signal: fixture.controller.signal,
        target: { kind: "unsupported", code: "NOT_FOUND", message: "Command not found" },
        catalog: catalog.bindings,
      });
      expect(resolved.command.executable).toBe(
        executable.includes("/") ? executable : `/usr/bin/${name}`,
      );
      expect(resolved.catalog?.binding.implementation).toBe(binding.implementation);
    } finally {
      await fixture.close();
    }
  },
);

it.each([
  ...["grep", "/bin/grep", "/usr/bin/grep"].map((executable) => ({
    executable,
    argv: ["grep", "-P", "needle", "file"],
  })),
  ...["sed", "/bin/sed", "/usr/bin/sed"].map((executable) => ({
    executable,
    argv: ["sed", "--sandbox", "1p"],
  })),
  ...["ugrep", "/bin/ugrep", "/usr/bin/ugrep"].map((executable) => ({
    executable,
    argv: ["ugrep", "--fuzzy", "needle"],
  })),
  ...["claude", "/bin/claude", "/usr/bin/claude", "/usr/local/bin/claude"].map((executable) => ({
    executable,
    argv: ["claude", "--version"],
  })),
])("preserves machine qualification for $executable $argv", async ({ executable, argv }) => {
  const fixture = commandGatewayFixture();
  try {
    const command = { executable, argv, cwd: "/", env: {} };
    const child = await fixture.gateway.exec(command, fixture.controller.signal, undefined);
    await child.exited;
    await child.dispose();
    expect(fixture.machineSpawn).toHaveBeenCalledExactlyOnceWith(command, expect.any(AbortSignal));
  } finally {
    await fixture.close();
  }
});

it("runs /usr/bin/grep through the isolate catalog without machine forwarding", async () => {
  const dispatched: string[] = [];
  const fixture = commandGatewayFixture({
    run: async (input, invocation) => {
      dispatched.push(input.command.executable);
      invocation.acknowledge();
      return exited();
    },
  });
  try {
    const child = await fixture.gateway.exec(
      {
        executable: "/usr/bin/grep",
        argv: ["grep", "needle", "/work/input.txt"],
        cwd: "/",
        env: {},
      },
      fixture.controller.signal,
      undefined,
    );
    try {
      expect(await child.exited).toEqual(exited());
    } finally {
      await child.dispose();
    }
    await fixture.gateway.drain();
    expect(fixture.machineSpawn).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

it("keeps an explicit machine rule on the requested alias ahead of catalog resolution", async () => {
  const fixture = commandGatewayFixture({
    orderedMachineRules: [{ id: "machine-grep", executable: "/usr/bin/grep" }],
  });
  const command = {
    executable: "/usr/bin/grep",
    argv: ["grep", "needle", "file"],
    cwd: "/",
    env: {},
  };
  try {
    const child = await fixture.gateway.exec(command, fixture.controller.signal, undefined);
    await child.exited;
    await child.dispose();
    expect(fixture.machineSpawn).toHaveBeenCalledExactlyOnceWith(command, expect.any(AbortSignal));
    expect(fixture.capacity.active).toBe(0);
  } finally {
    await fixture.close();
  }
});
