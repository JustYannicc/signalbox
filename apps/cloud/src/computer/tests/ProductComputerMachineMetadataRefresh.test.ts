// @effect-diagnostics nodeBuiltinImport:off - this public composition test uses only an isolated in-memory machine filesystem.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { describe, expect, it, vi } from "vite-plus/test";
import type {
  MachineFileOperationResult,
  MachineFileStat,
} from "@signalbox/runner-protocol/MachineFilesProtocol";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { createKernelAsyncWasi } from "../../kernel/KernelWasi.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import { wasmImportReactor } from "../../kernel/tests/wasmGuest.ts";
import { createNodeFs } from "../../isolate/NodeFs.ts";
import { CHILD_COREUTILS_COMMANDS } from "../ChildProgramSet.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import type { MachineFileSourceState, MachineFilesPort } from "../MachineFilesPort.ts";
import type { MachineProgramEntry, MachineProgramInventory } from "../MachineProgramInventory.ts";
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
  throw new Error("Machine metadata refresh proof requires the frozen runner inventory");
const machineInventory: MachineProgramInventory | undefined =
  inventoryBytes === undefined ? undefined : JSON.parse(inventoryBytes.toString("utf8"));

const routeCommand = {
  executable: "/usr/bin/uname",
  argv: ["uname", "-s"],
  cwd: "/",
  env: { PATH: machineInventory?.path.join(":") ?? "/usr/bin" },
};
const code = { mainModule: "unused.js", modules: { "unused.js": "export default class {}" } };

type Hooks = {
  readonly beforeLinkBatch?: (signal: AbortSignal) => void;
  readonly changeGenerationDuringLinkBatch?: boolean;
  readonly failLinkBatch?: Error;
};

function makeFixture(hooks: Hooks = {}) {
  if (machineInventory === undefined) throw new Error("Frozen inventory is required");
  const entries = new Map(machineInventory.entries.map((entry) => [entry.path, entry]));
  const liveInodes = new Map<string, string>();
  let nextInode = 1_000_000n;
  const machineStat = (entry: MachineProgramEntry): MachineFileStat => {
    let ino = entry.ino ?? liveInodes.get(entry.path);
    if (ino === undefined) {
      ino = String(nextInode++);
      liveInodes.set(entry.path, ino);
    }
    return {
      mode: entry.mode,
      type: entry.type,
      size: entry.size,
      uid: entry.uid,
      gid: entry.gid,
      dev: entry.dev ?? "1",
      ino,
      nlink: entry.nlink,
      atimeNs: entry.atimeNs,
      mtimeNs: entry.mtimeNs,
      ctimeNs: entry.ctimeNs,
    };
  };
  const resolveMachinePath = (path: string, followFinal: boolean) => {
    let components: string[] = [];
    let pending = path.split("/").filter(Boolean);
    let links = 0;
    while (pending.length > 0) {
      const component = pending.shift()!;
      if (component === ".") continue;
      if (component === "..") {
        components.pop();
        continue;
      }
      const candidate = `/${[...components, component].join("/")}`;
      const entry = entries.get(candidate);
      const isFinal = pending.length === 0;
      if (entry?.type === "symlink" && (!isFinal || followFinal)) {
        if (++links > 40 || entry.target === undefined) throw new Error("Invalid test symlink");
        if (entry.target.startsWith("/")) components = [];
        pending.unshift(...entry.target.split("/").filter(Boolean));
        continue;
      }
      components.push(component);
    }
    return `/${components.join("/")}`;
  };
  for (const root of machineInventory.excludedRoots) {
    if (entries.has(root)) continue;
    const directory = ["/dev", "/proc", "/run", "/sys", "/tmp", "/var/tmp"].includes(root);
    entries.set(root, {
      path: root,
      type: directory ? "directory" : "file",
      size: "0",
      nlink: directory ? "2" : "1",
      atimeNs: "1",
      mtimeNs: "1",
      ctimeNs: "1",
      mode: directory ? 0o40755 : 0o100644,
      uid: 0,
      gid: 0,
      ino: String(nextInode++),
      dev: "1",
    });
  }

  const database = sqliteFixture();
  const storage = createFacetSqliteStorage(database.storage, () => 1n);
  storage.posix.initialize(storage.root, { uid: 1000, gid: 1000, mode: 0o755 });
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    posix: {
      credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 },
      umask: 0o022,
    },
  });
  const wakes = new KernelWakeRegistry();
  let state: MachineFileSourceState = {
    generation: 1,
    pristine: true,
    imageDigest: machineInventory.imageDigest,
  };
  let pendingExit:
    | ((value: { exitCode: number; signal: number; coreDumped: boolean }) => void)
    | undefined;
  let leaseHeld = false;
  let routeActive = false;
  let generationChanged = false;
  let linkBatchStarted = false;
  const lookups: Array<{ readonly generation: number; readonly operations: readonly unknown[] }> =
    [];
  const files: MachineFilesPort = {
    current: () => state,
    async markExecuted(generation) {
      if (generation !== state.generation) throw new Error("stale generation before execute");
      state = { ...state, pristine: false };
    },
    async lookup(input, signal) {
      signal.throwIfAborted();
      if (routeActive && !leaseHeld)
        throw new Error("Refresh ran after the machine command lease ended");
      const isLinkBatch = input.operations.some(
        (operation) => operation.op === "readlink" && operation.id !== "link",
      );
      if (isLinkBatch) {
        linkBatchStarted = true;
        hooks.beforeLinkBatch?.(signal);
        if (hooks.failLinkBatch !== undefined) throw hooks.failLinkBatch;
      }
      if (isLinkBatch && hooks.changeGenerationDuringLinkBatch && !generationChanged) {
        generationChanged = true;
        state = { ...state, generation: 2 };
      }
      lookups.push({ generation: input.generation, operations: structuredClone(input.operations) });
      const result = input.operations.map((operation): MachineFileOperationResult => {
        if (operation.op === "lstat" || operation.op === "stat") {
          const entry = entries.get(resolveMachinePath(operation.path, operation.op === "stat"));
          return entry === undefined
            ? {
                id: operation.id,
                op: operation.op,
                error: { code: "ENOENT", message: "Missing live path" },
              }
            : { id: operation.id, op: operation.op, stat: machineStat(entry) };
        }
        if (operation.op === "readdir") {
          const directoryPath = resolveMachinePath(operation.path, true);
          const directory = entries.get(directoryPath);
          if (directory === undefined)
            return {
              id: operation.id,
              op: operation.op,
              error: { code: "ENOENT", message: "Missing live directory" },
            };
          if (directory.type !== "directory")
            return {
              id: operation.id,
              op: operation.op,
              error: { code: "ENOTDIR", message: "Not a directory" },
            };
          const children = [...entries.values()]
            .filter((entry) => entry.path !== directoryPath && parent(entry.path) === directoryPath)
            .sort((left, right) => left.path.localeCompare(right.path));
          const offset = operation.cursor === undefined ? 0 : Number(operation.cursor);
          const page = children.slice(offset, offset + 128);
          const next = offset + page.length;
          return {
            id: operation.id,
            op: operation.op,
            nextCursor: next < children.length ? String(next) : null,
            entries: page.map((entry) => ({
              name: entry.path.slice(entry.path.lastIndexOf("/") + 1),
              type: entry.type,
              stat: machineStat(entry),
            })),
          };
        }
        if (operation.op === "readlink") {
          const entry = entries.get(resolveMachinePath(operation.path, false));
          if (entry?.type !== "symlink" || entry.target === undefined)
            return {
              id: operation.id,
              op: operation.op,
              error: { code: "EINVAL", message: "Not a symlink" },
            };
          return {
            id: operation.id,
            op: operation.op,
            targetBase64: Buffer.from(entry.target).toString("base64"),
          };
        }
        throw new Error("Metadata refresh must not request file bytes or search PATH");
      });
      return { generation: input.generation, results: result };
    },
  };
  const loader: ChildWorkerLoaderPort = {
    async run() {
      throw new Error("The proof must not start a guest or child Worker");
    },
  };
  const computer = createProductComputer({
    threadId: "machine-metadata-refresh",
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
      coreutils: Object.fromEntries(CHILD_COREUTILS_COMMANDS.map((name) => [name, code])) as Record<
        (typeof CHILD_COREUTILS_COMMANDS)[number],
        typeof code
      >,
    },
    machineInventory,
    signal: new AbortController().signal,
    machine: () => ({
      files,
      async spawn() {
        if (state.pristine) throw new Error("Machine was not marked dirty before route start");
        leaseHeld = true;
        routeActive = true;
        const git = entries.get("/usr/bin/git");
        if (git === undefined) throw new Error("Frozen inventory is missing /usr/bin/git");
        entries.set("/usr/bin/git", {
          ...git,
          size: (BigInt(git.size) + 1n).toString(),
          mtimeNs: (BigInt(git.mtimeNs) + 1n).toString(),
          ino: String(nextInode++),
        });
        entries.set("/usr/bin/signalbox-new-tool", {
          path: "/usr/bin/signalbox-new-tool",
          type: "file",
          size: "9",
          nlink: "1",
          atimeNs: "2",
          mtimeNs: "3",
          ctimeNs: "4",
          mode: 0o100755,
          uid: 1000,
          gid: 1000,
          ino: String(nextInode++),
          dev: "1",
        });
        entries.set("/usr/signalbox-new-dir", {
          path: "/usr/signalbox-new-dir",
          type: "directory",
          size: "0",
          nlink: "2",
          atimeNs: "2",
          mtimeNs: "3",
          ctimeNs: "4",
          mode: 0o40750,
          uid: 1000,
          gid: 1000,
          ino: String(nextInode++),
          dev: "1",
        });
        const exit = Promise.withResolvers<{
          exitCode: number;
          signal: number;
          coreDumped: boolean;
        }>();
        pendingExit = exit.resolve;
        return {
          stdin: new WritableStream<Uint8Array>(),
          stdout: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          }),
          stderr: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          }),
          exited: exit.promise,
          signal: async () => ({ status: "ok" as const, value: undefined }),
          async dispose() {
            leaseHeld = false;
            routeActive = false;
          },
        };
      },
    }),
  });
  const fs = createNodeFs(filesystem).fs;
  return {
    fs,
    filesystem,
    wakes,
    computer,
    files,
    lookups,
    state: () => state,
    linkBatchStarted: () => linkBatchStarted,
    async route(signal = new AbortController().signal) {
      const child = await computer.exec(routeCommand, signal, undefined);
      const machineExitAt = performance.now();
      pendingExit?.({ exitCode: 0, signal: 0, coreDumped: false });
      const exit = await child.exited;
      const completionAt = performance.now();
      await Promise.all([
        new Response(child.stdout).arrayBuffer(),
        new Response(child.stderr).arrayBuffer(),
      ]);
      await child.dispose();
      return { exit, refreshMs: completionAt - machineExitAt };
    },
    async close() {
      await computer.close();
      wakes.dispose();
      filesystem.dispose();
      database.close();
    },
  };
}

function parent(path: string) {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}

const available = machineInventory !== undefined;

describe.skipIf(!available)("ProductComputer machine metadata refresh", () => {
  it("refreshes cold, changed, and missing names before resolving a successful machine exit", async () => {
    const fixture = makeFixture();
    try {
      const beforeStat = fixture.fs.lstatSync("/usr/bin/git");
      const beforeDirectory = fixture.fs.readdirSync("/usr").map(String).sort();
      const { exit, refreshMs } = await fixture.route();

      expect(exit).toEqual({ exitCode: 0, signal: 0, coreDumped: false });
      expect(fixture.fs.lstatSync("/usr/bin/git").size).toBe(beforeStat.size + 1);
      expect(fixture.fs.statSync("/bin/git").size).toBe(beforeStat.size + 1);
      expect(fixture.fs.readdirSync("/usr").map(String).sort()).toEqual(
        [...beforeDirectory, "signalbox-new-dir"].sort(),
      );
      expect(fixture.fs.readdirSync("/bin").map(String)).toContain("git");
      expect(fixture.fs.lstatSync("/usr/signalbox-new-dir")).toMatchObject({
        mode: 0o40750,
        size: 0,
      });
      expect(fixture.fs.lstatSync("/usr/bin/sed").isFile()).toBe(true);
      expect(fixture.fs.lstatSync("/usr/bin/signalbox-new-tool")).toMatchObject({
        mode: 0o100755,
        size: 9,
      });
      expect(() => fixture.fs.lstatSync("/usr/bin/signalbox-missing")).toThrow(
        expect.objectContaining({ code: "ENOENT" }),
      );
      expect(fixture.state()).toMatchObject({ generation: 1, pristine: false });
      expect(fixture.lookups.length).toBeGreaterThan(0);
      expect(
        fixture.lookups
          .flatMap(({ operations }) => operations)
          .some(
            (operation) =>
              typeof operation === "object" &&
              operation !== null &&
              "op" in operation &&
              operation.op === "readdir" &&
              "path" in operation &&
              operation.path === "/usr/bin",
          ),
      ).toBe(true);
      expect(refreshMs).toBeGreaterThanOrEqual(0);
    } finally {
      await fixture.close();
    }
  });

  it("uses async WASI and sync NodeFs creation with POSIX semantics", async () => {
    const fixture = makeFixture();
    const mkdirWasi = createKernelAsyncWasi({
      filesystem: fixture.filesystem,
      wakes: fixture.wakes,
    });
    const mkdirInstance = new WebAssembly.Instance(
      wasmImportReactor(
        "wasi_snapshot_preview1",
        "path_create_directory",
        ["i32", "i32", "i32"],
        ["i32"],
      ),
      mkdirWasi.wasi.getImportObject(),
    );
    await mkdirWasi.wasi.initialize(mkdirInstance);
    const runMkdir = mkdirInstance.exports.run as (...args: Array<number | bigint>) => unknown;
    const mkdirMemory = mkdirInstance.exports.memory as WebAssembly.Memory;
    const openWasi = createKernelAsyncWasi({
      filesystem: fixture.filesystem,
      wakes: fixture.wakes,
    });
    const openInstance = new WebAssembly.Instance(
      wasmImportReactor(
        "wasi_snapshot_preview1",
        "path_open",
        ["i32", "i32", "i32", "i32", "i32", "i64", "i64", "i32", "i32"],
        ["i32"],
      ),
      openWasi.wasi.getImportObject(),
    );
    await openWasi.wasi.initialize(openInstance);
    const runOpen = openInstance.exports.run as (...args: Array<number | bigint>) => unknown;
    const openMemory = openInstance.exports.memory as WebAssembly.Memory;
    try {
      await fixture.route();
      fixture.filesystem.setNextCreateMode(0o700);
      writeGuestPath(mkdirMemory, 64, "usr/wasi-created");
      const rootFd = [...fixture.filesystem.descriptors.entries()].find(
        ([, descriptor]) => descriptor.preopen === true && descriptor.kind === "directory",
      )?.[0];
      if (rootFd === undefined) throw new Error("Root preopen descriptor is missing");
      expect(await mkdirWasi.wasi.run(runMkdir, rootFd, 64, "usr/wasi-created".length)).toBe(0);
      expect(fixture.filesystem.getPosixMetadata("/usr/wasi-created")).toEqual({
        mode: 0o700,
        uid: 1000,
        gid: 1000,
      });
      expect(
        fixture.lookups
          .flatMap(({ operations }) => operations)
          .some(
            (operation) =>
              typeof operation === "object" &&
              operation !== null &&
              "path" in operation &&
              operation.path === "/usr/wasi-created",
          ),
      ).toBe(true);
      writeGuestPath(mkdirMemory, 64, "usr/wasi-created");
      expect(await mkdirWasi.wasi.run(runMkdir, rootFd, 64, "usr/wasi-created".length)).toBe(20);

      writeGuestPath(openMemory, 64, "usr/wasi-open-created");
      const wasiOpenErrno = await openWasi.wasi.run(
        runOpen,
        rootFd,
        0,
        64,
        "usr/wasi-open-created".length,
        1 | 4,
        0n,
        0n,
        0,
        256,
      );
      expect(wasiOpenErrno).toBe(0);
      const wasiFd = new DataView(openMemory.buffer).getUint32(256, true);
      fixture.filesystem.close(wasiFd);
      expect(fixture.filesystem.getPosixMetadata("/usr/wasi-open-created")).toEqual({
        mode: 0o644,
        uid: 1000,
        gid: 1000,
      });

      const syncDirectory = "/usr/node-sync-mkdir";
      fixture.fs.mkdirSync(syncDirectory, { mode: 0o700 });
      expect(fixture.filesystem.getPosixMetadata(syncDirectory)).toEqual({
        mode: 0o700,
        uid: 1000,
        gid: 1000,
      });

      const syncPath = "/usr/sync-open-created";
      const syncDestination = "/usr/sync-renamed-created";
      const syncDescriptor = fixture.fs.openSync(syncPath, "wx", 0o666);
      try {
        const created = fixture.fs.fstatSync(syncDescriptor);
        expect(Number(created.mode) & 0o777).toBe(0o644);
        expect(created.uid).toBe(1000);
        expect(created.gid).toBe(1000);
        expect(() => fixture.fs.openSync(syncPath, "wx")).toThrow(
          expect.objectContaining({ code: "EEXIST" }),
        );

        const destinationDirectory = "/usr/sync-rename-destination";
        fixture.fs.mkdirSync(destinationDirectory);
        expect(() => fixture.fs.renameSync(syncPath, destinationDirectory)).toThrow(
          expect.objectContaining({ code: "EISDIR" }),
        );
        expect(fixture.fs.statSync(syncPath).isFile()).toBe(true);

        fixture.fs.renameSync(syncPath, syncDestination);
        const renamed = fixture.fs.statSync(syncDestination);
        expect(renamed.ino).toBe(created.ino);
        expect(fixture.fs.fstatSync(syncDescriptor).ino).toBe(created.ino);
        expect(() => fixture.fs.statSync(syncPath)).toThrow(
          expect.objectContaining({ code: "ENOENT" }),
        );
      } finally {
        fixture.fs.closeSync(syncDescriptor);
      }

      await fixture.fs.promises.mkdir("/usr/node-mkdir", { mode: 0o700 });
      expect(fixture.fs.readdirSync("/usr").map(String)).toContain("node-mkdir");
      const handle = await fixture.fs.promises.open("/usr/open-created", "wx", 0o666);
      await handle.writeFile("upper");
      const created = await handle.stat();
      expect(Number(created.mode) & 0o777).toBe(0o644);
      expect(created.uid).toBe(1000);
      expect(created.gid).toBe(1000);
      await expect(fixture.fs.promises.open("/usr/open-created", "wx")).rejects.toMatchObject({
        code: "EEXIST",
      });
      await fixture.fs.promises.rename("/usr/open-created", "/usr/renamed-created");
      const renamed = await fixture.fs.promises.stat("/usr/renamed-created");
      expect(renamed).toMatchObject({
        mode: 0o100644,
        uid: 1000,
        gid: 1000,
      });
      expect(renamed.ino).toBe(created.ino);
      expect((await handle.stat()).ino).toBe(created.ino);
      await handle.close();
      await expect(fixture.fs.promises.stat("/usr/open-created")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await Promise.all([mkdirWasi.wasi.close(), openWasi.wasi.close()]);
      await fixture.close();
    }
  });

  it.each(["failure", "cancellation", "stale generation"] as const)(
    "does not expose partial or stale metadata after refresh %s",
    async (kind) => {
      const controller = new AbortController();
      const reason = new Error("refresh cancelled by caller");
      let fired = false;
      const fixture = makeFixture({
        ...(kind === "failure" ? { failLinkBatch: new Error("controlled refresh failure") } : {}),
        ...(kind === "cancellation"
          ? {
              beforeLinkBatch: () => {
                if (!fired) {
                  fired = true;
                  controller.abort(reason);
                }
              },
            }
          : {}),
        ...(kind === "stale generation" ? { changeGenerationDuringLinkBatch: true } : {}),
      });
      try {
        await expect(fixture.route(controller.signal)).rejects.toBeDefined();
        expect(fixture.linkBatchStarted()).toBe(true);
        expect(
          fixture.lookups
            .flatMap(({ operations }) => operations)
            .some(
              (operation) =>
                typeof operation === "object" &&
                operation !== null &&
                "op" in operation &&
                operation.op === "readdir" &&
                "path" in operation &&
                (operation.path === "/usr" || operation.path === "/usr/bin"),
            ),
        ).toBe(true);
        expect(() => fixture.fs.lstatSync("/usr")).toThrow(
          expect.objectContaining({ code: "ENOTSUP" }),
        );
        expect(() => fixture.fs.readdirSync("/usr")).toThrow(
          expect.objectContaining({ code: "ENOTSUP" }),
        );
        expect(() => fixture.fs.lstatSync("/usr/bin/git")).toThrow(
          expect.objectContaining({ code: "ENOTSUP" }),
        );
        expect(() => fixture.fs.lstatSync("/usr/bin/signalbox-new-tool")).toThrow(
          expect.objectContaining({ code: "ENOTSUP" }),
        );
      } finally {
        await fixture.close();
      }
    },
  );
});

function writeGuestPath(memory: WebAssembly.Memory, pointer: number, path: string) {
  const bytes = new TextEncoder().encode(path);
  new Uint8Array(memory.buffer, pointer, bytes.byteLength).set(bytes);
}
