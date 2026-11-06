import { markNodeBuiltinCapability } from "../../isolate/NodeBuiltinCapabilities.ts";

/**
 * Workerd exports a JWK through its WebCrypto RSA key, which asserts a hash (rsa.c++:556,
 * `keyAlgorithm.hash != nullptr`). A Node KeyObject never has one, so every RSA `export({ format:
 * "jwk" })` became an internal error, logged once per call. The official CLI does this for each
 * root certificate at startup. Node's JWK for RSA is only the key's integers, so it is built from
 * the DER export instead.
 */
interface Der {
  readonly tag: number;
  readonly value: Uint8Array;
  readonly end: number;
}

function read(bytes: Uint8Array, offset: number): Der {
  const tag = bytes[offset];
  let length = bytes[offset + 1];
  if (tag === undefined || length === undefined) throw new TypeError("Truncated RSA key DER");
  let start = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4) throw new TypeError("Unsupported RSA key DER length");
    length = 0;
    for (let index = 0; index < count; index++) length = length * 256 + bytes[start + index]!;
    start += count;
  }
  const end = start + length;
  if (end > bytes.byteLength) throw new TypeError("Truncated RSA key DER");
  return { tag, value: bytes.subarray(start, end), end };
}

function sequence(bytes: Uint8Array) {
  const outer = read(bytes, 0);
  if (outer.tag !== 0x30) throw new TypeError("RSA key DER is not a sequence");
  const items: Der[] = [];
  for (let offset = 0; offset < outer.value.byteLength;) {
    const item = read(outer.value, offset);
    items.push(item);
    offset = item.end;
  }
  return items;
}

function integer(item: Der | undefined) {
  if (item?.tag !== 0x02) throw new TypeError("RSA key DER lacks an integer");
  let bytes = item.value;
  while (bytes.byteLength > 1 && bytes[0] === 0) bytes = bytes.subarray(1);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type Export = (this: object, options?: unknown) => unknown;

function rsaJwk(key: object, exportDer: Export) {
  const type: unknown = Reflect.get(key, "type");
  if (type === "public") {
    const spki = sequence(exportDer.call(key, { type: "spki", format: "der" }) as Uint8Array);
    const bits = spki[1];
    // The BIT STRING holds RSAPublicKey after one unused-bits byte.
    if (bits?.tag !== 0x03 || bits.value[0] !== 0) throw new TypeError("Invalid RSA SPKI DER");
    const [n, e] = sequence(bits.value.subarray(1));
    return { kty: "RSA", n: integer(n), e: integer(e) };
  }
  const [, n, e, d, p, q, dp, dq, qi] = sequence(
    exportDer.call(key, { type: "pkcs1", format: "der" }) as Uint8Array,
  );
  return {
    kty: "RSA",
    n: integer(n),
    e: integer(e),
    d: integer(d),
    p: integer(p),
    q: integer(q),
    dp: integer(dp),
    dq: integer(dq),
    qi: integer(qi),
  };
}

const patched = new WeakSet<object>();

/** Patches the KeyObject prototypes in place, so native APIs still accept their own keys. */
export function exportRsaJwkFromDer(keys: readonly object[]) {
  for (const key of keys) {
    let owner: object | null = key;
    while (owner !== null && !Object.hasOwn(owner, "export")) owner = Object.getPrototypeOf(owner);
    if (owner === null || patched.has(owner)) continue;
    const native: unknown = Reflect.get(owner, "export");
    if (typeof native !== "function") throw new TypeError("Missing native KeyObject.export");
    const exportKey = markNodeBuiltinCapability(
      function (this: object, options?: unknown) {
        if (
          typeof options === "object" &&
          options !== null &&
          Reflect.get(options, "format") === "jwk" &&
          Reflect.get(this, "asymmetricKeyType") === "rsa"
        )
          return rsaJwk(this, native as Export);
        return Reflect.apply(native, this, [options]);
      },
      {
        status: "conditional",
        evidence:
          "KeyObject.export keeps native behavior, except RSA JWK export, which is built from the key's DER because Workerd's JWK path requires a hash a Node key never has.",
      },
    );
    Object.defineProperty(owner, "export", {
      value: exportKey,
      configurable: true,
      writable: true,
      enumerable: false,
    });
    patched.add(owner);
  }
}
