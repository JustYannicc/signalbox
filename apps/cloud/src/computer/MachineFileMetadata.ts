import type { MachineFileStat } from "@signalbox/runner-protocol/MachineFilesProtocol";
import type { KernelLowerFileSystemEntry } from "../kernel/KernelLowerFileSystem.ts";

type MachineMetadata = Omit<MachineFileStat, "birthtimeNs">;

/** Image and live metadata have the same kernel representation. */
export function machineFileMetadata(
  path: string,
  metadata: MachineMetadata,
): KernelLowerFileSystemEntry {
  const type = metadata.type;
  if (type !== "file" && type !== "directory" && type !== "symlink")
    throw Object.assign(new Error(`Machine file type is unavailable: ${type}`), {
      code: "ENOTSUP",
    });
  const nativeIno = metadata.ino === undefined ? undefined : BigInt(metadata.ino);
  const nativeDev = metadata.dev === undefined ? undefined : BigInt(metadata.dev);
  const identity =
    nativeIno !== undefined && nativeDev !== undefined && nativeIno > 0n && nativeDev > 0n;
  return {
    path,
    stat: {
      type,
      size: BigInt(metadata.size),
      nlink: BigInt(metadata.nlink),
      atimeNs: BigInt(metadata.atimeNs),
      mtimeNs: BigInt(metadata.mtimeNs),
      ctimeNs: BigInt(metadata.ctimeNs),
    },
    metadata: { mode: metadata.mode & 0o7777, uid: metadata.uid, gid: metadata.gid },
    ...(identity ? { nativeIno, nativeDev } : {}),
  };
}
