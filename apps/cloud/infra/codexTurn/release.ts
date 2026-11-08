// @effect-diagnostics nodeBuiltinImport:off - downloads immutable native proof artifacts.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { downloadRelease } from "@t3tools/shared/releaseDownload";

// The unchanged builder at this commit reproduced all four files byte for byte.
export const CODEX_WASI_RELEASE = {
  sourceCommit: "c02661ec15b934ca8a0e8b8e201cb2b1ba555863",
  url: "https://github.com/JustYannicc/signalbox/releases/download/kernel-programs-20261108-codex-6169cddc",
  files: {
    "manifest.json": {
      bytes: 10_634,
      sha256: "6c3ffd18187c2ff8ba3dfb63ce73a9e0c23f4f4c644004c688f0366008e10816",
    },
    "engine.wasm": {
      bytes: 58_788_193,
      sha256: "6169cddc2b5fe329d9bc85f932f9126fea920978b9962e50e4a230216f84365c",
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
  options: { readonly fetch?: typeof fetch; readonly token?: string } = {},
) {
  const files = await Promise.all(
    Object.entries(CODEX_WASI_RELEASE.files).map(async ([name, pin]) => {
      const bytes = await downloadRelease(
        `${CODEX_WASI_RELEASE.url}/${name}`,
        async (response) => new Uint8Array(await response.arrayBuffer()),
        { ...options, failurePrefix: `CODEX_RELEASE_DOWNLOAD_FAILED:${name}` },
      );
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
