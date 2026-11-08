// @effect-diagnostics nodeBuiltinImport:off - downloads immutable native proof artifacts.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

// The unchanged builder at this commit reproduced all four files byte for byte.
export const CODEX_WASI_RELEASE = {
  sourceCommit: "a0ac280c4229c63c1033299135e29a0925b754dc",
  url: "https://github.com/JustYannicc/signalbox/releases/download/kernel-programs-20261108-codex-7645a1c9",
  files: {
    "manifest.json": {
      bytes: 10_634,
      sha256: "6b4c0910d4cea934fb42b11786afc6f95758ec48921c5fde812f3d20d4757539",
    },
    "engine.wasm": {
      bytes: 58_788_196,
      sha256: "7645a1c99899d57ea3736f23b4cd1d71691fa9cbbdc0787fd244ca6f2c086921",
    },
    "loader.mjs": {
      bytes: 1_907,
      sha256: "2e44ae287e36ae0e07e35166942e43ed8463bfb32370f780e4c5c490205f3f97",
    },
    "Cargo.lock": {
      bytes: 325_790,
      sha256: "785cd018451a22e0f30e76c0616b10da6c1a7618fd906f860784717ecb446048",
    },
  },
} as const;

/** Creates a fresh release directory only after every downloaded file matches its pin. */
export async function fetchCodexRelease(
  output: string,
  options: { readonly fetch?: typeof fetch } = {},
) {
  const fetchAsset = options.fetch ?? fetch;
  const files = await Promise.all(
    Object.entries(CODEX_WASI_RELEASE.files).map(async ([name, pin]) => {
      const response = await fetchAsset(`${CODEX_WASI_RELEASE.url}/${name}`, {
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`CODEX_RELEASE_DOWNLOAD_FAILED:${name}:${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
      if (bytes.byteLength !== pin.bytes || sha256 !== pin.sha256)
        throw new Error(`CODEX_RELEASE_INPUT_MISMATCH:${name}`);
      return { name, bytes };
    }),
  );
  const root = NodePath.resolve(output);
  await NodeFSP.mkdir(root, { mode: 0o700 });
  for (const { name, bytes } of files)
    await NodeFSP.writeFile(NodePath.join(root, name), bytes, { flag: "wx", mode: 0o444 });
  return root;
}
