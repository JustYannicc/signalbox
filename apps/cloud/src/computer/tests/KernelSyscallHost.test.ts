import { describe, expect, it } from "vite-plus/test";
import { KernelOpenFlags, type WasiStdio } from "../../kernel/KernelFileSystem.ts";
import { createKernelSyscallHost } from "../../kernel/KernelSyscallHost.ts";
import type { KernelSyscallResponse } from "../../kernel/KernelSyscallPort.ts";
import { createTestFilesystem } from "./helpers/filesystem.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const bytes = (...values: number[]) => Uint8Array.from(values);
type Fixture = ReturnType<typeof createTestFilesystem>;
type SyscallHost = ReturnType<typeof createKernelSyscallHost>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => (resolve = complete));
  return { promise, resolve };
}

function iovec(buffer: number, length: number) {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, buffer, true);
  view.setUint32(4, length, true);
  return bytes;
}

function returned(response: KernelSyscallResponse) {
  if (response.kind !== "return") throw new Error("Expected a syscall return value");
  return response;
}

function region(response: KernelSyscallResponse, pointer: number) {
  if (response.kind !== "return") throw new Error("Expected syscall memory regions");
  const found = response.regions.find((candidate) => candidate.pointer === pointer);
  if (!found) throw new Error(`No returned memory region at ${pointer}`);
  return found.bytes;
}

function u32(bytes: Uint8Array, offset = 0) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function expectedStrings(strings: readonly string[]) {
  const encoded = strings.map((value) => encode(`${value}\0`));
  const buffer = new Uint8Array(encoded.reduce((size, value) => size + value.length, 0));
  const pointers = new Uint8Array(strings.length * 4);
  const table = new DataView(pointers.buffer);
  let offset = 0;
  for (const [index, value] of encoded.entries()) {
    table.setUint32(index * 4, 64 + offset, true);
    buffer.set(value, offset);
    offset += value.length;
  }
  return { pointers, buffer };
}

async function withHost<T>(
  run: (filesystem: Fixture["filesystem"], host: SyscallHost) => Promise<T>,
  options: {
    readonly args?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly stdio?: readonly [WasiStdio, WasiStdio, WasiStdio];
  } = {},
) {
  const fixture = createTestFilesystem(options.stdio);
  const host = createKernelSyscallHost({
    filesystem: fixture.filesystem,
    args: options.args ?? [],
    env: options.env ?? {},
    signal: new AbortController().signal,
  });
  try {
    return await run(fixture.filesystem, host);
  } finally {
    host.close();
    fixture.close();
  }
}

describe("createKernelSyscallHost", () => {
  it("cancels a suspended poll and detaches descriptor readiness before close", async () => {
    const subscribed = deferred<void>();
    const detached = deferred<void>();
    const controller = new AbortController();
    const fixture = createTestFilesystem([
      {
        poll(_event, signal) {
          subscribed.resolve();
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                detached.resolve();
                reject(Object.assign(new Error("cancelled"), { code: "ECANCELED" }));
              },
              { once: true },
            );
          });
        },
      },
      {},
      {},
    ]);
    const host = createKernelSyscallHost({
      filesystem: fixture.filesystem,
      args: [],
      env: {},
      signal: controller.signal,
    });
    const subscription = new Uint8Array(48);
    subscription[8] = 1;
    try {
      const pending = host.call({
        name: "poll_oneoff",
        args: [0, 64, 1, 96],
        memorySize: 128,
        regions: [
          { pointer: 0, bytes: subscription },
          { pointer: 64, bytes: new Uint8Array(32) },
          { pointer: 96, bytes: new Uint8Array(4) },
        ],
      });
      await subscribed.promise;
      controller.abort();
      expect(returned(await pending).value).toBe(11);
      await detached.promise;
      host.close();
    } finally {
      controller.abort();
      fixture.close();
    }
  });
  it("shares the open file offset when fd_write follows filesystem I/O", () =>
    withHost(async (filesystem, host) => {
      const fd = filesystem.open("/offset", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR);
      filesystem.write(fd, bytes(0x10, 0x20, 0x30, 0x40), 0n);
      expect(filesystem.read(fd, new Uint8Array(2), null)).toBe(2);
      const response = returned(
        await host.call({
          name: "fd_write",
          args: [fd, 16, 1, 80],
          memorySize: 128,
          regions: [
            { pointer: 16, bytes: iovec(64, 2) },
            { pointer: 64, bytes: bytes(0, 255) },
            { pointer: 80, bytes: new Uint8Array(4) },
          ],
        }),
      );
      expect(response.value).toBe(0);
      expect(u32(region(response, 80))).toBe(2);
      const reader = filesystem.open("/offset", KernelOpenFlags.O_RDONLY);
      const contents = new Uint8Array(4);
      expect(filesystem.read(reader, contents, null)).toBe(4);
      expect(contents).toEqual(bytes(0x10, 0x20, 0, 255));
    }));

  it("reads binary bytes through fd_read without text conversion", () =>
    withHost(async (filesystem, host) => {
      const writer = filesystem.open("/binary", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR);
      filesystem.write(writer, bytes(0, 255, 128, 65), 0n);
      const reader = filesystem.open("/binary", KernelOpenFlags.O_RDONLY);
      const response = returned(
        await host.call({
          name: "fd_read",
          args: [reader, 16, 1, 80],
          memorySize: 128,
          regions: [
            { pointer: 16, bytes: iovec(64, 4) },
            { pointer: 64, bytes: new Uint8Array(4) },
            { pointer: 80, bytes: new Uint8Array(4) },
          ],
        }),
      );
      expect(response.value).toBe(0);
      expect(region(response, 64)).toEqual(bytes(0, 255, 128, 65));
      expect(u32(region(response, 80))).toBe(4);
    }));

  it.each([
    ["fd_write", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDONLY],
    ["fd_read", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY],
  ] as const)("checks descriptor rights before reading %s memory", (name, flags) =>
    withHost(async (filesystem, host) => {
      const fd = filesystem.open("/rights", flags);
      const response = returned(
        await host.call({
          name,
          args: [fd, 0xffff_ffff, 1, 0xffff_ffff],
          memorySize: 0,
          regions: [],
        }),
      );
      expect(response.value).toBe(76);
      expect(response.regions).toEqual([]);
    }),
  );

  it("writes exact argv and environment strings into only the supplied regions", () =>
    withHost(
      async (_filesystem, host) => {
        const argsSize = returned(
          await host.call({
            name: "args_sizes_get",
            args: [0, 4],
            memorySize: 8,
            regions: [{ pointer: 0, bytes: new Uint8Array(8) }],
          }),
        );
        const expectedArgs = expectedStrings(["/bin/demo", "--empty", ""]);
        expect(argsSize.value).toBe(0);
        expect(u32(region(argsSize, 0), 0)).toBe(3);
        expect(u32(region(argsSize, 0), 4)).toBe(expectedArgs.buffer.length);
        const argsResult = returned(
          await host.call({
            name: "args_get",
            args: [16, 64],
            memorySize: 128,
            regions: [
              { pointer: 16, bytes: new Uint8Array(expectedArgs.pointers.length) },
              { pointer: 64, bytes: new Uint8Array(expectedArgs.buffer.length) },
            ],
          }),
        );
        expect(argsResult.value).toBe(0);
        expect(region(argsResult, 16)).toEqual(expectedArgs.pointers);
        expect(region(argsResult, 64)).toEqual(expectedArgs.buffer);

        const envSize = returned(
          await host.call({
            name: "environ_sizes_get",
            args: [0, 4],
            memorySize: 8,
            regions: [{ pointer: 0, bytes: new Uint8Array(8) }],
          }),
        );
        const expectedEnv = expectedStrings(["EMPTY=", "TOKEN=a=b"]);
        expect(envSize.value).toBe(0);
        expect(u32(region(envSize, 0), 0)).toBe(2);
        expect(u32(region(envSize, 0), 4)).toBe(expectedEnv.buffer.length);
        const envResult = returned(
          await host.call({
            name: "environ_get",
            args: [16, 64],
            memorySize: 128,
            regions: [
              { pointer: 16, bytes: new Uint8Array(expectedEnv.pointers.length) },
              { pointer: 64, bytes: new Uint8Array(expectedEnv.buffer.length) },
            ],
          }),
        );
        expect(envResult.value).toBe(0);
        expect(region(envResult, 16)).toEqual(expectedEnv.pointers);
        const envBytes = new Uint8Array(expectedEnv.buffer.length);
        envBytes.set(region(envResult, 64));
        expect(envBytes).toEqual(expectedEnv.buffer);
      },
      { args: ["/bin/demo", "--empty", ""], env: { EMPTY: "", TOKEN: "a=b" } },
    ));

  it("returns proc_exit as a typed process exit", () =>
    withHost(async (_filesystem, host) => {
      await expect(
        host.call({ name: "proc_exit", args: [37], memorySize: 0, regions: [] }),
      ).resolves.toEqual({ kind: "exit", code: 37 });
    }));

  it("rejects overlapping calls and close while a descriptor read is pending", () => {
    const readStarted = deferred<void>();
    const provideInput = deferred<Uint8Array>();
    const stdin: WasiStdio = {
      readInto: async (target) => {
        readStarted.resolve();
        const input = await provideInput.promise;
        target.set(input);
        return input.length;
      },
    };
    const output: WasiStdio = { write: (source) => source.length };
    return withHost(
      async (_filesystem, host) => {
        const request = {
          name: "fd_read",
          args: [0, 16, 1, 80],
          memorySize: 128,
          regions: [
            { pointer: 16, bytes: iovec(64, 1) },
            { pointer: 64, bytes: new Uint8Array(1) },
            { pointer: 80, bytes: new Uint8Array(4) },
          ],
        } as const;
        const pending = host.call(request);
        await readStarted.promise;
        await expect(
          host.call({ name: "proc_exit", args: [0], memorySize: 0, regions: [] }),
        ).rejects.toThrow("already executing");
        expect(() => host.close()).toThrow("still executing");
        provideInput.resolve(bytes(254));
        const response = returned(await pending);
        expect(region(response, 64)).toEqual(bytes(254));
        host.close();
        await expect(
          host.call({ name: "proc_exit", args: [0], memorySize: 0, regions: [] }),
        ).rejects.toThrow("unavailable");
      },
      { stdio: [stdin, output, output] },
    );
  });

  it("uses sparse regions near the 4 GiB memory limit without allocating a guest heap", () =>
    withHost(
      async (_filesystem, host) => {
        const pointer = 0xffff_fff8;
        const response = returned(
          await host.call({
            name: "args_sizes_get",
            args: [pointer, pointer + 4],
            memorySize: 0x1_0000_0000,
            regions: [{ pointer, bytes: new Uint8Array(8) }],
          }),
        );
        expect(response.regions).toHaveLength(1);
        expect(region(response, pointer)).toHaveLength(8);
        expect(u32(region(response, pointer))).toBe(1);
        expect(u32(region(response, pointer), 4)).toBe(11);
      },
      { args: ["/bin/small"] },
    ));
});
