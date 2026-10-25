import { unsupportedNodeOperation } from "./NodeError.ts";
import type { NodeProcessFileSystem } from "./context.ts";

export function createProcessCredentialGetters(filesystem: NodeProcessFileSystem) {
  const credentials = filesystem.posixPolicy?.credentials;
  if (!credentials) {
    const unsupported = (name: string) => () => unsupportedNodeOperation(`process.${name}`);
    return {
      getuid: unsupported("getuid"),
      getgid: unsupported("getgid"),
      geteuid: unsupported("geteuid"),
      getegid: unsupported("getegid"),
      getgroups: unsupported("getgroups"),
    };
  }

  const supplementaryGroups = [...(credentials.groups ?? [])];
  return {
    getuid: () => credentials.uid,
    getgid: () => credentials.gid,
    geteuid: () => credentials.euid,
    getegid: () => credentials.egid,
    // Node guarantees the effective group is present; Set removes duplicate policy entries.
    getgroups: () => [...new Set([...supplementaryGroups, credentials.egid])],
  };
}
