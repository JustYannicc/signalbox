// @effect-diagnostics nodeBuiltinImport:off - Capture native exports in Wrangler's pinned local runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { build } from "esbuild";
import { createTestHarness } from "wrangler";
import type { NodeBuiltinFunctionRequest } from "../../src/harness/NodeBuiltinInventory.ts";
import { COMPATIBILITY_DATE } from "../stage.ts";

const flags = ["legacy_module_registry", "nodejs_compat"];
const hash = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

function readText(object: object, name: string): string {
  const value: unknown = Reflect.get(object, name);
  if (typeof value !== "string" || !value) throw new Error("NODE_BUILTIN_NATIVE_PIN_INVALID");
  return value;
}

/** The Node build process must never stand in for the Worker that supplies native exports. */
export async function captureWorkerdBuiltinInventory(
  requests: readonly NodeBuiltinFunctionRequest[],
) {
  if (process.env.MINIFLARE_WORKERD_PATH) throw new Error("NODE_BUILTIN_NATIVE_BINARY_OVERRIDE");
  const require = NodeModule.createRequire(new URL("../../package.json", import.meta.url));
  const wranglerPath = require.resolve("wrangler/package.json");
  const wranglerRequire = NodeModule.createRequire(wranglerPath);
  const native: object = wranglerRequire("workerd");
  const binaryPath = await NodeFSP.realpath(readText(native, "default"));
  const binarySha256 = hash(await NodeFSP.readFile(binaryPath));
  const version = readText(native, "version");
  const wranglerVersion = readText(
    JSON.parse(await NodeFSP.readFile(wranglerPath, "utf8")),
    "version",
  );
  const profile = {
    runtime: "workerd",
    workerdVersion: version,
    nodeCompatibilityRevision: `workerd-nodejs-compat@${version}`,
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: flags,
  };
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "builtin-workerd-"));
  const harness = createTestHarness();
  let result: unknown;
  try {
    const entry = NodeURL.fileURLToPath(new URL("./runtimeBuiltinInventory.ts", import.meta.url));
    await build({
      stdin: {
        contents: `import process from "node:process";
import {captureRuntimeBuiltinInventory} from ${JSON.stringify(entry)};
export default {async fetch(){
  const inventory = await captureRuntimeBuiltinInventory(${JSON.stringify(requests)}, ${JSON.stringify(profile)});
  return Response.json({modules:Object.keys(inventory.modules).sort(),functions:inventory.functions,
    profile:inventory.profile,observedNodeVersion:process.versions.node});
}};`,
        resolveDir: directory,
      },
      outfile: NodePath.join(directory, "worker.js"),
      bundle: true,
      format: "esm",
      platform: "browser",
      external: ["node:*", "cloudflare:*"],
      define: { "import.meta.main": "false" },
    });
    const configPath = NodePath.join(directory, "wrangler.json");
    await NodeFSP.writeFile(
      configPath,
      JSON.stringify({
        name: "signalbox-builtin-inventory",
        main: "worker.js",
        no_bundle: true,
        compatibility_date: COMPATIBILITY_DATE,
        compatibility_flags: flags,
      }),
    );
    await harness.update({ workers: [{ configPath }] });
    await harness.listen();
    const response = await harness.fetch("/");
    if (response.status !== 200)
      throw new Error(`NODE_BUILTIN_NATIVE_CAPTURE_FAILED: ${await response.text()}`);
    result = await response.json();
    if (hash(await NodeFSP.readFile(binaryPath)) !== binarySha256)
      throw new Error("NODE_BUILTIN_NATIVE_BINARY_CHANGED");
  } finally {
    try {
      await harness.close();
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  }
  if (typeof result !== "object" || result === null)
    throw new Error("NODE_BUILTIN_NATIVE_CAPTURE_INVALID");
  return {
    ...result,
    capture: {
      wranglerVersion,
      workerdBinarySha256: binarySha256,
      observedNodeVersion: Reflect.get(result, "observedNodeVersion"),
      runtimeClosed: true,
    },
  };
}
