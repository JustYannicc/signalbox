import type { FacetStorage } from "../../src/kernel/FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "../../src/kernel/KernelFileSystem.ts";
import { decodeVerifiedAssetBundle, PROGRAM_BUNDLE_CONTENT_TYPE } from "./assetBundle.ts";
import { readAssetBody } from "./proofObservation.ts";

const executablePaths = ["/bin/bash", "/bin/cat", "/bin/rg"] as const;
const executableMode = 0o755;

export type ProofExecutableFileCatalog = Readonly<
  Record<string, { readonly bytes: number; readonly sha256: string }>
>;

export interface ProofExecutableSeedState {
  readonly bootStarted: boolean;
  readonly assetsRequired: boolean;
  readonly assetsSeeded: boolean;
}

/** Validates and writes pinned executable bytes through the proof's shared kernel filesystem. */
export function createProofExecutableSeedRoute(options: {
  readonly catalog: ProofExecutableFileCatalog;
  readonly filesystem: () => KernelFileSystem;
  readonly storage: Pick<FacetStorage, "transactionSync">;
}) {
  validateCatalog(options.catalog);
  let seeded = false;
  let seeding = false;

  return {
    get seeded() {
      return seeded;
    },
    async handle(request: Request, state: ProofExecutableSeedState): Promise<Response> {
      if (request.method !== "POST") return new Response("POST required", { status: 405 });
      if (request.headers.get("content-type") !== PROGRAM_BUNDLE_CONTENT_TYPE) {
        return new Response("Wrong program bundle content type", { status: 415 });
      }
      if (state.bootStarted || seeded || seeding || (state.assetsRequired && !state.assetsSeeded)) {
        throw new Error("ERR_DIAGNOSTIC_PROGRAM_SEED_ORDER");
      }

      seeding = true;
      try {
        const entries = await decodeVerifiedAssetBundle(
          await readAssetBody(request),
          options.catalog,
        );
        const filesystem = options.filesystem();
        options.storage.transactionSync(() => {
          for (const entry of entries) writeExecutable(filesystem, entry.path, entry.bytes);
        });
        seeded = true;
        return Response.json({
          ok: true,
          seededPrograms: entries.length,
          seededBytes: entries.reduce((sum, entry) => sum + entry.bytes.byteLength, 0),
        });
      } finally {
        seeding = false;
      }
    },
  };
}

function validateCatalog(catalog: ProofExecutableFileCatalog): void {
  const paths = Object.keys(catalog).sort();
  if (
    paths.length !== executablePaths.length ||
    paths.some((path, index) => path !== executablePaths[index])
  ) {
    throw new Error("Proof executable catalog must contain /bin/bash, /bin/cat and /bin/rg");
  }
  for (const [path, entry] of Object.entries(catalog)) {
    if (
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes <= 0 ||
      !/^[0-9a-f]{64}$/.test(entry.sha256)
    ) {
      throw new Error(`Invalid pinned executable descriptor for ${path}`);
    }
  }
}

function writeExecutable(filesystem: KernelFileSystem, path: string, bytes: Uint8Array): void {
  const fd = filesystem.open(
    path,
    KernelOpenFlags.O_CREAT | KernelOpenFlags.O_EXCL | KernelOpenFlags.O_WRONLY,
    executableMode,
  );
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = filesystem.write(fd, bytes.subarray(offset), null);
      if (written <= 0) throw new Error(`Executable seed made no write progress for ${path}`);
      offset += written;
    }
    const metadata = filesystem.getPosixMetadataForFd(fd);
    const credentials = filesystem.posixCredentials;
    if (
      Number(filesystem.fstat(fd).size) !== bytes.byteLength ||
      metadata.mode !== executableMode ||
      credentials === undefined ||
      metadata.uid !== credentials.euid ||
      metadata.gid !== credentials.egid
    ) {
      throw new Error(`Executable seed metadata differs from the canonical policy for ${path}`);
    }
  } finally {
    filesystem.close(fd);
  }
}
