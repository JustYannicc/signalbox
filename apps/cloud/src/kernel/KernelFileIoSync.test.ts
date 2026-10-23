import { describe, expect, it } from "vite-plus/test";
import { KernelOpenFlags } from "./KernelFileSystem.ts";
import { createTestFilesystem, readFile, guest, inline } from "./tests/inlineFileIoFixture.ts";

const outcome = (run: () => unknown) => {
  try {
    return { kind: "returned", value: run() };
  } catch (error) {
    return {
      kind: "threw",
      error: String(error),
      code: (error as { code?: unknown }).code,
    };
  }
};

describe("sync caller on a description a child holds between chunks", () => {
  it.each(
    (
      [
        ["fd_write", "append", "inline-wasm"],
        ["fd_write", "append", "harness-fs"],
        ["fd_write", "plain", "inline-wasm"],
        ["fd_write", "plain", "harness-fs"],
        ["fd_read", "plain", "inline-wasm"],
        ["fd_read", "plain", "harness-fs"],
      ] as const
    ).flatMap((entry) => [128 * 1024, 2 * 1024 * 1024].map((size) => [...entry, size] as const)),
  )("%s %s %s with %s bytes", async (name, mode, caller, size) => {
    const fixture = createTestFilesystem();
    const flags =
      KernelOpenFlags.O_CREAT |
      KernelOpenFlags.O_RDWR |
      (mode === "append" ? KernelOpenFlags.O_APPEND : 0);
    const fd = fixture.filesystem.open("/log", flags);
    if (name === "fd_read") {
      fixture.filesystem.write(fd, new Uint8Array(size).fill(0x2e), 0n);
    }
    const a = guest(fixture.filesystem, name, size);
    a.bytes.fill(0x41);
    const sync = inline(fixture.filesystem);
    let during: unknown;
    a.after(async (request) => {
      if (during !== undefined || request.transferOffset !== 0) return;
      during = outcome(() =>
        caller === "inline-wasm"
          ? name === "fd_write"
            ? sync.write(fd)
            : sync.run("fd_read", ["i32", "i32", "i32", "i32"], [fd, 0, 1, 16])
          : name === "fd_write"
            ? fixture.filesystem.write(fd, new TextEncoder().encode("HARNESS"), null)
            : fixture.filesystem.read(fd, new Uint8Array(7), null),
      );
    });
    try {
      const childResult = await a.run(fd);
      const after = outcome(() =>
        caller === "inline-wasm"
          ? sync.write(fd)
          : fixture.filesystem.write(fd, new TextEncoder().encode("HARNESS"), null),
      );
      expect(childResult).toBe(0);
      expect(during).toMatchObject({ kind: "returned" });
      expect(after).toMatchObject({ kind: "returned" });
      if (name === "fd_write" && mode === "append" && size === 128 * 1024) {
        const marker = new TextEncoder().encode(caller === "inline-wasm" ? "INLINE" : "HARNESS");
        const contents = readFile(fixture.filesystem, "/log", size + 2 * marker.length);
        expect(contents.subarray(0, size).every((byte) => byte === 0x41)).toBe(true);
        expect(contents.subarray(size, size + marker.length)).toEqual(marker);
        expect(contents.subarray(size + marker.length)).toEqual(marker);
      }
    } finally {
      a.close();
      await sync.close();
      fixture.close();
    }
  });
});
