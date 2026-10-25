// File-action wire format from agentOS commit 63ae3b256749d47c7b3a7c463128d5deda57d1bb:
// https://github.com/rivet-dev/agentos/blob/63ae3b256749d47c7b3a7c463128d5deda57d1bb/toolchain/crates/wasi-ext/src/lib.rs

const ACTION_HEADER_BYTES = 24;

export type AgentOsSpawnFileAction =
  | (AgentOsSpawnActionFields & { readonly kind: "close" })
  | (AgentOsSpawnActionFields & { readonly kind: "dup2" })
  | (AgentOsSpawnActionFields & { readonly kind: "open"; readonly path: string })
  | (AgentOsSpawnActionFields & { readonly kind: "chdir"; readonly path: string })
  | (AgentOsSpawnActionFields & { readonly kind: "fchdir" })
  | (AgentOsSpawnActionFields & { readonly kind: "closefrom" });

type AgentOsSpawnActionFields = {
  readonly fd: number;
  readonly sourceFd: number;
  readonly flags: number;
  readonly mode: number;
};

type AgentOsActionResult<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "error"; readonly errno: number };

type AgentOsActionLimits = {
  readonly maxActionCount: number;
  readonly maxPathBytes: number;
};

type AgentOsActionErrnos = {
  readonly tooBig: number;
  readonly badFileDescriptor: number;
  readonly fault: number;
  readonly invalidArgument: number;
  readonly noEntry: number;
};

function decodePath(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function scanActions(
  bytes: Uint8Array,
  limits: AgentOsActionLimits,
  errno: AgentOsActionErrnos,
): AgentOsActionResult<void> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let count = 0;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < ACTION_HEADER_BYTES) {
      return { status: "error", errno: errno.invalidArgument };
    }
    const pathBytes = view.getUint32(offset + 20, true);
    const next = offset + ACTION_HEADER_BYTES + pathBytes;
    if (next > bytes.byteLength) {
      return { status: "error", errno: errno.invalidArgument };
    }
    count++;
    if (count > limits.maxActionCount || pathBytes > limits.maxPathBytes) {
      return { status: "error", errno: errno.tooBig };
    }
    offset = next;
  }
  return { status: "ok", value: undefined };
}

/** Decode ordered 24-byte headers followed immediately by each raw path. */
export function decodeAgentOsSpawnActions(
  bytes: Uint8Array,
  limits: AgentOsActionLimits,
  errno: AgentOsActionErrnos,
): AgentOsActionResult<readonly AgentOsSpawnFileAction[]> {
  const scanned = scanActions(bytes, limits, errno);
  if (scanned.status !== "ok") return scanned;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const actions: AgentOsSpawnFileAction[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const command = view.getUint32(offset, true);
    const fd = view.getInt32(offset + 4, true);
    const sourceFd = view.getInt32(offset + 8, true);
    const flags = view.getInt32(offset + 12, true);
    const mode = view.getUint32(offset + 16, true);
    const pathBytes = view.getUint32(offset + 20, true);
    offset += ACTION_HEADER_BYTES;
    const path = decodePath(bytes.subarray(offset, offset + pathBytes));
    offset += pathBytes;
    const fields = { fd, sourceFd, flags, mode } as const;

    switch (command) {
      case 1:
        if (fd < 0) return { status: "error", errno: errno.badFileDescriptor };
        actions.push(Object.freeze({ kind: "close", ...fields }));
        break;
      case 2:
        if (fd < 0 || sourceFd < 0) {
          return { status: "error", errno: errno.badFileDescriptor };
        }
        actions.push(Object.freeze({ kind: "dup2", ...fields }));
        break;
      case 3:
        if (fd < 0) return { status: "error", errno: errno.badFileDescriptor };
        if (path.length === 0) return { status: "error", errno: errno.noEntry };
        actions.push(Object.freeze({ kind: "open", ...fields, path }));
        break;
      case 4:
        if (path.length === 0) return { status: "error", errno: errno.noEntry };
        actions.push(Object.freeze({ kind: "chdir", ...fields, path }));
        break;
      case 5:
        if (fd < 0) return { status: "error", errno: errno.badFileDescriptor };
        actions.push(Object.freeze({ kind: "fchdir", ...fields }));
        break;
      case 6:
        if (fd < 0) return { status: "error", errno: errno.badFileDescriptor };
        actions.push(Object.freeze({ kind: "closefrom", ...fields }));
        break;
      default:
        return { status: "error", errno: errno.invalidArgument };
    }
  }
  return { status: "ok", value: Object.freeze(actions) };
}
