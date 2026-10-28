// @effect-diagnostics nodeBuiltinImport:off - hashes controlled file bytes without a native engine.
import * as NodeCrypto from "node:crypto";
import { expect, it, vi } from "vite-plus/test";
import { attachProgramReference } from "../../../infra/childPrograms/runtime.ts";
import { KernelOpenFlags, type KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { ComputerProgramResolver } from "../ComputerProgramResolver.ts";
import {
  commandGatewayFixture,
  commandProgramCodes,
  exited,
  type FakeChildRun,
} from "../commandGatewayTesting.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

function fixtureFor(
  options: {
    readonly path?: string;
    readonly lower?: boolean;
    readonly missing?: boolean;
    readonly mode?: number;
    readonly machineRule?: boolean;
    readonly seed?: string;
  } = {},
) {
  const path = options.path ?? "/usr/bin/bash";
  const run = vi.fn<FakeChildRun>(async (_input, invocation) => {
    invocation.acknowledge();
    return exited();
  });
  const bytes = new TextEncoder().encode(options.seed ?? "");
  const programs = {
    ...commandProgramCodes(),
    ...(options.seed === undefined
      ? {}
      : {
          bash: attachProgramReference(
            { mainModule: "bash.js", modules: { "bash.js": "export default class {}" } },
            {
              bytes: bytes.length,
              sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
            },
          ),
        }),
  };
  const fixture = commandGatewayFixture({
    run,
    programs,
    resolver: new ComputerProgramResolver({
      path: ["/usr/bin", "/bin"],
      overlay: { prepare: async () => {}, isLower: async () => options.lower ?? false },
    }),
    before(filesystem) {
      filesystem.mkdir("/usr");
      filesystem.mkdir("/usr/bin");
      filesystem.mkdir("/bin");
      if (!options.missing)
        write(filesystem, path, options.seed ?? "printf USER_BASH_ALIAS\n", options.mode);
    },
    ...(options.machineRule
      ? { orderedMachineRules: [{ id: "explicit-alias", executable: path }] }
      : {}),
  });
  const command = {
    executable: path,
    argv: [path, "--noprofile", "--norc", "-c", "printf CATALOG"],
    cwd: "/workspace",
    env: {},
  };
  return { ...fixture, run, command };
}

function write(filesystem: KernelFileSystem, path: string, value: string, mode = 0o755) {
  const fd = filesystem.open(
    path,
    KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_TRUNC,
    mode,
  );
  try {
    filesystem.write(fd, new TextEncoder().encode(value), null);
  } finally {
    filesystem.close(fd);
  }
}

it("returns ENOEXEC for a user script at the generated /usr/bin/bash alias", async () => {
  const fixture = fixtureFor();
  try {
    await expect(
      fixture.gateway.exec(fixture.command, fixture.controller.signal, undefined),
    ).rejects.toMatchObject({ code: "ENOEXEC" });
    expect(fixture.run).not.toHaveBeenCalled();
    expect(fixture.machineSpawn).not.toHaveBeenCalled();
    expect(fixture.capacity.active).toBe(0);
  } finally {
    await fixture.close();
  }
});

it("accepts an upper alias only while its bytes match the actual pinned program", async () => {
  const seed = "x".repeat(64 * 1024 + 37);
  const fixture = fixtureFor({ seed });
  const read = vi.spyOn(fixture.filesystem, "readAsync");
  try {
    const child = await fixture.gateway.exec(fixture.command, fixture.controller.signal, undefined);
    await expect(child.exited).resolves.toEqual(exited());
    await child.dispose();
    expect(fixture.run).toHaveBeenCalledTimes(1);
    expect(read.mock.calls.every(([, target]) => target.byteLength <= 64 * 1024)).toBe(true);

    // This fixture's clock is constant; same-size writes must not rely on ctime for validity.
    const original = fixture.filesystem.stat(fixture.command.executable);
    write(fixture.filesystem, fixture.command.executable, "y" + seed.slice(1));
    expect(fixture.filesystem.stat(fixture.command.executable).ctimeNs).toBe(original.ctimeNs);
    await expect(
      fixture.gateway.exec(fixture.command, fixture.controller.signal, undefined),
    ).rejects.toMatchObject({ code: "ENOEXEC" });
    expect(fixture.run).toHaveBeenCalledTimes(1);
    expect(fixture.machineSpawn).not.toHaveBeenCalled();
  } finally {
    await fixture.close();
  }
});

it("rechecks an alias replaced by a different inode", async () => {
  const fixture = fixtureFor({ seed: "original seeded program" });
  try {
    const child = await fixture.gateway.exec(fixture.command, fixture.controller.signal, undefined);
    await child.exited;
    await child.dispose();
    write(fixture.filesystem, "/usr/bin/replacement", "printf USER_BASH_ALIAS\n");
    fixture.filesystem.rename("/usr/bin/replacement", fixture.command.executable);
    await expect(
      fixture.gateway.exec(fixture.command, fixture.controller.signal, undefined),
    ).rejects.toMatchObject({ code: "ENOEXEC" });
    expect(fixture.run).toHaveBeenCalledTimes(1);
    expect(fixture.machineSpawn).not.toHaveBeenCalled();
  } finally {
    await fixture.close();
  }
});

it("preserves execute permission errors on an upper alias", async () => {
  const fixture = fixtureFor({ mode: 0o644 });
  try {
    await expect(
      fixture.gateway.exec(fixture.command, fixture.controller.signal, undefined),
    ).rejects.toMatchObject({ code: "EACCES" });
    expect(fixture.run).not.toHaveBeenCalled();
    expect(fixture.machineSpawn).not.toHaveBeenCalled();
  } finally {
    await fixture.close();
  }
});

it.each([{ lower: true }, { missing: true }])(
  "preserves a catalog alias when no upper file shadows it: %j",
  async (options) => {
    const fixture = fixtureFor(options);
    try {
      const child = await fixture.gateway.exec(
        fixture.command,
        fixture.controller.signal,
        undefined,
      );
      await expect(child.exited).resolves.toEqual(exited());
      await child.dispose();
      expect(fixture.run).toHaveBeenCalledTimes(1);
      expect(fixture.machineSpawn).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  },
);

it("preserves an explicit machine rule for an upper script at an alias", async () => {
  const fixture = fixtureFor({ machineRule: true });
  try {
    const child = await fixture.gateway.exec(fixture.command, fixture.controller.signal, undefined);
    await child.exited;
    await child.dispose();
    expect(fixture.machineSpawn).toHaveBeenCalledExactlyOnceWith(
      fixture.command,
      expect.any(AbortSignal),
    );
    expect(fixture.run).not.toHaveBeenCalled();
  } finally {
    await fixture.close();
  }
});

it("does not forward an upper sed script through catalog GNU qualification", async () => {
  const fixture = fixtureFor({ path: "/usr/bin/sed" });
  try {
    await expect(
      fixture.gateway.exec(
        { ...fixture.command, argv: ["sed", "--sandbox", "1p"] },
        fixture.controller.signal,
        undefined,
      ),
    ).rejects.toMatchObject({ code: "ENOEXEC" });
    expect(fixture.run).not.toHaveBeenCalled();
    expect(fixture.machineSpawn).not.toHaveBeenCalled();
  } finally {
    await fixture.close();
  }
});
