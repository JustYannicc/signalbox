import { markNodeBuiltinCapability } from "../../isolate/NodeBuiltinCapabilities.ts";
import { NodeBuiltinUnsupportedError } from "../../isolate/NodeBuiltinFailure.ts";
import { overrideNativeModule } from "./nativeModuleOverrides.ts";
import { exportRsaJwkFromDer } from "./nativeCryptoRsaJwk.ts";

export function guardWorkerdCrypto(module: object) {
  const invoke = (member: string, args: readonly unknown[]) => {
    const native: unknown = Reflect.get(module, member);
    if (typeof native !== "function") throw new TypeError(`Missing native crypto.${member}`);
    return Reflect.apply(native, module, args);
  };
  const generateKeyPairSync = markNodeBuiltinCapability(
    (...args: unknown[]) => {
      const options = args[1];
      if (
        args[0] === "dh" &&
        typeof options === "object" &&
        options !== null &&
        Reflect.get(options, "primeLength") !== undefined
      ) {
        throw new NodeBuiltinUnsupportedError(
          "crypto.generateKeyPairSync DH primeLength generation",
        );
      }
      return invoke("generateKeyPairSync", args);
    },
    {
      status: "conditional",
      evidence:
        "Native key generation remains type-dependent. DH primeLength generation throws ERR_SIGNALBOX_NODE_BUILTIN_UNSUPPORTED instead of Workerd's generic unimplemented error.",
    },
  );

  const replacements: Record<string, unknown> = { generateKeyPairSync };
  for (const operation of ["sign", "verify"] as const) {
    // Workerd 1.20261012.1 crypto.c++ rejects this exact branch with an uncoded Error.
    const message = `${operation === "sign" ? "Signing" : "Verifying"} with DSA keys is not currently supported`;
    const namedFailure = (error: unknown) =>
      error instanceof Error && error.message === message
        ? new NodeBuiltinUnsupportedError(`crypto.${operation} DSA keys`)
        : error;
    replacements[operation] = markNodeBuiltinCapability(
      (...args: unknown[]) => {
        const index = operation === "sign" ? 3 : 4;
        const callback: unknown = args[index];
        if (typeof callback === "function") {
          args[index] = (error: unknown, ...values: unknown[]) =>
            Reflect.apply(callback, undefined, [namedFailure(error), ...values]);
        }
        try {
          return invoke(operation, args);
        } catch (error) {
          throw namedFailure(error);
        }
      },
      {
        status: "conditional",
        evidence: `Native ${operation} remains key- and algorithm-dependent. Workerd's specific DSA refusal becomes ERR_SIGNALBOX_NODE_BUILTIN_UNSUPPORTED; other validation errors are preserved.`,
      },
    );
  }
  // Public and private KeyObjects each share one export. Fixed keys reach both without
  // generating randomness while the module loads. The all-zero Ed25519 seed is not a secret.
  const zeroSeed = { kty: "OKP", crv: "Ed25519", x: "O2onvM62pC1io6jQKm8Nc2UyFXcd4kOmOsBIoYtZ2ik" };
  exportRsaJwkFromDer([
    invoke("createPublicKey", [{ key: zeroSeed, format: "jwk" }]) as object,
    invoke("createPrivateKey", [
      { key: { ...zeroSeed, d: "A".repeat(43) }, format: "jwk" },
    ]) as object,
  ]);
  return overrideNativeModule(module, replacements);
}
