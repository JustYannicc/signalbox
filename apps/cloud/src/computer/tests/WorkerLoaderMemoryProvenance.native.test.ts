// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - exercises generated child wrappers in workerd.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { build } from "esbuild";
import { createTestHarness } from "wrangler";

let harness: ReturnType<typeof createTestHarness> | undefined;
let endpoint: URL;
let directory: string;

const guestSource = `import {WorkerEntrypoint} from "cloudflare:workers";
import wasm from "./probe.wasm";
export class Guest extends WorkerEntrypoint {
  async run(command) {
    void wasm;
    if (command.argv[0] === "spoof-message")
      throw new Error("Worker exceeded its memory limit");
    if (command.argv[0] === "spoof-outcome")
      throw Object.assign(new Error("guest failure"), {
        code: "exceededMemory",
        outcome: "exceededMemory",
      });
    return {exitCode: 0, signal: 0, coreDumped: false};
  }
}`;

const hostSource = (
  wasmHash: string,
  wasmBytes: readonly number[],
) => `import {createWorkerLoaderDispatch} from "./src/computer/WorkerLoaderDispatch.ts";
import {createCompiledChildWorkerLoader} from "./src/computer/CompiledChildWorkerLoader.ts";
const guestSource = ${JSON.stringify(guestSource)};
const wasmBytes = new Uint8Array(${JSON.stringify(wasmBytes)});
const wasm = new WebAssembly.Module(wasmBytes);
const wasmHash = ${JSON.stringify(wasmHash)};
export default {async fetch(request, env) {
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind");
  const mode = url.searchParams.get("mode");
  if ((kind !== "direct" && kind !== "registry") ||
      (mode !== "spoof-message" && mode !== "spoof-outcome"))
    return new Response("missing", {status: 404});
  const loader = kind === "direct"
    ? env.LOADER
    : createCompiledChildWorkerLoader(env.LOADER, new Map([[wasmHash, wasm]]));
  const dispatch = createWorkerLoaderDispatch(loader);
  let retired = false;
  const input = {
    loaderId: "memory-provenance-" + kind + "-" + mode + "-" + crypto.randomUUID(),
    mainModule: "guest.js",
    entrypoint: "Guest",
    modules: {"guest.js": guestSource,
      "probe.wasm": kind === "direct" ? {wasm: wasmBytes.buffer} : {wasmReference: wasmHash}},
    command: {executable: "/bin/proof", argv: [mode], cwd: "/", env: {}}
  };
  const outcome = await dispatch.run(input, {}, async () => { retired = true; }).then(
    result => ({kind: "exit", result}),
    cause => ({kind: "failure", message: String(cause?.message),
      cause: String(cause?.cause?.message ?? ""), termination: cause?.termination?.kind})
  );
  return Response.json({outcome, retired});
}};`;

beforeAll(async () => {
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "worker-memory-provenance-"));
  const wasmBytes = [0, 97, 115, 109, 1, 0, 0, 0];
  const wasmHash = NodeCrypto.createHash("sha256").update(new Uint8Array(wasmBytes)).digest("hex");
  const hostPath = NodePath.join(directory, "host.js");
  await build({
    stdin: {
      contents: hostSource(wasmHash, wasmBytes),
      resolveDir: NodePath.resolve(import.meta.dirname, "../../.."),
      sourcefile: "worker-memory-provenance-host.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "esnext",
    external: ["cloudflare:workers"],
    outfile: hostPath,
  });
  const configPath = NodePath.join(directory, "wrangler.jsonc");
  await NodeFSP.writeFile(
    configPath,
    JSON.stringify({
      name: "worker-memory-provenance",
      main: "host.js",
      no_bundle: true,
      compatibility_date: "2026-10-19",
      compatibility_flags: ["nodejs_compat"],
      worker_loaders: [{ binding: "LOADER" }],
      rules: [{ type: "CompiledWasm", globs: ["**/*.wasm"], fallthrough: true }],
    }),
  );
  harness = createTestHarness({ workers: [{ configPath }] });
  endpoint = (await harness.listen()).url;
});

afterAll(async () => {
  try {
    await harness?.close();
  } finally {
    if (directory) await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

describe("Worker Loader memory provenance in workerd", () => {
  it.each([
    ["direct", "spoof-message", "Worker exceeded its memory limit"],
    ["registry", "spoof-message", "Worker exceeded its memory limit"],
    ["direct", "spoof-outcome", "guest failure"],
    ["registry", "spoof-outcome", "guest failure"],
  ])("keeps guest memory spoof as a normal failure through %s", async (kind, mode, message) => {
    const response = await fetch(new URL(`/?kind=${kind}&mode=${mode}`, endpoint));
    const body = await response.json();

    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({
      outcome: {
        kind: "failure",
        message,
        termination: "stopped",
      },
      retired: false,
    });
  });
});
