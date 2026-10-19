import type { FacetStorage } from "../../src/kernel/FacetSqliteStorage.ts";
import type { PreparedAssetModuleCatalog } from "../claudeTurnProof/preparedAssetModules.ts";
import { decodeVerifiedAssetBundle } from "../claudeTurnProof/assetBundle.ts";
import { verifySeededAssets } from "../claudeTurnProof/proofAssets.ts";
import { readAssetBody } from "../claudeTurnProof/proofObservation.ts";
import {
  createProofExecutableSeedRoute,
  type ProofExecutableFileCatalog,
} from "../claudeTurnProof/proofExecutableSeed.ts";
import type { createProofFilesystemHost } from "../claudeTurnProof/proofFilesystem.ts";

const assetBundleContentType = "application/vnd.signalbox.claude-assets.v1";
const receiptTable = "proof_claude_hooks_seed_receipts";
const bootTable = "proof_claude_hooks_boot_guard";
const executableMode = 0o755;
const executableUid = 1000;
const executableGid = 1000;

type SeedStage = "assets" | "programs";

interface SeedReceipt {
  readonly catalogIdentity: string;
  readonly fileCount: number;
  readonly byteCount: number;
}

export interface ClaudeHooksSeedStatus {
  readonly assetsSeeded: boolean;
  readonly programsSeeded: boolean;
}

/** Owns the hook proof's fixture seed order and boot gate. */
export function createClaudeHooksSeedState(options: {
  readonly storage: FacetStorage;
  readonly filesystem: () => ReturnType<typeof createProofFilesystemHost>;
  readonly assets: PreparedAssetModuleCatalog;
  readonly programs: ProofExecutableFileCatalog;
  readonly requireSeed: boolean;
}) {
  let seedingAssets = false;
  options.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ${receiptTable} (
    stage TEXT PRIMARY KEY,
    catalog_identity TEXT NOT NULL,
    file_count INTEGER NOT NULL,
    byte_count INTEGER NOT NULL
  )`);
  options.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ${bootTable} (
    started INTEGER PRIMARY KEY CHECK (started = 1)
  )`);

  const assetIdentity = JSON.stringify(
    Object.entries(options.assets)
      .sort(([left], [right]) => compare(left, right))
      .map(([path, entry]) => [
        path,
        entry.bytes,
        entry.sha256,
        entry.loader ?? null,
        entry.encoding ?? null,
      ]),
  );
  const programIdentity = JSON.stringify(
    Object.entries(options.programs)
      .sort(([left], [right]) => compare(left, right))
      .map(([path, entry]) => [
        path,
        entry.bytes,
        entry.sha256,
        executableMode,
        executableUid,
        executableGid,
      ]),
  );
  const assetCount = Object.keys(options.assets).length;
  const assetBytes = Object.values(options.assets).reduce((sum, entry) => sum + entry.bytes, 0);
  const programCount = Object.keys(options.programs).length;
  const programBytes = Object.values(options.programs).reduce((sum, entry) => sum + entry.bytes, 0);

  const readReceipt = (stage: SeedStage): SeedReceipt | undefined => {
    const row = [
      ...options.storage.sql.exec(
        `SELECT catalog_identity, file_count, byte_count FROM ${receiptTable} WHERE stage = ?`,
        stage,
      ),
    ][0];
    if (
      typeof row?.catalog_identity !== "string" ||
      typeof row.file_count !== "number" ||
      typeof row.byte_count !== "number"
    ) {
      return undefined;
    }
    return {
      catalogIdentity: row.catalog_identity,
      fileCount: row.file_count,
      byteCount: row.byte_count,
    };
  };
  const hasReceipt = (stage: SeedStage) =>
    [...options.storage.sql.exec(`SELECT 1 AS found FROM ${receiptTable} WHERE stage = ?`, stage)]
      .length > 0;
  const bootStarted = () =>
    [...options.storage.sql.exec(`SELECT 1 AS started FROM ${bootTable} WHERE started = 1`)]
      .length > 0;
  const writeReceipt = (
    stage: SeedStage,
    catalogIdentity: string,
    fileCount: number,
    byteCount: number,
  ) => {
    options.storage.sql.exec(
      `INSERT INTO ${receiptTable} (stage, catalog_identity, file_count, byte_count)
       VALUES (?, ?, ?, ?)`,
      stage,
      catalogIdentity,
      fileCount,
      byteCount,
    );
  };
  const receiptMatches = (
    stage: SeedStage,
    catalogIdentity: string,
    fileCount: number,
    byteCount: number,
  ) => {
    const receipt = readReceipt(stage);
    return (
      receipt?.catalogIdentity === catalogIdentity &&
      receipt.fileCount === fileCount &&
      receipt.byteCount === byteCount
    );
  };

  async function assetsAreSeeded() {
    if (!receiptMatches("assets", assetIdentity, assetCount, assetBytes)) return false;
    return (await verifySeededAssets(options.filesystem().fs, options.assets)).ok;
  }

  async function programsAreSeeded() {
    if (!receiptMatches("programs", programIdentity, programCount, programBytes)) return false;
    const { filesystem, fs } = options.filesystem();
    const credentials = filesystem.posixCredentials;
    if (credentials === undefined) return false;
    for (const [path, expected] of Object.entries(options.programs)) {
      try {
        const stored = fs.fs.readFileSync(path);
        if (typeof stored === "string" || stored.byteLength !== expected.bytes) return false;
        if ((await sha256(stored)) !== expected.sha256) return false;
        const metadata = filesystem.getPosixMetadata(path);
        if (
          metadata.mode !== executableMode ||
          metadata.uid !== credentials.euid ||
          metadata.gid !== credentials.egid
        ) {
          return false;
        }
      } catch {
        return false;
      }
    }
    return true;
  }

  const programs = createProofExecutableSeedRoute({
    catalog: options.programs,
    filesystem: () => options.filesystem().filesystem,
    storage: options.storage,
    onSeeded: () => {
      if (bootStarted() || hasReceipt("programs")) {
        throw new Error("ERR_DIAGNOSTIC_PROGRAM_SEED_ORDER");
      }
      writeReceipt("programs", programIdentity, programCount, programBytes);
    },
  });

  return {
    async seedAssets(request: Request) {
      if (request.method !== "POST") return new Response("POST required", { status: 405 });
      if (request.headers.get("content-type") !== assetBundleContentType) {
        return new Response("Wrong asset bundle content type", { status: 415 });
      }
      if (bootStarted() || hasReceipt("assets") || seedingAssets) {
        throw new Error("ERR_DIAGNOSTIC_ASSET_SEED_ORDER");
      }
      seedingAssets = true;
      try {
        const entries = await decodeVerifiedAssetBundle(
          await readAssetBody(request),
          options.assets,
        );
        const { fs } = options.filesystem();
        options.storage.transactionSync(() => {
          if (bootStarted() || hasReceipt("assets")) {
            throw new Error("ERR_DIAGNOSTIC_ASSET_SEED_ORDER");
          }
          for (const entry of entries) {
            fs.fs.mkdirSync(entry.path.slice(0, entry.path.lastIndexOf("/")), { recursive: true });
            fs.fs.writeFileSync(entry.path, entry.bytes);
          }
          writeReceipt("assets", assetIdentity, entries.length, assetBytes);
        });
        return Response.json({
          ok: true,
          seededAssets: entries.length,
          seededBytes: entries.reduce((sum, entry) => sum + entry.bytes.byteLength, 0),
        });
      } finally {
        seedingAssets = false;
      }
    },
    async seedPrograms(request: Request) {
      const state = {
        bootStarted: bootStarted(),
        assetsRequired: options.requireSeed,
        assetsSeeded: await assetsAreSeeded(),
        programsSeeded: hasReceipt("programs"),
      };
      return await programs.handle(request, state);
    },
    async verifyAssets() {
      if (!receiptMatches("assets", assetIdentity, assetCount, assetBytes)) {
        throw new Error("ERR_DIAGNOSTIC_ASSETS_NOT_SEEDED");
      }
      return await verifySeededAssets(options.filesystem().fs, options.assets);
    },
    async beginBoot(): Promise<ClaudeHooksSeedStatus> {
      if (bootStarted()) throw new Error("ERR_DIAGNOSTIC_BOOT_ALREADY_STARTED");
      const assetsSeeded = await assetsAreSeeded();
      const programsSeeded = await programsAreSeeded();
      return options.storage.transactionSync(() => {
        if (bootStarted()) throw new Error("ERR_DIAGNOSTIC_BOOT_ALREADY_STARTED");
        if (options.requireSeed && !assetsSeeded) {
          throw new Error("ERR_DIAGNOSTIC_ASSETS_NOT_SEEDED");
        }
        if (!programsSeeded) throw new Error("ERR_DIAGNOSTIC_PROGRAMS_NOT_SEEDED");
        options.storage.sql.exec(`INSERT INTO ${bootTable} (started) VALUES (1)`);
        return { assetsSeeded, programsSeeded };
      });
    },
  };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
