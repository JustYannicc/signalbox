import { KernelOpenFlags, type KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import type { LoadedHarnessRelease } from "../HarnessReleaseLoader.ts";
import type { HarnessHostFilesOptions, ProgramSeed, SeedMetadata, SeedStage } from "./contracts.ts";

const digest = async (bytes: Uint8Array) => {
  const hash = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
};
export const fingerprint = (input: unknown) =>
  digest(
    new TextEncoder().encode(
      JSON.stringify(input, (_key, value: unknown) => {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
        return Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => {
              const field: unknown = Reflect.get(value, key);
              return [key, field];
            }),
        );
      }),
    ),
  );
const validPath = (path: string) => {
  if (
    !path.startsWith("/") ||
    path.includes("\0") ||
    path
      .split("/")
      .slice(1)
      .some((p) => !p || p === "." || p === "..")
  )
    throw new Error("Invalid canonical seed path");
};
const code = (error: unknown, expected: string) =>
  typeof error === "object" && error !== null && "code" in error && error.code === expected;
export function ensureDirectory(files: KernelFileSystem, path: string) {
  if (path === "/") return;
  validPath(path);
  let current = "";
  for (const part of path.slice(1).split("/")) {
    current += `/${part}`;
    try {
      files.mkdir(current, 0o755);
    } catch (error) {
      if (!code(error, "EEXIST")) throw error;
    }
    if (files.lstat(current).type !== "directory")
      throw new Error("Seed parent is not a directory");
  }
}
export function validateMetadata(value: SeedMetadata) {
  if (
    !Number.isInteger(value.mode) ||
    value.mode < 0 ||
    value.mode > 0o7777 ||
    !Number.isInteger(value.uid) ||
    value.uid < 0 ||
    value.uid >= 0xffff_ffff ||
    !Number.isInteger(value.gid) ||
    value.gid < 0 ||
    value.gid >= 0xffff_ffff
  )
    throw new Error("Invalid seed metadata");
}
interface SeedFile extends SeedMetadata {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly asset?: { readonly key: string; readonly loader: number; readonly encoding: number };
}
export async function createSeedCatalog(
  loaded: LoadedHarnessRelease,
  programs: ProgramSeed,
  policy: HarnessHostFilesOptions,
  identity: unknown,
) {
  if (!programs.sourceIdentity) throw new Error("Program catalog identity is required");
  const assetBytes = new Map<string, Uint8Array>();
  const assets: SeedFile[] = loaded.plan.assets.map((entry) => {
    const payload = loaded.payloads.get(entry.path);
    if (payload === undefined) throw new Error("Missing verified asset");
    assetBytes.set(entry.name, Uint8Array.from(payload));
    return {
      path: entry.name,
      bytes: entry.bytes,
      sha256: entry.sha256,
      mode: policy.assetMode,
      uid: policy.posix.credentials.euid,
      gid: policy.posix.credentials.egid,
      asset: { key: entry.key, loader: entry.loader, encoding: entry.encoding },
    };
  });
  const executables: SeedFile[] = Object.entries(programs.files).map(([path, entry]) => ({
    path,
    ...entry,
  }));
  const stages = { assets, programs: executables };
  const paths = new Set<string>();
  for (const entries of Object.values(stages)) {
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const entry of entries) {
      validPath(entry.path);
      validateMetadata(entry);
      if (
        paths.has(entry.path) ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0 ||
        !/^[a-f0-9]{64}$/.test(entry.sha256)
      )
        throw new Error("Invalid or duplicate seed descriptor");
      paths.add(entry.path);
    }
  }
  for (const path of paths)
    for (const parent of paths) {
      if (path.startsWith(`${parent}/`))
        throw new Error("Seed file conflicts with a parent directory");
    }
  const catalogId = await fingerprint({ identity, programSource: programs.sourceIdentity, stages });
  const readProgram = programs.read;
  return {
    id: catalogId,
    stages,
    async payloads(stage: SeedStage, signal: AbortSignal) {
      const result = new Map<string, Uint8Array>();
      for (const entry of stages[stage]) {
        signal.throwIfAborted();
        const bytes = Uint8Array.from(
          stage === "assets" ? assetBytes.get(entry.path)! : await readProgram(entry.path, signal),
        );
        if (bytes.byteLength !== entry.bytes || (await digest(bytes)) !== entry.sha256)
          throw new Error("Seed payload verification failed");
        result.set(entry.path, bytes);
      }
      signal.throwIfAborted();
      return result;
    },
  };
}
export type SeedCatalog = Awaited<ReturnType<typeof createSeedCatalog>>;

function parents(files: KernelFileSystem, path: string) {
  let current = "";
  for (const part of path.slice(1).split("/").slice(0, -1)) {
    current += `/${part}`;
    if (files.lstat(current).type !== "directory") throw new Error("Seed parent changed");
  }
}
export function verifySeedFiles(
  files: KernelFileSystem,
  entries: readonly SeedFile[],
  payloads: ReadonlyMap<string, Uint8Array>,
) {
  for (const entry of entries) {
    parents(files, entry.path);
    if (files.lstat(entry.path).type !== "file") throw new Error("Seed file type changed");
    const fd = files.open(entry.path, KernelOpenFlags.O_RDONLY);
    try {
      const actual = files.getPosixMetadataForFd(fd);
      if (
        actual.mode !== entry.mode ||
        actual.uid !== entry.uid ||
        actual.gid !== entry.gid ||
        files.fstat(fd).size !== BigInt(entry.bytes)
      )
        throw new Error("Seed metadata changed");
      const expected = payloads.get(entry.path);
      if (expected === undefined || expected.length !== entry.bytes)
        throw new Error("Missing seed payload");
      const chunk = new Uint8Array(Math.min(65536, entry.bytes));
      let offset = 0;
      while (offset < expected.length) {
        const count = files.read(
          fd,
          chunk.subarray(0, Math.min(chunk.length, expected.length - offset)),
          null,
        );
        if (count <= 0) throw new Error("Seed file ended early");
        for (let i = 0; i < count; i++)
          if (chunk[i] !== expected[offset + i]) throw new Error("Seed contents changed");
        offset += count;
      }
    } finally {
      files.close(fd);
    }
  }
}
export function writeSeedFiles(
  files: KernelFileSystem,
  entries: readonly SeedFile[],
  payloads: ReadonlyMap<string, Uint8Array>,
) {
  for (const entry of entries) {
    ensureDirectory(files, entry.path.slice(0, entry.path.lastIndexOf("/")) || "/");
    const fd = files.open(
      entry.path,
      KernelOpenFlags.O_CREAT | KernelOpenFlags.O_EXCL | KernelOpenFlags.O_WRONLY,
      entry.mode,
    );
    try {
      const bytes = payloads.get(entry.path)!;
      let offset = 0;
      while (offset < bytes.length) {
        const count = files.write(fd, bytes.subarray(offset), null);
        if (count <= 0) throw new Error("Seed write made no progress");
        offset += count;
      }
      files.fchmod(fd, entry.mode);
    } finally {
      files.close(fd);
    }
  }
  verifySeedFiles(files, entries, payloads);
}
