import type { WasiFileSystemImportAdapter } from "./wasi/internal_wasi_lifecycle.ts";
import type { WasiCall } from "./wasi/internal_wasi_calls.ts";

/** Nimbus fills POSIX type/mode/owner only when preview1 leaves the type unknown. */
export const nimbusWasiMetadata: WasiFileSystemImportAdapter = (memory, imports) => {
  const metadata = (out: number, error: number) => {
    if (error !== 0) return error;
    const record = memory.view(out, 64);
    const type = record.getUint8(16);
    // Keep streams' native type: they have no inode for Nimbus's metadata import.
    if (type === 3 || type === 4 || type === 7) record.setUint8(16, 0);
    return 0;
  };
  return {
    ...imports,
    fd_filestat_get: function* (fd, out): WasiCall<number> {
      return metadata(out, yield* imports.fd_filestat_get(fd, out));
    },
    path_filestat_get: function* (fd, flags, path, length, out): WasiCall<number> {
      return metadata(out, yield* imports.path_filestat_get(fd, flags, path, length, out));
    },
  };
};
