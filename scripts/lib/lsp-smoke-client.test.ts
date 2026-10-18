// @effect-diagnostics nodeBuiltinImport:off - Exercise the probe against an owned fixture subprocess.
import * as NodeURL from "node:url";
import * as NodePerfHooks from "node:perf_hooks";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, test } from "vite-plus/test";
import { LspSmokeClient } from "./lsp-smoke-client.ts";

function spawnServer(mode: string) {
  return LspSmokeClient.spawn(
    process.execPath,
    [NodeURL.fileURLToPath(new URL("./fixtures/lsp-shutdown-server.mjs", import.meta.url)), mode],
    process.cwd(),
    HostProcess.Platform.defaultValue(),
    NodePerfHooks.performance.now() + 10_000,
  );
}

test.each(["0", "1", "7"])(
  "completed probes tolerate late requests and acknowledged exit %s",
  async (code) => {
    const client = spawnServer(code);
    try {
      expect(await client.request("textDocument/diagnostic", {})).toBe("textDocument/diagnostic");
      expect(await client.request("textDocument/definition", {})).toBe("textDocument/definition");
      expect(await client.shutdown()).toMatchObject({
        code: Number(code),
        error: null,
        forcedTermination: false,
        responseReceived: true,
        signal: null,
      });
      expect(client.protocolTrace()).toContain(
        "server request client/registerCapability id=same-chunk",
      );
      expect(client.protocolTrace()).toContain(
        "server request client/registerCapability id=after-exit",
      );
      expect(client.stderr()).not.toContain("unexpected late response");
    } finally {
      await client.terminate();
    }
  },
);

test.each(["missing-ack", "error-ack"])(
  "shutdown fails for %s even with exit zero",
  async (mode) => {
    const client = spawnServer(mode);
    try {
      const result = await client.shutdown();
      expect(result.responseReceived).toBe(false);
      expect(result.error).toBeTruthy();
      expect(result.forcedTermination).toBe(mode === "error-ack");
    } finally {
      await client.terminate();
    }
  },
);

test.each(["signal", "malformed", "panic", "fatal", "rust-panic", "rust-panic-thread-id"])(
  "shutdown fails for %s after acknowledgement",
  async (mode) => {
    const client = spawnServer(mode);
    try {
      const result = await client.shutdown();
      expect(result.responseReceived).toBe(true);
      expect(result.error).toBeTruthy();
    } finally {
      await client.terminate();
    }
  },
);
