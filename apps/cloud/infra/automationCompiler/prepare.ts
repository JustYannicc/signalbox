// @effect-diagnostics nodeBuiltinImport:off - build tooling reads published compiler assets, never runtime userdata.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { build } from "esbuild";

const cloud = NodePath.resolve(import.meta.dirname, "../..");
const output = NodePath.join(cloud, ".generated/automation-compiler");
const requireCompiler = NodeModule.createRequire(
  import.meta.resolve("@signalbox/automation-compiler/workerdParser"),
);

/** Build product modules from shared phases and first-party OXC assets, without checking binaries in. */
export async function prepareAutomationCompiler() {
  await NodeFSP.mkdir(output, { recursive: true });
  const ids: Record<string, string> = {};
  for (const [phase, oxc] of [
    ["parser", "oxc-parser"],
    ["transformer", "oxc-transform"],
  ] as const) {
    const result = await build({
      entryPoints: [NodePath.join(cloud, `src/automations/compiler/${phase}Worker.ts`)],
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2023",
      conditions: ["workerd", "import"],
      external: ["cloudflare:workers", "./oxc.wasm"],
      minify: true,
      write: false,
    });
    const code = result.outputFiles[0]!.contents;
    const wasm = await NodeFSP.readFile(
      requireCompiler.resolve(`@${oxc}/binding-wasm32-wasip1/wasm`),
    );
    ids[phase] = NodeCrypto.createHash("sha256").update(code).update(wasm).digest("hex");
    await NodeFSP.writeFile(NodePath.join(output, `${phase}.txt`), code);
    // The parent imports raw bytes, never a compiled WASM module or an instantiated memory.
    await NodeFSP.writeFile(NodePath.join(output, `${phase}.bin`), wasm);
  }
  await NodeFSP.writeFile(NodePath.join(output, "ids.json"), JSON.stringify(ids));
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  await prepareAutomationCompiler();
}
