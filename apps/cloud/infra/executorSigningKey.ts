import * as NodeBuffer from "node:buffer";
import { p256 } from "@noble/curves/nist";
import { sha256 } from "@noble/hashes/sha2";

/** Derives one stable P-256 JWK from the deployment's secret Alchemy.Random seed. */
export const executorSigningJwk = (seed: string) => {
  const seedBytes = NodeBuffer.Buffer.from(seed, "hex");
  if (seedBytes.byteLength !== 32) throw new Error("Executor signing seed must be 32 bytes.");

  for (let counter = 0; counter < 256; counter++) {
    const scalar =
      counter === 0
        ? seedBytes
        : sha256(NodeBuffer.Buffer.concat([seedBytes, NodeBuffer.Buffer.from(String(counter))]));
    try {
      const publicKey = p256.getPublicKey(scalar, false);
      return JSON.stringify({
        kty: "EC",
        crv: "P-256",
        d: NodeBuffer.Buffer.from(scalar).toString("base64url"),
        x: NodeBuffer.Buffer.from(publicKey.subarray(1, 33)).toString("base64url"),
        y: NodeBuffer.Buffer.from(publicKey.subarray(33, 65)).toString("base64url"),
      });
    } catch {
      // P-256 rejects the vanishingly rare seed outside its scalar range.
    }
  }

  throw new Error("Could not derive the Executor signing key.");
};
