// @effect-diagnostics nodeBuiltinImport:off - pinned artifact preparation runs outside the guest.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

const revision = "e9f019ab4e40cb6037aff7e1a0eaf20842578ed3";
const sha256 = "87c054c0a772fce3a236f5721f486707461d98144af8a9ff9a1424e40b9b9f36";
const bytesLength = 3_678_759;
export const gitArtifactPath = NodeURL.fileURLToPath(new URL("./git.wasm", import.meta.url));

/** Validates the reproducibly built artifact before static module packaging. */
export async function prepareGitArtifact(source?: string): Promise<string> {
  const input = source ?? gitArtifactPath;
  let bytes: Uint8Array;
  try {
    bytes = await NodeFSP.readFile(input);
  } catch (cause) {
    throw new Error(
      `Build Git from Nimbus ${revision} with infra/kernelPrograms/git/build.sh, then pass its output/git.cwd.wasm to this preparer`,
      { cause },
    );
  }

  if (
    bytes.byteLength !== bytesLength ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== sha256
  ) {
    throw new Error("Git artifact does not match its frozen source and startup-cwd patch");
  }
  if (input !== gitArtifactPath) await NodeFSP.writeFile(gitArtifactPath, bytes);
  return gitArtifactPath;
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  process.stdout.write(`${await prepareGitArtifact(process.argv[2])}\n`);
}
