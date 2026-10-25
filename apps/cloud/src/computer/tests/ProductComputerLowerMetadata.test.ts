// @effect-diagnostics nodeBuiltinImport:off - This public composition proof compares against an isolated local filesystem.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { describe, expect, it, vi } from "vite-plus/test";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import { createNodeFs } from "../../isolate/NodeFs.ts";
import { CHILD_COREUTILS_COMMANDS } from "../ChildProgramSet.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import type { MachineFilesPort } from "../MachineFilesPort.ts";
import type { MachineProgramInventory } from "../MachineProgramInventory.ts";
import { createProductComputer } from "../ProductComputer.ts";
import type { ChildWorkerLoaderPort } from "../WorkerLoaderDispatch.ts";
import { sqliteFixture } from "../sqliteTesting.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const inventoryPath =
  NodeProcess.env.SIGNALBOX_MACHINE_PATH_INVENTORY_FILE ??
  new URL("../../../infra/kernelPrograms/machine-files/build/runner.json", import.meta.url);
if (
  NodeProcess.env.SIGNALBOX_MACHINE_PATH_INVENTORY_FILE !== undefined &&
  !NodeFS.existsSync(inventoryPath)
)
  throw new Error("Required machine inventory is missing");
const inventoryBytes = NodeFS.existsSync(inventoryPath)
  ? NodeFS.readFileSync(inventoryPath)
  : undefined;
if (
  inventoryBytes !== undefined &&
  NodeCrypto.createHash("sha256").update(inventoryBytes).digest("hex") !==
    "74186335378f14ba82d2c7ac3dfe3d2708b2b8f4f4b5faf9c009f23127ec4e19"
)
  throw new Error("ProductComputer lower metadata proof requires the frozen runner inventory");
const inventory: MachineProgramInventory | undefined =
  inventoryBytes === undefined ? undefined : JSON.parse(inventoryBytes.toString("utf8"));

type MetadataStats = {
  isDirectory: () => boolean;
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
  mode: number;
  size: number;
};

type MetadataFs = {
  existsSync: (path: string) => boolean;
  readdirSync: (path: string) => readonly unknown[];
  statSync: (path: string) => MetadataStats;
  lstatSync: (path: string) => MetadataStats;
  realpathSync: (path: string) => string | Uint8Array;
};

const localFs: MetadataFs = {
  existsSync: (path) => NodeFS.existsSync(path),
  readdirSync: (path) => NodeFS.readdirSync(path).map(String),
  statSync: (path) => NodeFS.statSync(path),
  lstatSync: (path) => NodeFS.lstatSync(path),
  realpathSync: (path) => NodeFS.realpathSync(path, "utf8"),
};

describe.skipIf(inventory === undefined)("ProductComputer synchronous lower metadata", () => {
  it("matches local metadata and copies lower home directories up without a machine", async () => {
    const lowerChildren = inventory!.entries.filter(
      ({ path }) => NodePath.posix.dirname(path) === "/usr",
    );
    const usr = inventory!.entries.find(({ path }) => path === "/usr");
    const bin = inventory!.entries.find(({ path }) => path === "/bin");
    expect(usr?.type).toBe("directory");
    expect(bin).toMatchObject({ type: "symlink", target: "usr/bin" });

    const localRoot = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "signalbox-lower-metadata-"),
    );
    const localUsr = NodePath.join(localRoot, "usr");
    const canonicalLocalRoot = NodeFS.realpathSync(localRoot);
    NodeFS.mkdirSync(localUsr, { recursive: true, mode: 0o755 });
    for (const child of lowerChildren) {
      const name = NodePath.posix.basename(child.path);
      const path = NodePath.join(localUsr, name);
      if (child.type === "directory") NodeFS.mkdirSync(path, { mode: child.mode & 0o777 });
      else if (child.type === "symlink" && child.target !== undefined)
        NodeFS.symlinkSync(child.target, path);
      else NodeFS.writeFileSync(path, "", { mode: child.mode & 0o777 });
    }
    NodeFS.symlinkSync("usr/bin", NodePath.join(localRoot, "bin"));

    const database = sqliteFixture();
    const rootStorage = createFacetSqliteStorage(database.storage, () => 1n);
    rootStorage.posix.initialize(rootStorage.root, { uid: 1000, gid: 1000, mode: 0o755 });
    const filesystem = new KernelFileSystem({
      mounts: [{ path: "/", storage: rootStorage }],
      posix: {
        credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 },
        umask: 0o022,
      },
    });
    const wakes = new KernelWakeRegistry();
    let machineLookups = 0;
    let machineSpawns = 0;
    // This is the Runner file forwarder's empty state: no live generation or transport.
    const machineFiles: MachineFilesPort = {
      current: () => ({ generation: null, pristine: false }),
      markExecuted: async () => {},
      async lookup() {
        machineLookups++;
        throw new Error("Machine transport is unavailable in this proof");
      },
    };
    const code = { mainModule: "unused.js", modules: { "unused.js": "export default class {}" } };
    const loader: ChildWorkerLoaderPort = {
      async run() {
        throw new Error("The filesystem proof must not start a child program");
      },
    };
    const computer = createProductComputer({
      threadId: "product-computer-lower-metadata",
      filesystem,
      wakes,
      capacity: new ChildWorkerCapacity(2),
      loader,
      programs: {
        bash: code,
        busyboxCat: code,
        busyboxApplets: code,
        ripgrep: code,
        git: code,
        sed: code,
        coreutils: Object.fromEntries(
          CHILD_COREUTILS_COMMANDS.map((command) => [command, code]),
        ) as Record<(typeof CHILD_COREUTILS_COMMANDS)[number], typeof code>,
      },
      machineInventory: inventory!,
      machine: () => ({
        files: machineFiles,
        async spawn() {
          machineSpawns++;
          throw new Error("Machine transport is unavailable in this proof");
        },
      }),
      signal: new AbortController().signal,
    });

    const productFs = createNodeFs(filesystem).fs;
    const localPath = (path: string) => NodePath.join(localRoot, path.slice(1));
    const pathString = (input: string | Uint8Array) =>
      typeof input === "string" ? input : new TextDecoder().decode(input);
    const logicalRealpath = (input: string | Uint8Array) => {
      const path = pathString(input);
      return path === canonicalLocalRoot
        ? "/"
        : path.startsWith(`${canonicalLocalRoot}/`)
          ? path.slice(canonicalLocalRoot.length)
          : path;
    };
    const captured = <A>(operation: () => A, summarize: (value: A) => unknown) => {
      try {
        return { value: summarize(operation()) };
      } catch (error) {
        return { error: { code: (error as NodeJS.ErrnoException).code } };
      }
    };
    const stat = (fs: MetadataFs, path: string, follow: boolean) =>
      captured(
        () => (follow ? fs.statSync(path) : fs.lstatSync(path)),
        (result) => ({
          directory: result.isDirectory(),
          file: result.isFile(),
          symlink: result.isSymbolicLink(),
          ...(result.isSymbolicLink() ? {} : { mode: result.mode & 0o777 }),
          ...(result.isFile() ? { size: result.size } : {}),
        }),
      );
    const inspectMissing = (
      fs: MetadataFs,
      path: string,
      normalize: (value: string | Uint8Array) => string,
    ) => ({
      exists: fs.existsSync(path),
      readdir: captured(
        () => fs.readdirSync(path),
        (names) => names.map(String).sort(),
      ),
      stat: captured(
        () => fs.statSync(path),
        (result) => ({ directory: result.isDirectory(), file: result.isFile() }),
      ),
      lstat: captured(
        () => fs.lstatSync(path),
        (result) => ({ directory: result.isDirectory(), symlink: result.isSymbolicLink() }),
      ),
      realpath: captured(() => fs.realpathSync(path), normalize),
    });

    try {
      for (const path of ["/work", "/work/missing"]) {
        const product = inspectMissing(productFs, path, pathString);
        const expected = inspectMissing(localFs, localPath(path), logicalRealpath);
        expect({ product, expected, machineLookups, machineSpawns }).toEqual({
          product: expected,
          expected,
          machineLookups: 0,
          machineSpawns: 0,
        });
      }

      expect(productFs.readdirSync("/usr").map(String).sort()).toEqual(
        NodeFS.readdirSync(localUsr).map(String).sort(),
      );

      const localWorkspace = localPath("/work");
      NodeFS.mkdirSync(localWorkspace, { mode: 0o755 });
      productFs.mkdirSync("/work");
      expect(productFs.existsSync("/work/created.txt")).toBe(
        NodeFS.existsSync(localPath("/work/created.txt")),
      );
      NodeFS.writeFileSync(NodePath.join(localWorkspace, "created.txt"), "upper");
      productFs.writeFileSync("/work/created.txt", "upper");
      expect(productFs.existsSync("/work/created.txt")).toBe(true);
      expect(productFs.readdirSync("/work").map(String).sort()).toEqual(
        NodeFS.readdirSync(localWorkspace).map(String).sort(),
      );
      expect(stat(productFs, "/work", true)).toEqual(stat(localFs, localWorkspace, true));

      expect(stat(productFs, "/bin", false)).toEqual(
        stat(localFs, NodePath.join(localRoot, "bin"), false),
      );
      expect(productFs.statSync("/bin").isDirectory()).toBe(
        NodeFS.statSync(NodePath.join(localRoot, "bin")).isDirectory(),
      );
      expect(productFs.realpathSync("/bin")).toBe("/usr/bin");
      expect(logicalRealpath(NodeFS.realpathSync(NodePath.join(localRoot, "bin")))).toBe(
        "/usr/bin",
      );

      const writtenBytes = Uint8Array.from([0, 255, 1, 128, 10]);
      productFs.mkdirSync("/home/claude", { mode: 0o700 });
      await productFs.promises.mkdir("/home/node/.config/claude/cache", {
        recursive: true,
        mode: 0o700,
      });
      await productFs.promises.writeFile("/home/user/.claude-settings", writtenBytes);
      await productFs.promises.writeFile("/work/rename-source", writtenBytes);
      await productFs.promises.rename(
        "/work/rename-source",
        "/home/user/signalbox/renamed-settings.bin",
      );

      expect([...(await productFs.promises.readFile("/home/user/.claude-settings"))]).toEqual([
        ...writtenBytes,
      ]);
      expect([
        ...(await productFs.promises.readFile("/home/user/signalbox/renamed-settings.bin")),
      ]).toEqual([...writtenBytes]);
      expect(productFs.statSync("/home/claude").isDirectory()).toBe(true);
      const nodeMode = Number((await productFs.promises.stat("/home/node")).mode);
      expect(nodeMode & 0o777).toBe(0o755);
      expect((await productFs.promises.stat("/home/user/signalbox")).isDirectory()).toBe(true);
      expect((await productFs.promises.readdir("/home")).map(String).sort()).toEqual([
        "claude",
        "node",
        "user",
      ]);
      expect((await productFs.promises.readdir("/home/node")).map(String).sort()).toEqual([
        ".bash_logout",
        ".bashrc",
        ".config",
        ".profile",
      ]);
      expect((await productFs.promises.readdir("/home/user/signalbox")).map(String).sort()).toEqual(
        ["renamed-settings.bin"],
      );
      expect(() => productFs.mkdirSync("/home/node/.bashrc")).toThrow(
        expect.objectContaining({ code: "EEXIST" }),
      );
      expect(() => productFs.mkdirSync("/home/node/.bashrc/child", { recursive: true })).toThrow(
        expect.objectContaining({ code: "ENOTDIR" }),
      );
      expect(NodeFS.readFileSync(inventoryPath)).toEqual(inventoryBytes);
      expect({ machineLookups, machineSpawns }).toEqual({ machineLookups: 0, machineSpawns: 0 });
    } finally {
      await computer.close();
      wakes.dispose();
      filesystem.dispose();
      database.close();
      NodeFS.rmSync(localRoot, { recursive: true, force: true });
    }
  });
});
