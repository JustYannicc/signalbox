import { describe, expect, it, vi } from "vite-plus/test";
import { createKernelCoreutilsHost } from "../../kernel/KernelCoreutilsHost.ts";
import type { KernelCommand } from "../../kernel/KernelCommandForwarder.ts";
import type { KernelCoreutilsPort } from "../../kernel/KernelCoreutilsPort.ts";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import type { KernelSyscallRequest } from "../../kernel/KernelSyscallPort.ts";
import { childBusyboxFixture, exited, text } from "./ChildBusyboxFixture.ts";
import { createChildCoreutils } from "../ChildCoreutils.ts";
import { createChildCoreutilsProgram } from "../ChildCoreutilsProgram.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { coreutilsArtifactsAvailable, runCoreutilsCommand } from "./CoreutilsArtifactFixture.ts";
import { wasmEnvironmentGetCommand } from "./CoreutilsWasmImportFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const childCode = { mainModule: "main.js", modules: { "main.js": "export default {};" } };
describe("Coreutils child bridge", () => {
  it("keeps the 4 GiB guest address space sparse in the parent host", async () => {
    const fixture = childBusyboxFixture();
    const owner = createKernelCoreutilsHost({ context: fixture.context });
    const path = text("/workspace");
    const pathPointer = 0xffff_fff0;
    const outputPointer = 0xffff_ffe0;
    fixture.write("owner.txt", "owner");
    const fd = fixture.filesystem.open("owner.txt", KernelOpenFlags.O_RDONLY);
    try {
      const mode = await owner.port.callCoreutils({
        namespace: "host_fs",
        name: "path_mode",
        args: [-1, pathPointer, path.byteLength, 1],
        memorySize: 0x1_0000_0000,
        regions: [{ pointer: pathPointer, bytes: path }],
      });
      expect(mode).toEqual({ value: 0o040755, regions: [] });

      const ownerResult = await owner.port.callCoreutils({
        namespace: "host_fs",
        name: "fd_owner",
        args: [fd, outputPointer, outputPointer + 4],
        memorySize: 0x1_0000_0000,
        regions: [{ pointer: outputPointer, bytes: new Uint8Array(8) }],
      });
      expect(ownerResult.value).toBe(0);
      const metadata = new DataView(ownerResult.regions[0]!.bytes.buffer);
      expect([metadata.getUint32(0, true), metadata.getUint32(4, true)]).toEqual([1000, 1000]);
    } finally {
      fixture.filesystem.close(fd);
      await owner.close();
      await fixture.close();
    }
  });

  it("waits for an active syscall before closing the borrowed host", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<number>();
    const fixture = childBusyboxFixture({
      readInto: () => {
        entered.resolve();
        return release.promise;
      },
    });
    const owner = createKernelCoreutilsHost({ context: fixture.context });
    const iovecs = new Uint8Array(8);
    const iovec = new DataView(iovecs.buffer);
    iovec.setUint32(0, 128, true);
    iovec.setUint32(4, 1, true);
    const request: KernelSyscallRequest = {
      name: "fd_read",
      args: [0, 32, 1, 16],
      memorySize: 65_536,
      regions: [
        { pointer: 16, bytes: new Uint8Array(4) },
        { pointer: 32, bytes: iovecs },
        { pointer: 128, bytes: new Uint8Array(1) },
      ],
    };
    const pending = owner.port.call(request);
    try {
      await entered.promise;
      let closed = false;
      const closing = owner.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      release.resolve(0);
      await pending;
      await closing;
      expect(fixture.filesystem.descriptors.has(0)).toBe(true);
    } finally {
      release.resolve(0);
      await pending.catch(() => {});
      await owner.close();
      await fixture.close();
    }
  });

  describe("Coreutils child environment", () => {
    const environments: readonly [string, Readonly<Record<string, string>>][] = [
      ["missing PWD", { PATH: "/bin" }],
      ["stale short PWD", { PATH: "/bin", PWD: "/x" }],
    ];

    it.each(environments)(
      "shares the normalized cwd with the parent and child for %s",
      async (_name, env) => {
        const fixture = childBusyboxFixture({ args: ["pwd"], env });
        const capacity = new ChildWorkerCapacity();
        const commands: KernelCommand[] = [];
        let parentEnvironment: string | undefined;
        const module = wasmEnvironmentGetCommand();
        const program = createChildCoreutilsProgram({
          executable: "/bin/pwd",
          code: childCode,
          capacity,
          dispatch: {
            async run(input, port: KernelCoreutilsPort) {
              commands.push(structuredClone(input.command));
              const guestPort: KernelCoreutilsPort = {
                async call(request) {
                  const response = await port.call(request);
                  if (request.name === "environ_get" && response.kind === "return") {
                    const region = response.regions.find((candidate) => candidate.pointer === 64);
                    parentEnvironment =
                      region === undefined ? "" : new TextDecoder().decode(region.bytes);
                  }
                  return response;
                },
                callCoreutils: (request) => port.callCoreutils(request),
              };
              return createChildCoreutils({
                module,
                port: guestPort,
                args: input.command.argv,
                env: input.command.env,
              }).run();
            },
          },
        });

        try {
          const result = await program.run(fixture.context);
          expect(parentEnvironment).toBe("PATH=/bin\0PWD=/workspace");
          expect(result).toEqual(exited());
          expect(commands).toEqual([
            {
              executable: "/bin/pwd",
              argv: ["pwd"],
              cwd: "/workspace",
              env: { ...env, PWD: "/workspace" },
            },
          ]);
          expect(capacity.active).toBe(0);
        } finally {
          await fixture.close();
        }
      },
    );
  });

  describe.skipIf(!coreutilsArtifactsAvailable)("actual pinned coreutils child", () => {
    it("runs head against the shared process", async () => {
      await runCoreutilsCommand(
        "head",
        ["-n", "1", "lines.txt"],
        (fixture) => fixture.write("lines.txt", "first\nsnow 雪\nlast\n"),
        ({ stdout }) => expect(stdout).toBe("first\n"),
      );
    });

    it("runs tail against the shared process", async () => {
      await runCoreutilsCommand(
        "tail",
        ["-n", "1", "lines.txt"],
        (fixture) => fixture.write("lines.txt", "first\nsnow 雪\nlast\n"),
        ({ stdout }) => expect(stdout).toBe("last\n"),
      );
    });

    it("lists the shared directory", async () => {
      await runCoreutilsCommand(
        "ls",
        ["-1"],
        (fixture) => fixture.write("listed.txt", "present"),
        ({ stdout }) => {
          expect(stdout).toContain("listed.txt\n");
          expect(stdout).toContain("nested\n");
        },
      );
    });

    it("lists admitted file ownership from the child filesystem", async () => {
      await runCoreutilsCommand(
        "ls",
        ["-ln", "owned.txt"],
        (fixture) => fixture.write("owned.txt", "owned"),
        ({ stdout }) => expect(stdout).toMatch(/\b1201\s+1302\b/),
        {
          posix: {
            credentials: { uid: 1201, gid: 1302, euid: 1201, egid: 1302 },
            umask: 0o022,
          },
        },
      );
    });

    it("creates directories with the requested mode", async () => {
      await runCoreutilsCommand(
        "mkdir",
        ["-m", "700", "created"],
        undefined,
        ({ fixture, result }) => {
          expect(result).toEqual(exited());
          expect(fixture.filesystem.getPosixMetadata("created").mode & 0o777).toBe(0o700);
        },
      );
    });

    it("removes a file from the shared directory", async () => {
      await runCoreutilsCommand(
        "rm",
        ["remove-me"],
        (fixture) => fixture.write("remove-me", "gone"),
        ({ fixture, result }) => {
          expect(result).toEqual(exited());
          expect(() => fixture.filesystem.stat("remove-me")).toThrow();
        },
      );
    });

    it("copies a file on the shared filesystem", async () => {
      await runCoreutilsCommand(
        "cp",
        ["original.txt", "copy.txt"],
        (fixture) => fixture.write("original.txt", "shared bytes"),
        ({ fixture, result }) => {
          expect(result).toEqual(exited());
          expect(fixture.read("copy.txt")).toBe("shared bytes");
        },
      );
    });

    it("moves a file on the shared filesystem", async () => {
      await runCoreutilsCommand(
        "mv",
        ["original.txt", "moved.txt"],
        (fixture) => fixture.write("original.txt", "shared bytes"),
        ({ fixture, result }) => {
          expect(result).toEqual(exited());
          expect(() => fixture.filesystem.stat("original.txt")).toThrow();
          expect(fixture.read("moved.txt")).toBe("shared bytes");
        },
      );
    });

    it("prints formatted UTF-8 output", async () => {
      await runCoreutilsCommand("printf", ["%s\\n", "snow 雪"], undefined, ({ stdout }) => {
        expect(stdout).toBe("snow 雪\n");
      });
    });

    it("prints the prepared working directory", async () => {
      await runCoreutilsCommand("pwd", [], undefined, ({ stdout }) =>
        expect(stdout).toBe("/workspace\n"),
      );
    });
  });
});
