import { expect } from "vite-plus/test";
import { KernelDescriptors } from "../../kernel/KernelDescriptors.ts";
import { KernelWebSocketHost } from "../../kernel/KernelWebSocketHost.ts";
import type { KernelWebSocketRouteResult } from "../../kernel/KernelWebSocketHost.ts";
import type { createCodexLocaleProductComputer } from "./CodexLocaleProductComputerFixture.ts";

export async function openExecConnection(
  fixture: ReturnType<typeof createCodexLocaleProductComputer>,
) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const routed = Promise.withResolvers<AbortSignal>();
  const response = Promise.withResolvers<KernelWebSocketRouteResult>();
  const host = new KernelWebSocketHost({
    memory: () => memory,
    descriptors: new KernelDescriptors(fixture.filesystem.descriptors, fixture.computer.host.wakes),
    route({ signal }) {
      routed.resolve(signal);
      return response.promise;
    },
  });
  const url = new TextEncoder().encode("ws://exec.invalid/session");
  const view = new DataView(memory.buffer);
  view.setUint32(0, 1, true);
  view.setUint32(4, 1024, true);
  view.setUint32(8, 4096, true);
  view.setUint32(12, url.byteLength, true);
  new Uint8Array(memory.buffer, 16, url.byteLength).set(url);
  view.setUint32(16 + url.byteLength, 0, true);
  expect(host.imports.ws_open(0, 20 + url.byteLength, 4096)).toBe(0);
  const fd = view.getUint32(4096, true);
  const signal = await routed.promise;
  return {
    fd,
    signal,
    close() {
      expect(host.imports.ws_drop(fd)).toBe(0);
      response.resolve({ status: 503, headers: [] });
      expect(signal.aborted).toBe(true);
    },
  };
}
