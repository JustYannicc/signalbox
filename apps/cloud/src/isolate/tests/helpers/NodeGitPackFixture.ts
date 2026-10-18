// @effect-diagnostics nodeBuiltinImport:off - deterministic binary fixtures use Node hashing and compression.
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";
import { gitFixturePack } from "./NodeGitFixture.ts";

const encoder = new TextEncoder();

export interface ForwardRefDeltaPack {
  readonly pack: Uint8Array;
  readonly baseOid: string;
  readonly targetOid: string;
}

export function forwardRefDeltaPack(baseText: string, suffixText: string): ForwardRefDeltaPack {
  const base = encoder.encode(baseText);
  const suffix = encoder.encode(suffixText);
  const target = joinBytes(base, suffix);
  const delta = joinBytes(
    encodeDeltaInteger(base.byteLength),
    encodeDeltaInteger(target.byteLength),
    new Uint8Array([0x90, base.byteLength, suffix.byteLength]),
    suffix,
  );
  const baseOid = gitBlobOid(base);
  const targetOid = gitBlobOid(target);
  const deltaObject = joinBytes(
    packObjectHeader(7, delta.byteLength),
    new Uint8Array(Buffer.from(baseOid, "hex")),
    NodeZlib.deflateSync(delta),
  );
  const baseObject = joinBytes(packObjectHeader(3, base.byteLength), NodeZlib.deflateSync(base));
  const body = joinBytes(encoder.encode("PACK"), uint32(2), uint32(2), deltaObject, baseObject);
  return { pack: withPackChecksum(body), baseOid, targetOid };
}

export function emptyGitPack(): Uint8Array {
  return withPackChecksum(joinBytes(encoder.encode("PACK"), uint32(2), uint32(0)));
}

export function invalidPackFixtures(): readonly {
  readonly name: string;
  readonly pack: Uint8Array;
}[] {
  const valid = gitFixturePack();
  const body = valid.subarray(0, -20);
  const countBody = body.slice();
  new DataView(countBody.buffer).setUint32(8, 1, false);

  const missingTrailer = body.slice();
  const corruptTrailer = valid.slice();
  const checksumIndex = corruptTrailer.byteLength - 1;
  corruptTrailer[checksumIndex] = corruptTrailer[checksumIndex]! ^ 1;

  return [
    { name: "reserved pack object type zero", pack: packWithReservedType(0) },
    { name: "reserved pack object type five", pack: packWithReservedType(5) },
    { name: "truncated object data", pack: withPackChecksum(body.subarray(0, -4)) },
    { name: "declared object count mismatch", pack: withPackChecksum(countBody) },
    { name: "missing pack trailer", pack: missingTrailer },
    { name: "corrupt pack trailer", pack: corruptTrailer },
  ];
}

export function invalidEmptyPackFixtures(): readonly {
  readonly name: string;
  readonly pack: Uint8Array;
}[] {
  const valid = emptyGitPack();
  const header = valid.subarray(0, 12);
  const corruptTrailer = valid.slice();
  const checksumIndex = corruptTrailer.byteLength - 1;
  corruptTrailer[checksumIndex] = corruptTrailer[checksumIndex]! ^ 1;

  return [
    { name: "zero-object pack missing its checksum trailer", pack: header },
    { name: "zero-object pack with a corrupt checksum trailer", pack: corruptTrailer },
    {
      name: "zero-object pack with trailing body data",
      pack: withPackChecksum(joinBytes(header, new Uint8Array([0xff]))),
    },
  ];
}

function gitBlobOid(bytes: Uint8Array): string {
  return NodeCrypto.createHash("sha1")
    .update(encoder.encode(`blob ${bytes.byteLength}\0`))
    .update(bytes)
    .digest("hex");
}

function encodeDeltaInteger(value: number): Uint8Array {
  const bytes: number[] = [];
  do {
    const next = value & 0x7f;
    value >>>= 7;
    bytes.push(next | (value > 0 ? 0x80 : 0));
  } while (value > 0);
  return new Uint8Array(bytes);
}

function packObjectHeader(type: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let first = (type << 4) | (size & 0x0f);
  size >>>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let next = size & 0x7f;
    size >>>= 7;
    if (size > 0) next |= 0x80;
    bytes.push(next);
  }
  return new Uint8Array(bytes);
}

function packWithReservedType(type: 0 | 5): Uint8Array {
  const object = encoder.encode("reserved");
  const body = joinBytes(
    encoder.encode("PACK"),
    uint32(2),
    uint32(1),
    packObjectHeader(type, object.byteLength),
    NodeZlib.deflateSync(object),
  );
  return withPackChecksum(body);
}

function uint32(value: number): Uint8Array {
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, value, false);
  return output;
}

function withPackChecksum(body: Uint8Array): Uint8Array {
  const output = new Uint8Array(body.byteLength + 20);
  output.set(body);
  output.set(NodeCrypto.createHash("sha1").update(body).digest(), body.byteLength);
  return output;
}

function joinBytes(...chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
