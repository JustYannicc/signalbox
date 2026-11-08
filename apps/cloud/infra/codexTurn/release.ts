// @effect-diagnostics nodeBuiltinImport:off - downloads immutable native proof artifacts.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

// The unchanged builder at this commit reproduced all four files byte for byte.
export const CODEX_WASI_RELEASE = {
  sourceCommit: "75f8b1b1fec5dc9e1f473a0e415083cf9ce07acd",
  url: "https://github.com/JustYannicc/signalbox/releases/download/kernel-programs-20261108-codex-f5de9ba8",
  files: {
    "manifest.json": {
      bytes: 10_634,
      sha256: "d0c778dca7711bcab75a5e82c81fe2d3cb6be42c049bc8b7d17d136444d7aae4",
    },
    "engine.wasm": {
      bytes: 58_779_099,
      sha256: "f5de9ba8ce543491778b54ae34567ed6c7e3ac50c4b30581b691bc169f879a4b",
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
