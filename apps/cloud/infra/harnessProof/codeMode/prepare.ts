// @effect-diagnostics nodeBuiltinImport:off - local packaging of the isolated cell bootstrap.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { build } from "esbuild";
import type { CodeModeCellCode } from "../../../src/harness/CodeModeHost.ts";

const upstreamCommit = "092d3acd6bec3e3a14bdc7e7a2810ab628ab759d";

export async function prepareCodeModeHost(options: { readonly cloudRoot?: string } = {}) {
  const root = options.cloudRoot ?? NodePath.resolve(import.meta.dirname, "../../..");
  const settledPath = NodePath.join(root, "src/harness/codeMode/upstreamSettled.js");
  const settled = await NodeFSP.readFile(settledPath);
  const settledSha256 = digest(settled);
  if (settledSha256 !== "6b0d0b56aecf2101ca0d7f50b71d733430f703deb7bf3b71b54364c60cce4f65")
    throw new Error("CodeMode settlement helpers differ from pinned official 0.162.1");
  const bundle = await build({
    absWorkingDir: root,
    entryPoints: ["src/harness/codeMode/worker.ts"],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2024",
    external: ["cloudflare:workers", "./__code_mode_evaluation.js", "./upstreamSettled.js"],
    write: false,
    metafile: true,
    sourcemap: false,
  });
  const javascript = bundle.outputFiles[0]!.text;
  const code: CodeModeCellCode = Object.freeze({
    mainModule: "main.js",
    modules: Object.freeze({
      "main.js": Object.freeze({ js: javascript }),
      "upstreamSettled.js": Object.freeze({ js: settled.toString("utf8") }),
    }),
  });
  const privateFiles = (await NodeFSP.readdir(NodePath.join(root, "src/harness/codeMode"))).filter(
    (file) => /\.(?:ts|js)$/.test(file),
  );
  const sourcePaths = [
    ...Object.keys(bundle.metafile.inputs),
    ...privateFiles.map((file) => `src/harness/codeMode/${file}`),
    "infra/harnessProof/codeMode/prepare.ts",
    "infra/harnessProof/codeMode/CellService.ts",
    "src/harness/CodeModeHost.ts",
  ];
  const sources = await Promise.all(
    [...new Set(sourcePaths)].sort().map(async (path) => {
      const bytes = await NodeFSP.readFile(NodePath.join(root, path));
      return { path, bytes: bytes.length, sha256: digest(bytes) };
    }),
  );
  // This identifies a registered JS program. The kernel dispatches its binding, never these bytes as WASM.
  const executableBytes = new TextEncoder().encode(
    `signalbox-registered-program\ncodex-code-mode-host\n0.162.1-workerd-port.1\n${digest(new TextEncoder().encode(javascript))}\n`,
  );
  return {
    code,
    executable: {
      path: "/bin/codex-code-mode-host" as const,
      bytes: executableBytes,
      sha256: digest(executableBytes),
    },
    inventory: {
      format: "signalbox-code-mode-host-v1",
      upstreamVersion: "0.162.1",
      upstreamCommit,
      runtime: "workerd-semantics-port",
      settledSha256,
      sources,
      bootstrap: {
        bytes: new TextEncoder().encode(javascript).length,
        sha256: digest(new TextEncoder().encode(javascript)),
      },
    },
  };
}

function digest(bytes: Uint8Array) {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}
