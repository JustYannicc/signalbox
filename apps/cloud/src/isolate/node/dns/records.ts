// @effect-diagnostics nodeBuiltinImport:off - DNS address validation uses the platform IP parser.
import * as NodeNet from "node:net";
import * as Schema from "effect/Schema";
import { dnsError } from "./errors.ts";

export const recordTypes = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  PTR: 12,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  NAPTR: 35,
  TLSA: 52,
  ANY: 255,
  CAA: 257,
} as const;
export type RecordType = keyof typeof recordTypes;
const Answer = Schema.Struct({
  name: Schema.String,
  type: Schema.Number,
  TTL: Schema.Number,
  data: Schema.String,
});
const Response = Schema.Struct({
  Status: Schema.Number,
  Answer: Schema.optional(Schema.Array(Answer)),
});
export const decodeResponse = Schema.decodeUnknownSync(Response);
export type Answer = typeof Answer.Type;

const domain = (value: string) => (value.endsWith(".") ? value.slice(0, -1) : value);

// DNS presentation strings escape octets as \\DDD and may contain multiple quoted chunks.
function fields(data: string): string[] {
  const values: string[] = [];
  const pattern = /"((?:[^"\\]|\\[\s\S])*)"|([^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(data)) !== null) {
    values.push(
      (match[1] ?? match[2] ?? "").replace(/\\(\d{3}|[\s\S])/g, (_, escaped: string) =>
        /^\d{3}$/.test(escaped) ? String.fromCharCode(Number(escaped)) : escaped,
      ),
    );
  }
  return values;
}

export function parseRecord(answer: Answer, hostname: string, syscall: string) {
  const data = fields(answer.data);
  const bad = () => {
    throw dnsError("EBADRESP", syscall, hostname);
  };
  const text = (index: number) => data[index] ?? bad();
  const number = (index: number) => {
    const value = text(index);
    return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : bad();
  };
  switch (answer.type) {
    case 1:
    case 28:
      if (NodeNet.isIP(answer.data) !== (answer.type === 1 ? 4 : 6)) return bad();
      return { address: answer.data, ttl: answer.TTL };
    case 2:
    case 5:
    case 12:
      return domain(text(0));
    case 15:
      return { priority: number(0), exchange: domain(text(1)) };
    case 16:
      return data;
    case 6:
      return {
        nsname: domain(text(0)),
        hostmaster: domain(text(1)),
        serial: number(2),
        refresh: number(3),
        retry: number(4),
        expire: number(5),
        minttl: number(6),
      };
    case 33:
      return { priority: number(0), weight: number(1), port: number(2), name: domain(text(3)) };
    case 35:
      return {
        order: number(0),
        preference: number(1),
        flags: text(2),
        service: text(3),
        regexp: text(4),
        replacement: domain(text(5)),
      };
    case 52: {
      const hex = data.slice(3).join("");
      if (!/^(?:[0-9a-fA-F]{2})+$/.test(hex)) return bad();
      const bytes = Uint8Array.from(hex.match(/../g)!, (byte) => Number.parseInt(byte, 16));
      return { certUsage: number(0), selector: number(1), match: number(2), data: bytes.buffer };
    }
    case 257:
      return { critical: number(0), [text(1)]: text(2) };
    default:
      return bad();
  }
}

export function reverseName(ip: string) {
  const family = NodeNet.isIP(ip);
  if (family === 4) return `${ip.split(".").toReversed().join(".")}.in-addr.arpa`;
  if (family !== 6) throw dnsError("EINVAL", "getHostByAddr", ip);
  let address = ip.split("%")[0]!;
  if (address.includes(".")) {
    const colon = address.lastIndexOf(":");
    const octets = address
      .slice(colon + 1)
      .split(".")
      .map(Number);
    address = `${address.slice(0, colon)}:${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const [left = "", right = ""] = address.split("::");
  const leading = left ? left.split(":") : [];
  const trailing = right ? right.split(":") : [];
  const groups = [
    ...leading,
    ...Array<string>(8 - leading.length - trailing.length).fill("0"),
    ...trailing,
  ];
  return `${groups
    .map((group) => group.padStart(4, "0"))
    .join("")
    .split("")
    .toReversed()
    .join(".")}.ip6.arpa`;
}
