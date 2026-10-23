import { describe, expect, it } from "vite-plus/test";
import { KernelOpenFlags } from "./KernelFileSystem.ts";
import { createTestFilesystem, guest } from "./tests/inlineFileIoFixture.ts";

const MIB = 1024 * 1024;
const yieldRequest = { name: "sched_yield", args: [], memorySize: 0, regions: [] };

describe("child payloads after idle syscalls", () => {
  it.each(["write-then-yield", "read-to-eof"] as const)(
    "%s leaves a fresh 64 MiB copy within 67 RPCs after 16 idle children",
    async (pattern) => {
      const fixture = createTestFilesystem();
      const output = fixture.filesystem.open("/dev/null", KernelOpenFlags.O_WRONLY);
      const setup = fixture.filesystem.open(
        "/small",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY,
      );
      fixture.filesystem.write(setup, new Uint8Array(100).fill(0x41), 0n);
      fixture.filesystem.close(setup);
      const idle = Array.from({ length: 16 }, () =>
        guest(
          fixture.filesystem,
          pattern === "write-then-yield" ? "fd_write" : "fd_read",
          pattern === "write-then-yield" ? MIB : 64 * 1024,
        ),
      );
      const fresh = guest(fixture.filesystem, "fd_write", 64 * MIB);
      try {
        for (const child of idle) {
          if (pattern === "write-then-yield") expect(await child.run(output)).toBe(0);
          else {
            const input = fixture.filesystem.open("/small", KernelOpenFlags.O_RDONLY);
            try {
              expect(await child.run(input)).toBe(0);
              expect(child.view.getUint32(16, true)).toBe(100);
              expect(await child.run(input)).toBe(0);
              expect(child.view.getUint32(16, true)).toBe(0);
            } finally {
              fixture.filesystem.close(input);
            }
          }
          for (let count = 0; count < 3; count++)
            expect(await child.host.call(yieldRequest)).toMatchObject({ kind: "return", value: 0 });
        }
        expect(await fresh.run(output)).toBe(0);
        expect(fresh.view.getUint32(16, true)).toBe(64 * MIB);
        expect(fresh.calls).toBeLessThanOrEqual(67);
      } finally {
        for (const child of idle) child.close();
        fresh.close();
        fixture.close();
      }
    },
  );
});
