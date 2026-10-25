import type { FacetStorage } from "../../kernel/FacetSqliteStorage.ts";
import type { KernelCommandChild } from "../../kernel/KernelCommandForwarder.ts";
import { KernelFileSystem, KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";

export function writeUpperFile(
  filesystem: KernelFileSystem,
  path: string,
  contents: string,
  mode = 0o755,
) {
  const parent = path.slice(0, path.lastIndexOf("/")) || "/";
  const parts = parent.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    try {
      filesystem.mkdir(current);
    } catch (error) {
      if (!isFileSystemCode(error, "EEXIST")) throw error;
    }
  }
  const fd = filesystem.open(
    path,
    KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_TRUNC,
    mode,
  );
  try {
    filesystem.write(fd, new TextEncoder().encode(contents), null);
  } finally {
    filesystem.close(fd);
  }
}

export async function observe(child: KernelCommandChild) {
  try {
    await child.stdin.close();
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, status };
  } finally {
    await child.dispose();
  }
}

export function recordingChild(): KernelCommandChild {
  const drained = Promise.withResolvers<void>();
  return {
    stdin: new WritableStream<Uint8Array>({ close: () => drained.resolve() }),
    stdout: new ReadableStream<Uint8Array>({ start: (stream) => stream.close() }),
    stderr: new ReadableStream<Uint8Array>({ start: (stream) => stream.close() }),
    exited: drained.promise.then(() => ({ exitCode: 23, signal: 0, coreDumped: false })),
    signal: async () => ({ status: "ok", value: undefined }),
    dispose: async () => {},
  };
}

export function trackSqlWrites(
  storage: FacetStorage,
  onQuery: (query: string) => void,
): FacetStorage {
  return {
    sql: {
      get databaseSize() {
        return storage.sql.databaseSize;
      },
      exec(query, ...bindings) {
        onQuery(query);
        return storage.sql.exec(query, ...bindings);
      },
    },
    transactionSync: (callback) => storage.transactionSync(callback),
  };
}

function isFileSystemCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
