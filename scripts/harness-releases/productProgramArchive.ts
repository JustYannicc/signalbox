import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

export function sha256(bytes: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

export function verifyPinnedBytes(
  bytes: Uint8Array,
  pin: { readonly bytes: number; readonly sha256: string },
  label: string,
): void {
  if (bytes.byteLength !== pin.bytes || sha256(bytes) !== pin.sha256)
    throw new Error(`PRODUCT_PROGRAM_HASH_MISMATCH:${label}`);
}

export function safeRelative(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !NodePath.posix.isAbsolute(path) &&
    !NodePath.win32.isAbsolute(path) &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

export async function readTarMember(
  archivePath: string,
  member: string,
  maxBuffer = 16 * 1024 * 1024,
): Promise<Uint8Array> {
  const normalized = member.startsWith("./") ? member.slice(2) : member;
  if (!safeRelative(normalized)) throw new Error("PRODUCT_PROGRAM_TAR_MEMBER_INVALID");
  try {
    const result = await execFile("tar", ["-xOf", archivePath, member], {
      encoding: "buffer",
      maxBuffer,
    });
    return new Uint8Array(result.stdout);
  } catch (cause) {
    throw new Error(`PRODUCT_PROGRAM_TAR_MEMBER_MISSING:${member}`, { cause });
  }
}

export async function writePinnedTarFiles(options: {
  readonly archivePath: string;
  readonly root: string;
  readonly files: ReadonlyArray<{
    readonly member: string;
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly mode: number;
  }>;
}): Promise<void> {
  const seen = new Set<string>();
  for (const file of options.files) {
    if (!safeRelative(file.path) || seen.has(file.path))
      throw new Error("PRODUCT_PROGRAM_TAR_OUTPUT_PATH_INVALID");
    seen.add(file.path);
    const bytes = await readTarMember(options.archivePath, file.member);
    verifyPinnedBytes(bytes, file, file.member);
    const target = NodePath.join(options.root, file.path);
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true, mode: 0o755 });
    await NodeFSP.writeFile(target, bytes, { flag: "wx", mode: file.mode });
    await NodeFSP.chmod(target, file.mode);
  }
}

export function mountAospkgTar(bytes: Uint8Array): Uint8Array {
  const container = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    container.byteLength < 16 ||
    !container.subarray(0, 4).equals(Buffer.from([0x89, 0x41, 0x4f, 0x53]))
  ) {
    throw new Error("PRODUCT_PROGRAM_AOSPKG_HEADER_INVALID");
  }
  const formatVersion = container.readUInt16LE(4);
  const payloadOffset = 16 + container.readUInt32LE(8) + container.readUInt32LE(12);
  if ((formatVersion !== 1 && formatVersion !== 2) || payloadOffset >= container.byteLength)
    throw new Error("PRODUCT_PROGRAM_AOSPKG_LAYOUT_INVALID");
  return new Uint8Array(container.subarray(payloadOffset));
}

export function applyGitTemplateSubstitutions(relativePath: string, bytes: Uint8Array): Uint8Array {
  if (!safeRelative(relativePath)) throw new Error("PRODUCT_PROGRAM_TEMPLATE_PATH_INVALID");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const replaced = text.split("\n").map((line, index) => {
    const shebang = index === 0 ? line.replace(/^#!.*\/sh$/, "#!/bin/sh") : line;
    return shebang.replace("@SHELL_PATH@", "/bin/sh").replaceAll("@PERL_PATH@", "perl");
  });
  return new TextEncoder().encode(replaced.join("\n"));
}
