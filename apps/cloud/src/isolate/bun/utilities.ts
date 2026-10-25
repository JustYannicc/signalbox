// @effect-diagnostics nodeBuiltinImport:off - Bun's synchronous hash API uses workerd's Node crypto compatibility.
import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";

import { decompress } from "fzstd";
import * as Semver from "semver";
import sliceAnsi from "slice-ansi";
import * as Toml from "smol-toml";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import wrapAnsi from "wrap-ansi";
import * as Yaml from "yaml";

import { bunHash, toBytes, type BunHashInput } from "./hashes.ts";
import { deepEquals } from "./equality.ts";
import { bunJsonl } from "./jsonl.ts";

const zstdDecompressSync = (input: BunHashInput) =>
  // Claude's asset reader expects Buffer.toString("utf8"), not Uint8Array.toString().
  NodeBuffer.Buffer.from(decompress(toBytes(input)));

export const bunUtilities = {
  hash: bunHash,
  SHA256: {
    hash(input: BunHashInput, encoding?: BufferEncoding) {
      const hash = NodeCrypto.createHash("sha256").update(toBytes(input));
      const bytes = hash.digest();
      return encoding === undefined ? bytes : bytes.toString(encoding);
    },
  },
  deepEquals,
  semver: {
    // Bun accepts leading zeroes in version components, which npm-semver rejects by default.
    order: (left: string, right: string) => Semver.compare(left, right, { loose: true }),
    satisfies: (version: string, range: string) =>
      Semver.satisfies(version, range, { loose: true }),
  },
  YAML: {
    parse: Yaml.parse,
    stringify(value: unknown, replacer: null = null, space = 2) {
      return Yaml.stringify(value, replacer, { indent: space });
    },
  },
  TOML: { parse: Toml.parse },
  JSONL: bunJsonl,
  stringWidth,
  sliceAnsi,
  wrapAnsi,
  stripANSI: stripAnsi,
  zstdDecompressSync,
  zstdDecompress: async (input: BunHashInput) => zstdDecompressSync(input),
};
