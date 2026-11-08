// @effect-diagnostics nodeBuiltinImport:off - downloads immutable native proof artifacts.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

// The unchanged builder at this commit reproduced all four files byte for byte.
export const CODEX_WASI_RELEASE = {
  sourceCommit: "2e4a89f3af2716d99ae428343a91acfa72736eb7",
  url: "https://github.com/JustYannicc/signalbox/releases/download/kernel-programs-20261108-codex-33e30977",
  files: {
    "manifest.json": {
      bytes: 10_634,
      sha256: "1c1c196bf0f785364c28e7768e067463f636f3b9133585d8f26a5f100e911b45",
    },
    "engine.wasm": {
      bytes: 58_834_333,
      sha256: "33e309776dab6211906ad77f68798ec95c0a17387f5fabe172b5992b35b23540",
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
