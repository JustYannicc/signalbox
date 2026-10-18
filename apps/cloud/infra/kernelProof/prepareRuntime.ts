// @effect-diagnostics nodeBuiltinImport:off - build-time static module preparation, never guest runtime compilation.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";

const RG_SHA256 = "9205b5dc7fb83d65cacc8f0ded8388d7c4a85baed6367689152307e818497a72";

export async function prepareKernelRuntimeProof(destination: string, ripgrepPath: string) {
  const root = NodeURL.fileURLToPath(new URL("../../src/kernel/", import.meta.url));
  await NodeFSP.mkdir(destination, { recursive: true });
  const modules: Record<string, { path: string; type: "js" | "wasm" }> = {};
  for (const path of await NodeFSP.readdir(root, { recursive: true })) {
    if (
      !path.endsWith(".ts") ||
      path.endsWith(".test.ts") ||
      path.startsWith("tests/") ||
      (!path.includes("/") && path.endsWith("Proof.ts") && path !== "KernelRuntimeProof.ts")
    )
      continue;
    const source = await NodeFSP.readFile(NodePath.join(root, path), "utf8");
    const js = NodeModule.stripTypeScriptTypes(source, { mode: "strip" }).replaceAll(
      /(from "\.[^"]+)\.ts"/g,
      '$1.js"',
    );
    const name = path.replace(/\.ts$/, ".js");
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(destination, name)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(destination, name), js);
    modules[name] = { path: name, type: "js" };
  }
  const rg = await NodeFSP.readFile(ripgrepPath);
  if (NodeCrypto.createHash("sha256").update(rg).digest("hex") !== RG_SHA256)
    throw new Error("Ripgrep artifact does not match its pin");
  await NodeFSP.writeFile(NodePath.join(destination, "rg.wasm"), rg);
  await NodeFSP.writeFile(NodePath.join(destination, "poll.wasm"), pollReactor());
  modules["rg.wasm"] = { path: "rg.wasm", type: "wasm" };
  modules["poll.wasm"] = { path: "poll.wasm", type: "wasm" };
  const main = `import { DurableObject } from 'cloudflare:workers';
import reactor from './poll.wasm';
import rg from './rg.wasm';
import { createFacetSqliteStorage } from './FacetSqliteStorage.js';
import { runKernelRuntimeProof } from './KernelRuntimeProof.js';
export class KernelRuntimeProofFacet extends DurableObject {
  async fetch() {
    try {
      const storage = createFacetSqliteStorage(this.ctx.storage, () => BigInt(Date.now()) * 1000000n);
      return Response.json(await runKernelRuntimeProof(storage, reactor, rg));
    } catch (error) { return Response.json({ok:false,error:String(error)}); }
  }
}`;
  await NodeFSP.writeFile(NodePath.join(destination, "main.js"), main);
  modules["main.js"] = { path: "main.js", type: "js" };
  await NodeFSP.writeFile(
    NodePath.join(destination, "manifest.json"),
    JSON.stringify(
      {
        id: "kernel-runtime-v1",
        mainModule: "main.js",
        entrypoint: "KernelRuntimeProofFacet",
        mode: "facet",
        modules,
        paths: ["/proof", "/proof-again"],
      },
      null,
      2,
    ),
  );
}

function unsignedLeb(value: number): number[] {
  const bytes: number[] = [];
  do {
    const next = value & 0x7f;
    value >>>= 7;
    bytes.push(next | (value > 0 ? 0x80 : 0));
  } while (value > 0);
  return bytes;
}

function wasmName(value: string) {
  const bytes = Array.from(new TextEncoder().encode(value));
  return [...unsignedLeb(bytes.length), ...bytes];
}

function section(id: number, bytes: number[]) {
  return [id, ...unsignedLeb(bytes.length), ...bytes];
}

function pollReactor() {
  // (func (export "run") (param i32 i32 i32 i32) (result i32)
  //   local.get 0 local.get 1 local.get 2 local.get 3 call $poll_oneoff)
  const body = [0, 0x20, 0, 0x20, 1, 0x20, 2, 0x20, 3, 0x10, 0, 0x0b];
  return new Uint8Array([
    0,
    0x61,
    0x73,
    0x6d,
    1,
    0,
    0,
    0,
    ...section(1, [1, 0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f]),
    ...section(2, [1, ...wasmName("wasi_snapshot_preview1"), ...wasmName("poll_oneoff"), 0, 0]),
    ...section(3, [1, 0]),
    ...section(5, [1, 0, 1]),
    ...section(7, [2, ...wasmName("memory"), 2, 0, ...wasmName("run"), 0, 1]),
    ...section(10, [1, ...unsignedLeb(body.length), ...body]),
  ]);
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  const ripgrep = process.argv[3];
  if (!destination || !ripgrep)
    throw new Error("Pass a fixture directory and pinned ripgrep wasm path");
  await prepareKernelRuntimeProof(NodePath.resolve(destination), NodePath.resolve(ripgrep));
}
