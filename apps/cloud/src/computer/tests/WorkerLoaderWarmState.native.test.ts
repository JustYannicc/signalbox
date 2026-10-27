// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - verifies actual WorkerLoader reuse and invocation-owned WASI state in workerd.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { build } from "esbuild";
import { createTestHarness } from "wrangler";
import {
  warmStateHost,
  warmStateWasm,
  type WarmStateResult,
} from "./WorkerLoaderWarmStateFixture.ts";

let harness: ReturnType<typeof createTestHarness> | undefined;
let endpoint: URL;
let directory: string;

beforeAll(async () => {
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "1263-warm-state-"));
  const childWasi = await build({
    entryPoints: [NodePath.resolve(import.meta.dirname, "../ChildWasi.ts")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "esnext",
    write: false,
  });
  const bytes = warmStateWasm();
  if (!WebAssembly.validate(bytes)) throw new Error("Invalid warm WASM fixture");
  const hash = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  await NodeFSP.writeFile(NodePath.join(directory, "counter.wasm"), bytes);
  await build({
    stdin: {
      contents: warmStateHost(childWasi.outputFiles[0]!.text, hash),
      resolveDir: NodePath.resolve(import.meta.dirname, "../../.."),
      sourcefile: "warm-state-host.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "esnext",
    external: ["cloudflare:workers", "node:*", "./counter.wasm"],
    outfile: NodePath.join(directory, "host.js"),
  });
  const configPath = NodePath.join(directory, "wrangler.jsonc");
  await NodeFSP.writeFile(
    configPath,
    JSON.stringify({
      name: "1263-warm-child-state",
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

describe("actual warm child isolation", () => {
  it.each(["direct", "registry"])(
    "gives concurrent slot leases distinct physical isolates through %s loading",
    async (kind) => {
      const response = await fetch(new URL(`/?kind=${kind}&concurrent`, endpoint));
      const body = await response.text();
      expect(response.status, body).toBe(200);
      const result = JSON.parse(body) as WarmStateResult;
      expect(result.observations).toHaveLength(2);
      expect(result.observations[0]?.isolate).toBeTruthy();
      expect(result.observations[1]?.isolate).not.toBe(result.observations[0]?.isolate);
      expect(result.observations.map(({ calls }) => calls)).toEqual([1, 1]);
      expect(result.stdout).toEqual(["1", "1"]);
      expect(result.active).toBe(0);
    },
  );

  it.each(["direct", "registry"])(
    "keeps WASI state and host capabilities per call through %s loading",
    async (kind) => {
      const response = await fetch(new URL(`/?kind=${kind}`, endpoint));
      const body = await response.text();
      expect(response.status, body).toBe(200);
      const result = JSON.parse(body) as WarmStateResult;
      expect(result.observations).toHaveLength(2);
      const [first, second] = result.observations;
      expect(first?.isolate).toBeTruthy();
      expect(second?.isolate).toBe(first?.isolate);
      expect(result.observations.map(({ calls }) => calls)).toEqual([1, 2]);
      expect(
        result.observations.map(({ previous, memoryBefore }) => [previous, memoryBefore]),
      ).toEqual([
        [null, 0],
        [null, 0],
      ]);
      expect(result.observations.map(({ args }) => args)).toEqual([
        ["first", "雪"],
        ["second", "雪"],
      ]);
      expect(result.observations.map(({ env }) => env)).toEqual([
        ["PRIVATE=one", "PWD=/"],
        ["PRIVATE=two", "PWD=/"],
      ]);
      expect(
        result.observations.map(({ stdinStat, stdinClose }) => [stdinStat, stdinClose]),
      ).toEqual([
        [0, 0],
        [0, 0],
      ]);
      expect(result.stdout).toEqual(["1", "1"]);
      expect(result.active).toBe(0);
    },
  );
});
