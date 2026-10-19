import * as Schema from "effect/Schema";
import { KERNEL_BASH_ARTIFACT } from "../../src/kernel/KernelBashProgram.ts";
import { KERNEL_BUSYBOX_ARTIFACT } from "../../src/kernel/KernelBusyboxProgram.ts";
import { KERNEL_RIPGREP_ARTIFACT } from "../../src/kernel/KernelRipgrepProgram.ts";

const code = Schema.Struct({
  mainModule: Schema.String,
  modules: Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Struct({ js: Schema.String })]),
  ),
  entrypoint: Schema.optionalKey(Schema.String),
});
const seed = Schema.Struct({
  sourceCommit: Schema.String,
  runner: Schema.Struct({ source: Schema.String, sha256: Schema.String }),
  programs: Schema.Struct({ bash: code, busyboxCat: code, ripgrep: code }),
  executables: Schema.Array(
    Schema.Struct({
      path: Schema.Literals(["/bin/bash", "/bin/cat", "/bin/rg"]),
      data: Schema.String,
      sha256: Schema.String,
    }),
  ),
});
export type ProofSeed = typeof seed.Type;
const decode = Schema.decodeUnknownSync(seed);
const artifacts = {
  "/bin/bash": KERNEL_BASH_ARTIFACT,
  "/bin/cat": KERNEL_BUSYBOX_ARTIFACT,
  "/bin/rg": KERNEL_RIPGREP_ARTIFACT,
};

export async function decodeProofSeed(value: unknown) {
  const decoded = decode(value);
  if (!/^[a-f0-9]{40}$/.test(decoded.sourceCommit) || decoded.executables.length !== 3) {
    throw new Error("Invalid proof seed identity");
  }
  const seen = new Set<string>();
  const executables: { path: keyof typeof artifacts; bytes: Uint8Array }[] = [];
  for (const file of decoded.executables) {
    if (seen.has(file.path)) throw new Error("Duplicate proof executable");
    seen.add(file.path);
    const expected = artifacts[file.path];
    const raw = atob(file.data);
    const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
    if (
      bytes.length !== expected.bytes ||
      file.sha256 !== expected.sha256 ||
      (await digest(bytes)) !== expected.sha256
    ) {
      throw new Error("Proof executable does not match its pinned artifact");
    }
    executables.push({ path: file.path, bytes });
  }
  const runner = new TextEncoder().encode(decoded.runner.source);
  if (
    runner.length < 1 ||
    runner.length > 4_000_000 ||
    (await digest(runner)) !== decoded.runner.sha256
  ) {
    throw new Error("Proof Runner artifact hash mismatch");
  }
  return { ...decoded, executables, runner: { bytes: runner, sha256: decoded.runner.sha256 } };
}

async function digest(bytes: Uint8Array) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
