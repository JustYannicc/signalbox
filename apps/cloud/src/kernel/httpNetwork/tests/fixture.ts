import { expect } from "vite-plus/test";
import { KernelHttpNetworkHost } from "../../KernelHttpNetworkHost.ts";
import { KernelDescriptors, type KernelDescriptorResource } from "../../KernelDescriptors.ts";
import { KernelFileSystem } from "../../KernelFileSystem.ts";
import { KernelWakeRegistry } from "../../KernelWakeRegistry.ts";

export const ADDRESS = 128;
export const DATA = 2048;
export const OUTPUT = 64 * 1024;
const encoder = new TextEncoder();
export const decoder = new TextDecoder();

export function fixture(
  fetch: (request: Request) => Promise<Response> = async () => new Response("ok"),
) {
  const memory = new WebAssembly.Memory({ initial: 4 });
  const filesystem = new KernelFileSystem({ mounts: [] });
  const wakes = new KernelWakeRegistry();
  const descriptors = new KernelDescriptors(filesystem.descriptors, wakes);
  const abort = new AbortController();
  const host = new KernelHttpNetworkHost({
    memory: () => memory,
    descriptors,
    fetch,
    signal: abort.signal,
  });
  const imports = host.imports;
  const write = (pointer: number, value: Uint8Array | string) => {
    const bytes = typeof value === "string" ? encoder.encode(value) : value;
    new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes);
    return bytes.length;
  };
  const u32 = (pointer: number) => new DataView(memory.buffer).getUint32(pointer, true);
  const open = (target = "api.example:80") => {
    expect(imports.net_socket(1, 6, 0, 16)).toBe(0);
    const fd = u32(16);
    expect(imports.net_connect(fd, ADDRESS, write(ADDRESS, target))).toBe(0);
    return fd;
  };
  const send = (fd: number, bytes: Uint8Array | string) => {
    const length = write(DATA, bytes);
    const result = imports.net_send(fd, DATA, length, 0, 20);
    if (result === 0) expect(u32(20)).toBe(length);
    return result;
  };
  const receive = async (fd: number, capacity = 997) => {
    const chunks: Uint8Array[] = [];
    for (;;) {
      const status = imports.net_recv(fd, OUTPUT, capacity, 0, 24);
      if (status === 6) {
        await readable(descriptors.resource(fd));
        continue;
      }
      if (status !== 0) throw Object.assign(new Error("Receive failed"), { errno: status });
      const size = u32(24);
      if (size === 0) return concat(chunks);
      chunks.push(new Uint8Array(memory.buffer, OUTPUT, size).slice());
    }
  };
  const close = async () => {
    await host.dispose();
    filesystem.dispose();
    wakes.dispose();
  };
  return {
    memory,
    filesystem,
    wakes,
    descriptors,
    abort,
    host,
    imports,
    write,
    u32,
    open,
    send,
    receive,
    close,
  };
}

export function readable(resource: KernelDescriptorResource, minimum = 0n): Promise<void> {
  const ready = () => {
    const value = resource.ready("read");
    return value !== undefined && (value.hangup === true || value.bytes > minimum);
  };
  if (ready()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let unsubscribe: () => void = () => undefined;
    const notify = () => {
      if (ready()) {
        unsubscribe();
        resolve();
      }
    };
    unsubscribe = resource.subscribe("read", notify);
    notify();
  });
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, bytes) => total + bytes.length, 0));
  let offset = 0;
  for (const bytes of chunks) {
    result.set(bytes, offset);
    offset += bytes.length;
  }
  return result;
}
