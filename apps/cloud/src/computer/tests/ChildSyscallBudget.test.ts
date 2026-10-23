// @effect-diagnostics nodeBuiltinImport:off - a fresh process excludes Vitest's buffers from the memory bound.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeUtil from "node:util";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";

let directory: string;
let probe: string;

beforeAll(async () => {
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "1383-payload-"));
  probe = NodePath.join(directory, "probe.mjs");
  await build({
    entryPoints: [NodePath.join(import.meta.dirname, "ChildSyscallBudgetProbe.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "esnext",
    outfile: probe,
  });
});

afterAll(async () => {
  if (directory) await NodeFSP.rm(directory, { recursive: true, force: true });
});

it.each([
  [8, "write"],
  [32, "write"],
  [8, "read"],
  [32, "read"],
] as const)(
  "bounds %i concurrent 16 MiB %ss before they reach the owner",
  async (count, direction) => {
    const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(
      NodeProcess.execPath,
      ["--expose-gc", "--experimental-wasm-jspi", probe, String(count), direction],
      { timeout: 30_000 },
    );
    expect(JSON.parse(stdout)).toMatchObject({ count, direction });
  },
);
