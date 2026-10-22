import {
  ABI_VERSION,
  KernelProgramRegistry,
  KernelWakeRegistry,
  callKernel,
  type KernelHandle,
} from "../KernelAbi.ts";
import { createFacetSqliteStorage } from "../FacetSqliteStorage.ts";
import { KernelFileSystem } from "../KernelFileSystem.ts";
import {
  KernelProgramHost,
  type KernelPipedProgram,
  type KernelProgramBinding,
} from "../KernelProgramHost.ts";
import { sqliteFixture } from "./sqliteFixture.ts";

const now = () => 1_800_000_000_000_000_001n;
export const bytes = (value: string) => new TextEncoder().encode(value);

export function setup(
  implementation: KernelProgramBinding["implementation"],
  wakes = new KernelWakeRegistry(),
) {
  const fixture = sqliteFixture();
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage: createFacetSqliteStorage(fixture.storage, now) }],
  });
  const registry = new KernelProgramRegistry();
  const manifest = {
    name: "tool",
    version: "1",
    abiVersion: ABI_VERSION,
    requiredCapabilities: ["process.wait"] as const,
    entrypoint: "tool",
  };
  if (registry.register(manifest).status !== "ok") throw new Error("Program registration failed");
  const host = new KernelProgramHost({
    registry,
    wakes,
    programs: new Map([["/bin/tool", { manifest, implementation } satisfies KernelProgramBinding]]),
  });

  return {
    host,
    filesystem,
    wakes,
    fixture,
    async close(piped?: KernelPipedProgram) {
      await piped?.prepared.release();
      await host.processes.dispose();
      filesystem.dispose();
      fixture.close();
      wakes.dispose();
    },
  };
}

export function spawn(host: KernelProgramHost, piped: KernelPipedProgram): KernelHandle<"process"> {
  const program = host.resolve("/bin/tool");
  if (program.status !== "ok") throw new Error("Program resolution failed");
  const result = callKernel(host.backend(piped.prepared), "process.spawn", {
    program: program.value,
    args: [],
    env: {},
  });
  if (result.status !== "ok") throw new Error("Program admission failed");
  return result.value;
}

export async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
      length += result.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function wasmFdReadWriteCommand(readLength: number): WebAssembly.Module {
  const body = [
    0, 0x41, 0, 0x41, 0, 0x41, 1, 0x41, 8, 0x10, 0, 0x04, 0x40, 0x41, 17, 0x10, 2, 0x00, 0x0b, 0x41,
    1, 0x41, 0, 0x41, 1, 0x41, 12, 0x10, 1, 0x04, 0x40, 0x41, 18, 0x10, 2, 0x00, 0x0b, 0x0b,
  ];
  const memory = new Uint8Array(16 + readLength);
  const view = new DataView(memory.buffer);
  view.setUint32(0, 16, true);
  view.setUint32(4, readLength, true);
  const data = [0, 0x41, 0, 0x0b, ...leb(memory.byteLength), ...memory];

  return new WebAssembly.Module(
    new Uint8Array([
      0,
      0x61,
      0x73,
      0x6d,
      1,
      0,
      0,
      0,
      ...section(1, [3, 0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f, 0x60, 1, 0x7f, 0, 0x60, 0, 0]),
      ...section(2, [
        3,
        ...name("wasi_snapshot_preview1"),
        ...name("fd_read"),
        0,
        0,
        ...name("wasi_snapshot_preview1"),
        ...name("fd_write"),
        0,
        0,
        ...name("wasi_snapshot_preview1"),
        ...name("proc_exit"),
        0,
        1,
      ]),
      ...section(3, [1, 2]),
      ...section(5, [1, 0, 1]),
      ...section(7, [2, ...name("memory"), 2, 0, ...name("_start"), 0, 3]),
      ...section(10, [1, ...leb(body.length), ...body]),
      ...section(11, [1, ...data]),
    ]),
  );
}

function section(id: number, content: readonly number[]): number[] {
  return [id, ...leb(content.length), ...content];
}

function name(value: string): number[] {
  const encoded = [...new TextEncoder().encode(value)];
  return [...leb(encoded.length), ...encoded];
}

function leb(value: number): number[] {
  const encoded: number[] = [];
  for (;;) {
    const byte = value & 0x7f;
    value >>>= 7;
    encoded.push(byte | (value === 0 ? 0 : 0x80));
    if (value === 0) return encoded;
  }
}
