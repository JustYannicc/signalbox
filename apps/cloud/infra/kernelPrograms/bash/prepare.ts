// @effect-diagnostics nodeBuiltinImport:off - pinned artifact preparation runs outside the guest.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

const revision = "e9f019ab4e40cb6037aff7e1a0eaf20842578ed3";
const path = "packages/worker/wasm/bash/bash.async.wasm";
const sha256 = "ddc86c1422556654f02edf083f70017275bbc52f53781d1b74ac538bc7d0b102";
export const bashArtifactPath = NodeURL.fileURLToPath(
  new URL("./build/bash.async.wasm", import.meta.url),
);

/** Download only during preparation; the deployed adapter uses a static module. */
export async function prepareBashArtifact(source?: string): Promise<string> {
  let bytes: Uint8Array;
  if (source === undefined) {
    const response = await fetch(
      `https://raw.githubusercontent.com/AshishKumar4/Nimbus/${revision}/${path}`,
    );
    if (!response.ok) throw new Error(`Pinned GNU Bash download failed: ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  } else bytes = await NodeFSP.readFile(source);
  if (
    bytes.byteLength !== 3_887_678 ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== sha256
  ) {
    throw new Error("GNU Bash artifact does not match its frozen source pin");
  }
  await NodeFSP.mkdir(new URL("./build/", import.meta.url), { recursive: true });
  await NodeFSP.writeFile(bashArtifactPath, bytes);
  return bashArtifactPath;
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  process.stdout.write(`${await prepareBashArtifact(process.argv[2])}\n`);
}
