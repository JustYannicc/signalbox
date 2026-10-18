// @effect-diagnostics nodeBuiltinImport:off - pinned artifact preparation runs outside the guest.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

const sha256 = "17caf644602115465f3ef02204e2f67917bfe58d6089c10f77f94863e4c3bd87";
export const bashArtifactPath = NodeURL.fileURLToPath(
  new URL("./build/bash.async.wasm", import.meta.url),
);

/** Validate build output during preparation; the deployed adapter uses a static module. */
export async function prepareBashArtifact(source?: string): Promise<string> {
  const input = source ?? bashArtifactPath;
  let bytes: Uint8Array;
  try {
    bytes = await NodeFSP.readFile(input);
  } catch (cause) {
    throw new Error(
      "Build the pinned GNU Bash shim with infra/kernelPrograms/bash/build.sh, then pass its output/bash.async.wasm to this preparer",
      { cause },
    );
  }
  if (
    bytes.byteLength !== 3_887_571 ||
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
