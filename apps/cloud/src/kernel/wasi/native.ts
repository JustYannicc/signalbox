// @effect-diagnostics nodeBuiltinImport:off - the carry preserves native Node stdio outside Effect.
import * as NodeFS from "node:fs";
import type { Storage } from "../storage.ts";

export function nativeStorage(_path: string): Storage {
  // Upstream's native adapter needs unpublished workerd identity/retained-fd
  // helpers. A path-based substitute would lose unlinked-file identity.
  throw Object.assign(
    new Error("Native preopens are unavailable in the WASI carry; supply Storage mounts"),
    {
      code: "ERR_WASI_NATIVE_PREOPEN_UNSUPPORTED",
    },
  );
}

export default {
  read(fd: number, buffers: Uint8Array[], _options: { position: null }) {
    let count = 0;
    for (const buffer of buffers) {
      const read = NodeFS.readSync(fd, buffer, 0, buffer.byteLength, null);
      count += read;
      if (read < buffer.byteLength) break;
    }
    return count;
  },
  write(fd: number, buffers: Uint8Array[], _options: { position: null }) {
    let count = 0;
    for (const buffer of buffers) {
      const written = NodeFS.writeSync(fd, buffer, 0, buffer.byteLength, null);
      count += written;
      if (written < buffer.byteLength) break;
    }
    return count;
  },
};
