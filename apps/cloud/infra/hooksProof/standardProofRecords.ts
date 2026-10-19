import { makeSecretScrubber } from "@signalbox/runner-protocol/SecretScrubber";
import { KernelOpenFlags, type KernelFileSystem } from "../../src/kernel/KernelFileSystem.ts";
import { containsGeneratedFixtureValue } from "./standardProofValues.ts";
import {
  STANDARD_PROOF_NAMED_SECRET,
  STANDARD_PROOF_VAULT_SECRET,
} from "./standardProofAdapter.ts";

export interface StandardProofSessionBaseline {
  readonly root: string;
  readonly sizes: ReadonlyMap<string, number>;
}

/** Captures the append boundary before the official harness starts this turn. */
export function captureStandardProofSessions(
  filesystem: KernelFileSystem,
  root: string,
): StandardProofSessionBaseline {
  try {
    filesystem.lstat(root);
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT")
      return { root, sizes: new Map() };
    throw error;
  }
  return {
    root,
    sizes: new Map(sessionFiles(filesystem, root).map(({ path, size }) => [path, size])),
  };
}

function sessionFiles(filesystem: KernelFileSystem, root: string) {
  const files: { path: string; size: number }[] = [];
  let bytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const path = pending.pop()!;
    const stat = filesystem.lstat(path);
    if (stat.type === "directory") {
      for (const name of filesystem.readdir(path)) pending.push(`${path}/${name}`);
      if (pending.length > 512) throw new Error("Session inspection exceeded its file bound");
    } else if (stat.type === "file" && path.endsWith(".jsonl")) {
      if (files.length >= 64 || stat.size > 8_388_608n - BigInt(bytes))
        throw new Error("Session inspection exceeded its byte bound");
      const size = Number(stat.size);
      files.push({ path, size });
      bytes += size;
    }
  }
  return files;
}

/** Inspects the official harness's persisted sessions without exporting their contents. */
export function inspectStandardProofSessions(
  filesystem: KernelFileSystem,
  root: string,
  baseline: StandardProofSessionBaseline,
) {
  const secrets = [STANDARD_PROOF_NAMED_SECRET, STANDARD_PROOF_VAULT_SECRET];
  const scrubber = makeSecretScrubber(secrets);
  const placeholders = new Set<string>();
  let files = 0;
  let bytes = 0;
  let unexpectedRawSecret = false;
  const errors: string[] = [];
  let newBytes = 0;
  try {
    if (baseline.root !== root) throw new Error("Session baseline root changed");
    for (const { path, size } of sessionFiles(filesystem, root)) {
      files++;
      const content = new Uint8Array(size);
      const fd = filesystem.open(path, KernelOpenFlags.O_RDONLY);
      try {
        let at = 0;
        while (at < content.byteLength) {
          const count = filesystem.read(fd, content.subarray(at), null);
          if (count <= 0) throw new Error("Session inspection encountered an incomplete read");
          at += count;
        }
      } finally {
        filesystem.close(fd);
      }
      bytes += content.byteLength;
      const text = new TextDecoder().decode(content);
      unexpectedRawSecret ||= scrubber.text(text) !== text || containsGeneratedFixtureValue(text);
      const start = baseline.sizes.get(path) ?? 0;
      const fresh = new TextDecoder().decode(content.subarray(Math.min(start, content.length)));
      newBytes += Math.max(0, content.length - start);
      for (const secret of secrets) {
        if (fresh.includes(`{{secret:${secret.name}}}`)) placeholders.add(secret.name);
      }
      if (fresh.includes("{{op://proof/item/password}}")) placeholders.add("VAULT_TOKEN");
    }
  } catch {
    errors.push("Official session files could not be inspected completely");
  }
  if (files === 0) errors.push("Official harness persisted no session JSONL file");
  if (newBytes === 0) errors.push("Official harness persisted no new session bytes for this turn");
  if (secrets.some(({ name }) => !placeholders.has(name)))
    errors.push("New official session records omit the expected placeholders");
  if (unexpectedRawSecret) errors.push("Official session files contain a fixture secret");
  return {
    ok: errors.length === 0,
    files,
    bytes,
    newBytes,
    placeholderNames: [...placeholders].sort(),
    unexpectedRawSecret,
    errors,
  };
}
