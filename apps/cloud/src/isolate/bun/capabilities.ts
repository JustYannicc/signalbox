export const BUN_API_CAPABILITIES = {
  hash: "implemented",
  "hash.wyhash": "implemented",
  "hash.crc32": "implemented",
  "hash.xxHash64": "implemented",
  "SHA256.hash": "implemented",
  deepEquals: "implemented",
  "semver.order": "implemented",
  "semver.satisfies": "implemented",
  "YAML.parse": "implemented",
  "YAML.stringify": "implemented",
  "TOML.parse": "implemented",
  "JSONL.parse": "implemented",
  "JSONL.parseChunk": "implemented",
  stringWidth: "implemented",
  sliceAnsi: "implemented",
  wrapAnsi: "implemented",
  stripANSI: "implemented",
  zstdDecompress: "implemented",
  zstdDecompressSync: "implemented",
  file: "host",
  write: "host",
  "stdin.stream": "host",
  "stdin.text": "host",
  which: "host",
  spawn: "host",
  env: "host",
  main: "host",
  version: "host",
  revision: "host",
  embeddedFiles: "host",
  "embeddedFiles.length": "host",
  isStandaloneExecutable: "implemented",
  gc: "headless",
  "unsafe.setJITPolicy": "headless",
  ant: "headless",
  sleepSync: "unsupported",
  generateHeapSnapshot: "unsupported",
  FetchSession: "unsupported",
  Image: "unsupported",
  SQL: "unsupported",
  Terminal: "unsupported",
  Transpiler: "unsupported",
  build: "unsupported",
  "WebView.closeAll": "unsupported",
  connect: "unsupported",
  listen: "unsupported",
  serve: "unsupported",
} as const;

export type BunIsolateCapability =
  | "Image"
  | "SQL"
  | "Terminal"
  | "Transpiler"
  | "build"
  | "connect"
  | "listen"
  | "serve";

export class BunCapabilityUnavailable extends Error {
  readonly code = "BUN_ISOLATE_CAPABILITY_UNAVAILABLE";
  readonly member: string;

  constructor(member: string) {
    super(`Bun.${member} requires an isolate host capability`);
    this.member = member;
    this.name = "BunCapabilityUnavailable";
  }
}
