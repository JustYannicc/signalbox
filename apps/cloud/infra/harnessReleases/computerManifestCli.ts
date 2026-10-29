import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import type { MachineProgramInventory } from "../../src/computer/MachineProgramInventory.ts";
import { prepareTrustedComputerManifest } from "./computerManifest.ts";

type FileStat = Awaited<ReturnType<typeof NodeFSP.lstat>>;

const sameFileState = (left: FileStat, right: FileStat) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

export async function runTrustedComputerManifestCli(args: readonly string[]) {
  const { values } = NodeUtil.parseArgs({
    args: [...args],
    options: {
      programs: { type: "string" },
      "machine-inventory": { type: "string" },
      result: { type: "string" },
    },
  });
  if (!values.programs || !values["machine-inventory"] || !values.result)
    throw new Error("Pass --programs, --machine-inventory and --result.");

  const repository = NodePath.resolve(import.meta.dirname, "../../../../");
  const output = await requireFreshOutputOutsideRepository(values.result, repository);
  const inventoryPath = NodePath.resolve(values["machine-inventory"]);
  const machineInventory = await readMachineInventory(inventoryPath);
  const result = await prepareTrustedComputerManifest({
    programDirectory: NodePath.resolve(values.programs),
    machineInventory,
  });
  await NodeFSP.writeFile(output, `${JSON.stringify(result, null, 2)}\n`, {
    flag: "wx",
    mode: 0o444,
  });
  return result;
}

async function readMachineInventory(path: string): Promise<MachineProgramInventory> {
  const before = await NodeFSP.lstat(path);
  if (before.isSymbolicLink() || !before.isFile())
    throw new Error("TRUSTED_COMPUTER_INVENTORY_FILE_INVALID");
  const handle = await NodeFSP.open(path, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileState(before, opened))
      throw new Error("TRUSTED_COMPUTER_INVENTORY_FILE_CHANGED");
    const currentPath = await NodeFSP.lstat(path);
    if (
      currentPath.isSymbolicLink() ||
      !currentPath.isFile() ||
      !sameFileState(opened, currentPath)
    )
      throw new Error("TRUSTED_COMPUTER_INVENTORY_FILE_CHANGED");

    const bytes = await handle.readFile();
    const afterRead = await handle.stat();
    const afterPath = await NodeFSP.lstat(path);
    if (
      !sameFileState(opened, afterRead) ||
      bytes.byteLength !== afterRead.size ||
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      afterPath.dev !== afterRead.dev ||
      afterPath.ino !== afterRead.ino
    )
      throw new Error("TRUSTED_COMPUTER_INVENTORY_FILE_CHANGED");

    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const inventory: unknown = JSON.parse(text);
    if (inventory === null || typeof inventory !== "object" || Array.isArray(inventory))
      throw new Error("TRUSTED_COMPUTER_INVENTORY_INVALID");
    return inventory as MachineProgramInventory;
  } finally {
    await handle.close();
  }
}

async function requireFreshOutputOutsideRepository(path: string, repository: string) {
  const requested = NodePath.resolve(path);
  const parent = await NodeFSP.realpath(NodePath.dirname(requested));
  const root = await NodeFSP.realpath(repository);
  const output = NodePath.join(parent, NodePath.basename(requested));
  const relative = NodePath.relative(root, output);
  const outside =
    relative === ".." || relative.startsWith(`..${NodePath.sep}`) || NodePath.isAbsolute(relative);
  if (!outside) throw new Error("TRUSTED_COMPUTER_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  try {
    await NodeFSP.lstat(output);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return output;
    throw cause;
  }
  throw new Error("TRUSTED_COMPUTER_OUTPUT_EXISTS");
}

if (process.argv[1] && (await NodeFSP.realpath(process.argv[1])) === import.meta.filename) {
  await runTrustedComputerManifestCli(process.argv.slice(2));
}
