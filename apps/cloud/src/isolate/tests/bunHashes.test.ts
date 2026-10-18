import { describe, expect, it } from "@effect/vitest";

import { createBunShim } from "../BunShim.ts";

// Captured from the Bun 1.4.3 oracle. Input byte i is (i * 191 + 17) & 0xff.
const VECTORS = [
  [0, 0n, 0x0409638ee2bde459n, 0x00000000, 0xef46db3751d8e999n],
  [0, 123n, 0xc707339c8b600ebcn, 0x0000007b, 0xe0db84de91f3e198n],
  [0, 0x123456789abcdef0n, 0x20cc191e804ca6a8n, 0x9abcdef0, 0x7fef5b0c316777edn],
  [1, 0n, 0xd4f472fcb8275584n, 0xb8b2cf7f, 0xad10cd9780ac4ff7n],
  [1, 123n, 0xc927a23eff114440n, 0x7f6567cb, 0xb8f0674c78cf742dn],
  [1, 0x123456789abcdef0n, 0x67c42ab742fbb5aen, 0x059581bd, 0xa1a27645a6146cf7n],
  [3, 0n, 0x25a216547bb07096n, 0x1e9a4bfb, 0x93639143093e0fe9n],
  [3, 123n, 0x65dde8741464a9a1n, 0x463ecc4a, 0x0336adeff982580en],
  [3, 0x123456789abcdef0n, 0xc8d59985dc374af8n, 0x76322f87, 0x5a4bbbaf7e5f8790n],
  [4, 0n, 0xcb311d180849c516n, 0x691732c5, 0x7e8a72c9a223a1c0n],
  [4, 123n, 0x3b8eb7cef69f15d2n, 0xd5291558, 0x3b870b0acbe7331en],
  [4, 0x123456789abcdef0n, 0xa95c1436ce115230n, 0x30cca7b6, 0x83a77710364b35f8n],
  [16, 0n, 0x7cf73517b2d50d19n, 0x8b9c943e, 0x82facd078c4684ccn],
  [16, 123n, 0xcb3095b50740d85cn, 0x0e210c9a, 0x44b5ea3c8649d54an],
  [16, 0x123456789abcdef0n, 0x49296fbca531e220n, 0x090819bf, 0xdf4dad88e23548acn],
  [17, 0n, 0x4a150b49fd941519n, 0x64ef5e24, 0x146344253b6c906fn],
  [17, 123n, 0x3494b54fabd089ban, 0xb5d1844d, 0x4f2c6ce35febcd22n],
  [17, 0x123456789abcdef0n, 0x923ae88ae0423e10n, 0xfed2791f, 0x156cf1c48ebe8746n],
  [32, 0n, 0x83d4838974dce275n, 0x1088546e, 0xd27d959564fd4575n],
  [32, 123n, 0x552964754d08728dn, 0x680d601a, 0xdac35529e5d351f6n],
  [32, 0x123456789abcdef0n, 0xd36e556a824ea0e3n, 0x6ccf6675, 0x73a419c0d2d75712n],
  [48, 0n, 0xc12d812bd63e8b95n, 0xcdfca2aa, 0x0da482b6dbb33c90n],
  [48, 123n, 0x2687f93641c69b61n, 0x6757b7e0, 0xa8ac356747be8210n],
  [48, 0x123456789abcdef0n, 0x93a87f8a4e90c420n, 0x111b3f87, 0x6928def47b14297dn],
  [49, 0n, 0x678e7e9a48f9d2f7n, 0x33c18b37, 0xb928e4c65c63db48n],
  [49, 123n, 0x941444bce8102e03n, 0xa56288ac, 0x6c9b6c0820de208an],
  [49, 0x123456789abcdef0n, 0xc0ab0480ccc3e5fcn, 0x76c230df, 0x0add55f3c889ce8en],
  [257, 0n, 0x23cb8ce17b639937n, 0x423e3c5a, 0x5eefcef350888cccn],
  [257, 123n, 0x5044d82bdce397fdn, 0x0e6993fa, 0x4b4c734012faa27cn],
  [257, 0x123456789abcdef0n, 0x328d62bdc3208adan, 0x725acd8c, 0xcff35664ed6ed2a9n],
] as const;

const makeInput = (length: number) =>
  Uint8Array.from({ length }, (_, index) => (index * 191 + 17) & 0xff);

const bun = () =>
  createBunShim({
    env: {},
    main: "/test",
    version: "1.4.3",
    onMissing: () => {},
  }).bun;

describe("Bun hash compatibility", () => {
  it("matches Bun's wyhash, crc32, and xxHash64 vectors across length and seed boundaries", () => {
    const hash = bun().hash;

    for (const [length, seed, expectedWyhash, expectedCrc32, expectedXxHash64] of VECTORS) {
      const input = makeInput(length);
      expect(hash(input, seed)).toBe(expectedWyhash);
      expect(hash.wyhash(input, seed)).toBe(expectedWyhash);
      expect(hash.crc32(input, seed)).toBe(expectedCrc32);
      expect(hash.xxHash64(input, seed)).toBe(expectedXxHash64);
    }
  });

  it("hashes strings as UTF-8 and preserves byte-view offsets", () => {
    const hash = bun().hash;
    const input = "Aé😀𝌆\u0000ñ";
    const encoded = new TextEncoder().encode(input);
    const padded = new Uint8Array(encoded.length + 4);
    padded.set(encoded, 2);
    const view = new DataView(padded.buffer, 2, encoded.length);

    expect(hash(input)).toBe(0x1f60eb7e59a9a399n);
    expect(hash(input, 123n)).toBe(0x6ae7578da5782190n);
    expect(hash.crc32(input)).toBe(0xf67964e8);
    expect(hash.crc32(input, 123n)).toBe(0x532eec40);
    expect(hash.xxHash64(input)).toBe(0x80b6ce9891ad989dn);
    expect(hash.xxHash64(input, 123n)).toBe(0x595f5372870406b3n);

    expect(hash(view)).toBe(hash(encoded));
    expect(hash(new Uint8Array(padded.buffer, 2, encoded.length))).toBe(hash(encoded));
    expect(hash(encoded.buffer)).toBe(hash(encoded));
  });
});
