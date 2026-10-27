// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - checks the pinned module in local workerd.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";
import { KERNEL_UGREP_ARTIFACT } from "../../kernel/KernelUgrepProgram.ts";

const artifact =
  NodeProcess.env.SIGNALBOX_UGREP_ARTIFACT ??
  NodePath.resolve(import.meta.dirname, "../../../../../.t3/1071/programs/ugrep.wasm");
const available = NodeFS.existsSync(artifact);
if (!available && NodeProcess.env.SIGNALBOX_REQUIRE_UGREP_ARTIFACT === "1")
  throw new Error("The workerd ugrep test requires the pinned WASI artifact");
let harness: ReturnType<typeof createTestHarness> | undefined;
let directory: string;
let endpoint: URL;

beforeAll(async () => {
  const bytes = await NodeFSP.readFile(artifact);
  if (
    bytes.length !== KERNEL_UGREP_ARTIFACT.bytes ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== KERNEL_UGREP_ARTIFACT.sha256
  )
    throw new Error("The local workerd ugrep artifact does not match its pin");
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ugrep-wasi-workerd-"));
  await NodeFSP.writeFile(NodePath.join(directory, "ugrep.wasm"), bytes);
  await build({
    stdin: {
      contents: `import module from "./ugrep.wasm";
import {createChildWasi} from "./src/computer/ChildWasi.ts";
import {KernelFileSystem} from "./src/kernel/KernelFileSystem.ts";
import {createKernelSyscallHost} from "./src/kernel/KernelSyscallHost.ts";
export default {async fetch(request) {
  const {args,input}=await request.json(),stdout=[],stderr=[];
  const bytes=new TextEncoder().encode(input);let offset=0;
  const filesystem=new KernelFileSystem({mounts:[],stdio:[
    {filetype:"unknown",readInto:target=>{const chunk=bytes.subarray(offset,offset+target.length);target.set(chunk);offset+=chunk.length;return chunk.length;}},
    {filetype:"unknown",write:bytes=>{stdout.push(bytes.slice());return bytes.length;}},
    {filetype:"unknown",write:bytes=>{stderr.push(bytes.slice());return bytes.length;}}
  ]});
  const owner=createKernelSyscallHost({filesystem,args,env:{LC_ALL:"C.UTF-8"},signal:new AbortController().signal});
  try {
    const wasi=createChildWasi({module,syscalls:owner,args,env:{LC_ALL:"C.UTF-8"}});
    const instance=new WebAssembly.Instance(module,wasi.imports);wasi.bind(instance);
    const status=await wasi.startProcess(instance);
    const text=chunks=>{const decoder=new TextDecoder();return chunks.map(bytes=>decoder.decode(bytes,{stream:true})).join("")+decoder.decode();};
    return Response.json({status,stdout:text(stdout),stderr:text(stderr)});
  } finally {owner.close();filesystem.dispose();}
}};`,
      resolveDir: NodePath.resolve(import.meta.dirname, "../../.."),
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "esnext",
    external: ["cloudflare:workers", "node:*", "./ugrep.wasm"],
    outfile: NodePath.join(directory, "host.js"),
  });
  const configPath = NodePath.join(directory, "wrangler.jsonc");
  await NodeFSP.writeFile(
    configPath,
    JSON.stringify({
      name: "ugrep-wasi-host",
      main: "host.js",
      no_bundle: true,
      compatibility_date: "2026-10-19",
      compatibility_flags: ["nodejs_compat"],
      rules: [{ type: "CompiledWasm", globs: ["**/*.wasm"], fallthrough: true }],
    }),
  );
  harness = createTestHarness({ workers: [{ configPath }] });
  endpoint = (await harness.listen()).url;
}, 60_000);

afterAll(async () => {
  try {
    await harness?.close();
  } finally {
    if (directory) await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

describe.skipIf(!available)("SDK 34 ugrep on the workerd WASI host", () => {
  it.each([
    {
      args: ["ugrep", "-iE", "auth|pool"],
      input: "other\nAUTH 雪\npool\n",
      exitCode: 0,
      stdout: "AUTH 雪\npool\n",
    },
    { args: ["ugrep", "-E", "absent"], input: "other\n", exitCode: 1, stdout: "" },
    { args: ["ugrep", "-E", "["], input: "other\n", exitCode: 2, stdout: "" },
  ])("returns $exitCode for $args", async ({ args, input, exitCode, stdout }) => {
    const response = await fetch(endpoint, {
      method: "POST",
      body: JSON.stringify({ args, input }),
    });
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const result: unknown = JSON.parse(body);
    expect(result).toEqual({
      status: { exitCode, signal: 0, coreDumped: false },
      stdout,
      stderr: exitCode === 2 ? expect.stringContaining("mismatched [ ]") : "",
    });
  });
});
