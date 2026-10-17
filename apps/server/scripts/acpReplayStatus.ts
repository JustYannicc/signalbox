// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

export type AcpReplayStatusFileSystem = Pick<
  typeof NodeFS,
  "writeFileSync" | "renameSync" | "rmSync"
>;

export function writeAcpReplayStatus(
  statusPath: string,
  serializedStatus: string,
  fileSystem: AcpReplayStatusFileSystem = NodeFS,
): void {
  const temporaryPath = `${statusPath}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    fileSystem.writeFileSync(temporaryPath, serializedStatus, {
      encoding: "utf8",
      flag: "wx",
    });
    fileSystem.renameSync(temporaryPath, statusPath);
  } catch (cause) {
    try {
      fileSystem.rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the write or rename failure if temp-file cleanup also fails.
    }
    throw cause;
  }
}
