// @effect-diagnostics nodeBuiltinImport:off - this public composition test uses only an isolated in-memory machine filesystem.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { describe, expect, it, vi } from "vite-plus/test";
import type {
  MachineFileOperationResult,
  MachineFileStat,
  MachineFilesResult,
} from "@signalbox/runner-protocol/MachineFilesProtocol";
import {
  MACHINE_FILES_MAX_FRAME_BYTES,
  machineFilesFrameBytes,
} from "@signalbox/runner-protocol/MachineFilesProtocol";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { createKernelSyscallHost } from "../../kernel/KernelSyscallHost.ts";
import { createKernelAsyncWasi } from "../../kernel/KernelWasi.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import { wasmImportReactor } from "./wasmGuest.ts";
import { createNodeFs } from "../../isolate/NodeFs.ts";
import { CHILD_COREUTILS_COMMANDS } from "../ChildProgramSet.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import {
  MachineFileLookupError,
  type MachineFileSourceState,
  type MachineFilesPort,
} from "../MachineFilesPort.ts";
import type { MachineProgramEntry, MachineProgramInventory } from "../MachineProgramInventory.ts";
import { createProductComputer } from "../ProductComputer.ts";
import type { ChildWorkerLoaderPort } from "../WorkerLoaderDispatch.ts";
import { sqliteFixture } from "../sqliteTesting.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const pinnedInventoryPath =
  NodeProcess.env.SIGNALBOX_MACHINE_PATH_INVENTORY_FILE ??
  new URL("../../../infra/kernelPrograms/machine-files/build/runner.json", import.meta.url);
if (
  NodeProcess.env.SIGNALBOX_MACHINE_PATH_INVENTORY_FILE !== undefined &&
  !NodeFS.existsSync(pinnedInventoryPath)
)
  throw new Error("Required machine inventory is missing");
const pinnedInventoryBytes = NodeFS.existsSync(pinnedInventoryPath)
  ? NodeFS.readFileSync(pinnedInventoryPath)
  : undefined;
if (
  pinnedInventoryBytes !== undefined &&
  NodeCrypto.createHash("sha256").update(pinnedInventoryBytes).digest("hex") !==
    "74186335378f14ba82d2c7ac3dfe3d2708b2b8f4f4b5faf9c009f23127ec4e19"
)
  throw new Error("Machine metadata refresh proof requires the frozen runner inventory");
const pinnedInventory: MachineProgramInventory | undefined =
  pinnedInventoryBytes === undefined
    ? undefined
    : JSON.parse(pinnedInventoryBytes.toString("utf8"));
const code = { mainModule: "unused.js", modules: { "unused.js": "export default class {}" } };

function machineEntry(
  path: string,
  type: MachineProgramEntry["type"],
  options: { readonly mode?: number; readonly target?: string } = {},
): MachineProgramEntry {
  return {
    path,
    type,
    size: "0",
    nlink: type === "directory" ? "2" : "1",
    atimeNs: "1",
    mtimeNs: "1",
    ctimeNs: "1",
    mode:
      options.mode ??
      (type === "directory"
        ? 0o755
        : type === "symlink"
          ? 0o777
          : type === "character"
            ? 0o666
            : type === "fifo"
              ? 0o644
              : type === "socket"
                ? 0o777
                : 0o644),
    uid: 0,
    gid: 0,
    ...(options.target === undefined ? {} : { target: options.target }),
  };
}

const liveRoots = [
  "/.dockerenv",
  "/dev",
  "/etc/hostname",
  "/etc/hosts",
  "/etc/resolv.conf",
  "/proc",
  "/run",
  "/sys",
  "/tmp",
  "/var/tmp",
];

function makeInventory(extraEntries: readonly MachineProgramEntry[] = []): MachineProgramInventory {
  const entries = [
    machineEntry("/", "directory"),
    machineEntry("/bin", "symlink", { target: "usr/bin" }),
    machineEntry("/etc", "directory"),
    machineEntry("/etc/ssl", "directory"),
    machineEntry("/etc/ssl/private", "directory", { mode: 0o700 }),
    machineEntry("/root", "directory", { mode: 0o700 }),
    machineEntry("/usr", "directory"),
    machineEntry("/usr/bin", "directory"),
    machineEntry("/usr/bin/python3", "symlink", { target: "python3.12" }),
    machineEntry("/usr/bin/python3.12", "file"),
    machineEntry("/usr/bin/uname", "file", { mode: 0o755 }),
    machineEntry("/usr/lower-only-directory", "directory"),
    machineEntry("/var", "directory"),
    ...extraEntries,
  ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const digest = `sha256:${"a".repeat(64)}` as const;
  return {
    format: "signalbox-machine-files-v1",
    imageRef: `ghcr.io/signalbox/test-runner@${digest}`,
    imageDigest: digest,
    platform: "linux/amd64",
    provenance: {
      sourceRevision: "d".repeat(40),
      sourceImageId: `sha256:${"b".repeat(64)}` as const,
      dockerfile: "infra/runner/Dockerfile",
      captureSha256: "c".repeat(64),
    },
    path: ["/usr/bin", "/bin"],
    excludedRoots: liveRoots,
    entries,
  };
}

const testInventory = makeInventory();

function frameInventory(): MachineProgramInventory {
  const entries: MachineProgramEntry[] = [machineEntry("/frame", "directory")];
  for (let directory = 0; directory < 64; directory++) {
    const parent = `/frame/dir-${String(directory).padStart(2, "0")}`;
    entries.push(machineEntry(parent, "directory"));
    const count = directory === 0 ? 129 : 128;
    for (let child = 0; child < count; child++) {
      entries.push(machineEntry(`${parent}/entry-${String(child).padStart(3, "0")}`, "file"));
    }
  }
  return makeInventory(entries);
}

type Hooks = {
  readonly inventory?: MachineProgramInventory;
  readonly beforeReaddirBatch?: (operations: readonly unknown[]) => void | Promise<void>;
  readonly beforeLinkBatch?: (signal: AbortSignal) => void;
  readonly changeGenerationDuringLinkBatch?: boolean;
  readonly denyReaddirPaths?: readonly string[];
  readonly enforceResponseFrame?: boolean;
  readonly includeSpecialLiveEntries?: boolean;
  readonly failLinkBatch?: Error;
};

function makeFixture(hooks: Hooks = {}) {
  const inventory = hooks.inventory ?? testInventory;
  const entries = new Map(inventory.entries.map((entry) => [entry.path, entry]));
  const liveInodes = new Map<string, string>();
  let nextInode = 1_000_000n;
  let frameRejections = 0;
  const frameSizes: number[] = [];
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
  for (const root of inventory.excludedRoots) {
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
  if (hooks.includeSpecialLiveEntries !== false) {
    for (const [path, type] of [
      ["/dev/null", "character"],
      ["/dev/character", "character"],
      ["/dev/pipe", "fifo"],
      ["/dev/socket", "socket"],
    ] as const) {
      entries.set(path, machineEntry(path, type));
    }
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
    imageDigest: inventory.imageDigest,
  };
  let pendingExit:
    | ((value: { exitCode: number; signal: number; coreDumped: boolean }) => void)
    | undefined;
  let leaseHeld = false;
  let fileTransportOwned = true;
  let lookupsAfterCommandLeaseRelease = 0;
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
      if (routeActive && !fileTransportOwned)
        throw new Error("Refresh ran after the machine file owner ended");
      if (routeActive && !leaseHeld) lookupsAfterCommandLeaseRelease++;
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
      const readdirOperations = input.operations.filter((operation) => operation.op === "readdir");
      if (readdirOperations.length > 0) await hooks.beforeReaddirBatch?.(readdirOperations);
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
          if (hooks.denyReaddirPaths?.includes(directoryPath))
            return {
              id: operation.id,
              op: operation.op,
              error: { code: "EACCES", message: "Permission denied" },
            };
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
      if (hooks.enforceResponseFrame) {
        const response: MachineFilesResult = {
          type: "machine.files.result",
          generation: input.generation,
          requestId: "refresh-fixture",
          outcome: { status: "ok", results: result },
        };
        const bytes = machineFilesFrameBytes(response);
        if (bytes > MACHINE_FILES_MAX_FRAME_BYTES) {
          frameRejections++;
          throw new MachineFileLookupError(
            "FRAME_TOO_LARGE",
            "Split this machine file request and retry.",
          );
        }
        frameSizes.push(bytes);
      }
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
    machineInventory: inventory,
    signal: new AbortController().signal,
    machine: () => ({
      files,
      async spawn() {
        if (state.pristine) throw new Error("Machine was not marked dirty before route start");
        leaseHeld = true;
        routeActive = true;
        const uname = entries.get("/usr/bin/uname");
        if (uname === undefined) throw new Error("Test inventory is missing /usr/bin/uname");
        entries.set("/usr/bin/uname", {
          ...uname,
          size: (BigInt(uname.size) + 1n).toString(),
          mtimeNs: (BigInt(uname.mtimeNs) + 1n).toString(),
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
        entries.set("/usr/signalbox-new-open-dir", {
          path: "/usr/signalbox-new-open-dir",
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
        entries.set("/tmp/signalbox-live-root-entry", {
          path: "/tmp/signalbox-live-root-entry",
          type: "file",
          size: "13",
          nlink: "1",
          atimeNs: "2",
          mtimeNs: "3",
          ctimeNs: "4",
          mode: 0o100600,
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
    lookupsAfterCommandLeaseRelease: () => lookupsAfterCommandLeaseRelease,
    state: () => state,
    setState(next: MachineFileSourceState) {
      state = next;
    },
    linkBatchStarted: () => linkBatchStarted,
    frameRejections: () => frameRejections,
    frameSizes,
    async route(signal = new AbortController().signal) {
      const child = await computer.exec(
        {
          executable: "/usr/bin/uname",
          argv: ["uname", "-s"],
          cwd: "/",
          env: { PATH: inventory.path.join(":") },
        },
        signal,
        undefined,
      );
      const machineExitAt = performance.now();
      // The Runner may report closed and release the process lease before exit handling refreshes metadata.
      leaseHeld = false;
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
      fileTransportOwned = false;
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

describe("ProductComputer machine metadata refresh", () => {
  it("refreshes cold, changed, and missing names before resolving a successful machine exit", async () => {
    const fixture = makeFixture();
    try {
      const beforeStat = fixture.fs.lstatSync("/usr/bin/uname");
      const beforeDirectory = fixture.fs.readdirSync("/usr").map(String).sort();
      const { exit, refreshMs } = await fixture.route();

      expect(exit).toEqual({ exitCode: 0, signal: 0, coreDumped: false });
      expect(fixture.lookupsAfterCommandLeaseRelease()).toBeGreaterThan(0);
      expect(fixture.fs.lstatSync("/usr/bin/uname").size).toBe(beforeStat.size + 1);
      expect(fixture.fs.statSync("/bin/uname").size).toBe(beforeStat.size + 1);
      expect(fixture.fs.readdirSync("/usr").map(String).sort()).toEqual(
        [...beforeDirectory, "signalbox-new-dir", "signalbox-new-open-dir"].sort(),
      );
      expect(fixture.fs.readdirSync("/bin").map(String)).toContain("uname");
      expect(fixture.fs.lstatSync("/usr/signalbox-new-dir")).toMatchObject({
        mode: 0o40750,
        size: 0,
      });
      expect(fixture.fs.lstatSync("/usr/bin/python3").isSymbolicLink()).toBe(true);
      expect(fixture.fs.lstatSync("/usr/bin/signalbox-new-tool")).toMatchObject({
        mode: 0o100755,
        size: 9,
      });
      expect(fixture.fs.readdirSync("/tmp").map(String)).toContain("signalbox-live-root-entry");
      expect(fixture.fs.lstatSync("/tmp/signalbox-live-root-entry")).toMatchObject({
        mode: 0o100600,
        size: 13,
      });
      expect(() => fixture.fs.lstatSync("/tmp/signalbox-live-missing")).toThrow(
        expect.objectContaining({ code: "ENOENT" }),
      );
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

  it("keeps a denied directory local while refreshing readable machine paths", async () => {
    const fixture = makeFixture({
      denyReaddirPaths: ["/root", "/etc/ssl/private"],
      includeSpecialLiveEntries: false,
    });
    try {
      const { exit } = await fixture.route();
      expect(exit).toEqual({ exitCode: 0, signal: 0, coreDumped: false });
      expect(fixture.fs.readdirSync("/usr/bin").map(String)).toContain("uname");
      expect(fixture.fs.lstatSync("/usr/bin/uname").size).toBe(1);
      for (const path of ["/root", "/etc/ssl/private"])
        expect(() => fixture.fs.readdirSync(path)).toThrow(
          expect.objectContaining({ code: "EACCES" }),
        );
    } finally {
      await fixture.close();
    }
  });

  it("keeps special live names visible and rejects their metadata locally", async () => {
    const fixture = makeFixture();
    try {
      const { exit } = await fixture.route();
      expect(exit).toEqual({ exitCode: 0, signal: 0, coreDumped: false });
      expect(fixture.fs.readdirSync("/dev").map(String)).toEqual(
        expect.arrayContaining(["character", "null", "pipe", "socket"]),
      );
      expect(fixture.fs.lstatSync("/dev/null").isCharacterDevice()).toBe(true);
      for (const path of ["/dev/character", "/dev/pipe", "/dev/socket"]) {
        expect(() => fixture.fs.lstatSync(path)).toThrow(
          expect.objectContaining({ code: "ENOTSUP" }),
        );
      }
    } finally {
      await fixture.close();
    }
  });

  it("routes batch preparation through the pristine inventory without live lookup", async () => {
    const fixture = makeFixture();
    try {
      fixture.setState({
        generation: null,
        generationAbsent: true,
        imageDigest: testInventory.imageDigest,
        pristine: false,
      });
      await fixture.filesystem.prepareLowerPaths(["/usr", "/usr/bin/python3"]);
      expect(fixture.fs.readlinkSync("/usr/bin/python3")).toBe("python3.12");
      expect(fixture.fs.readdirSync("/usr").map(String)).toContain("bin");
      expect(fixture.lookups).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("keeps source pins and a lower-only directory after failed rename", async () => {
    const fixture = makeFixture({ includeSpecialLiveEntries: false });
    try {
      await fixture.route();
      const lowerDestination = "/usr/lower-only-directory";
      const lowerDestinationInode = fixture.fs.statSync(lowerDestination).ino;
      const syncSource = "/usr/sync-lower-rename-source";
      const syncDescriptor = fixture.fs.openSync(syncSource, "wx", 0o600);
      try {
        const syncInode = fixture.fs.fstatSync(syncDescriptor).ino;
        expect(() => fixture.fs.renameSync(syncSource, lowerDestination)).toThrow(
          expect.objectContaining({ code: "EISDIR" }),
        );
        expect(fixture.fs.statSync(syncSource).ino).toBe(syncInode);
        expect(fixture.fs.fstatSync(syncDescriptor).ino).toBe(syncInode);
        const syncDestinationStat = fixture.fs.statSync(lowerDestination);
        expect(syncDestinationStat.ino).toBe(lowerDestinationInode);
        expect(syncDestinationStat.isDirectory()).toBe(true);
      } finally {
        fixture.fs.closeSync(syncDescriptor);
      }

      const asyncSource = "/usr/async-lower-rename-source";
      const asyncHandle = await fixture.fs.promises.open(asyncSource, "wx", 0o600);
      try {
        const asyncInode = (await asyncHandle.stat()).ino;
        await expect(
          fixture.fs.promises.rename(asyncSource, lowerDestination),
        ).rejects.toMatchObject({ code: "EISDIR" });
        expect((await fixture.fs.promises.stat(asyncSource)).ino).toBe(asyncInode);
        expect((await asyncHandle.stat()).ino).toBe(asyncInode);
        const asyncDestinationStat = await fixture.fs.promises.stat(lowerDestination);
        expect(asyncDestinationStat.ino).toBe(lowerDestinationInode);
        expect(asyncDestinationStat.isDirectory()).toBe(true);
      } finally {
        await asyncHandle.close();
      }
    } finally {
      await fixture.close();
    }
  });

  it.each(["sync", "async"] as const)(
    "rejects renaming an upper symlink onto a lower directory through %s calls",
    async (mode) => {
      const fixture = makeFixture();
      try {
        await fixture.route();
        const source = "/usr/upper-link";
        const destination = "/usr/lower-only-directory";
        const target = "/usr/bin/uname";
        fixture.fs.symlinkSync(target, source);
        const sourceInode = fixture.fs.lstatSync(source).ino;
        const destinationInode = fixture.fs.statSync(destination).ino;

        if (mode === "sync") {
          expect(() => fixture.fs.renameSync(source, destination)).toThrow(
            expect.objectContaining({ code: "EISDIR" }),
          );
        } else {
          await expect(fixture.fs.promises.rename(source, destination)).rejects.toMatchObject({
            code: "EISDIR",
          });
        }
        expect(fixture.fs.lstatSync(source).ino).toBe(sourceInode);
        expect(fixture.fs.readlinkSync(source)).toBe(target);
        expect(fixture.fs.statSync(destination).ino).toBe(destinationInode);
        expect(fixture.fs.statSync(destination).isDirectory()).toBe(true);
      } finally {
        await fixture.close();
      }
    },
  );

  it.each(["sync", "async"] as const)(
    "rejects replacing a nonempty lower directory through %s calls",
    async (mode) => {
      const destination = "/usr/lower-only-directory";
      const fixture = makeFixture({
        inventory: makeInventory([machineEntry(`${destination}/child`, "file")]),
      });
      try {
        await fixture.route();
        const source = "/usr/upper-dir";
        fixture.fs.mkdirSync(source);
        const sourceInode = fixture.fs.statSync(source).ino;
        const destinationInode = fixture.fs.statSync(destination).ino;

        if (mode === "sync") {
          expect(() => fixture.fs.renameSync(source, destination)).toThrow(
            expect.objectContaining({ code: "ENOTEMPTY" }),
          );
        } else {
          await expect(fixture.fs.promises.rename(source, destination)).rejects.toMatchObject({
            code: "ENOTEMPTY",
          });
        }
        expect(fixture.fs.statSync(source).ino).toBe(sourceInode);
        expect(fixture.fs.statSync(source).isDirectory()).toBe(true);
        expect(fixture.fs.readdirSync(source)).toEqual([]);
        expect(fixture.fs.statSync(destination).ino).toBe(destinationInode);
        expect(fixture.fs.statSync(destination).isDirectory()).toBe(true);
        expect(fixture.fs.readdirSync(destination)).toEqual(["child"]);
      } finally {
        await fixture.close();
      }
    },
  );

  it("keeps newer command metadata after an older completion refresh fails", async () => {
    const started = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    let holdFirstBatch = true;
    const fixture = makeFixture({
      beforeReaddirBatch: () => {
        if (!holdFirstBatch) return;
        holdFirstBatch = false;
        started.resolve();
        return held.promise;
      },
    });
    try {
      const older = fixture.route();
      void older.catch(() => undefined);
      await started.promise;
      await expect(fixture.route()).resolves.toMatchObject({ exit: { exitCode: 0 } });
      const newerNames = fixture.fs.readdirSync("/usr");
      const newerInode = fixture.fs.statSync("/usr/bin/uname").ino;
      expect(newerNames).toContain("signalbox-new-dir");

      held.reject(new Error("older refresh failed"));
      await expect(older).rejects.toThrow();
      expect(fixture.fs.readdirSync("/usr")).toEqual(newerNames);
      expect(fixture.fs.statSync("/usr/bin/uname").ino).toBe(newerInode);
    } finally {
      await fixture.close();
    }
  });

  it.each(["sync", "async"] as const)(
    "replaces an empty lower directory through %s calls",
    async (mode) => {
      const fixture = makeFixture();
      try {
        await fixture.route();
        const source = "/usr/upper-empty-dir";
        const destination = "/usr/lower-only-directory";
        fixture.fs.mkdirSync(source);
        const sourceInode = fixture.fs.statSync(source).ino;
        if (mode === "sync") fixture.fs.renameSync(source, destination);
        else await fixture.fs.promises.rename(source, destination);
        expect(() => fixture.fs.statSync(source)).toThrow(
          expect.objectContaining({ code: "ENOENT" }),
        );
        expect(fixture.fs.statSync(destination).ino).toBe(sourceInode);
        expect(fixture.fs.statSync(destination).isDirectory()).toBe(true);
        expect(fixture.fs.readdirSync(destination)).toEqual([]);
      } finally {
        await fixture.close();
      }
    },
  );

  it("splits oversized directory responses and preserves every paginated child", async () => {
    const fixture = makeFixture({
      inventory: frameInventory(),
      enforceResponseFrame: true,
      includeSpecialLiveEntries: false,
    });
    try {
      const { exit } = await fixture.route();
      expect(exit).toEqual({ exitCode: 0, signal: 0, coreDumped: false });
      expect(fixture.frameRejections()).toBeGreaterThan(0);
      expect(fixture.frameSizes.length).toBeGreaterThan(0);
      expect(fixture.frameSizes.every((size) => size <= MACHINE_FILES_MAX_FRAME_BYTES)).toBe(true);
      const childCount = Array.from(
        { length: 64 },
        (_, index) => fixture.fs.readdirSync(`/frame/dir-${String(index).padStart(2, "0")}`).length,
      ).reduce((total, count) => total + count, 0);
      expect(childCount).toBe(8_193);
    } finally {
      await fixture.close();
    }
  });

  it("uses async WASI and sync NodeFs creation with POSIX semantics", async () => {
    const fixture = makeFixture({ includeSpecialLiveEntries: false });
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
    const syscallHost = createKernelSyscallHost({
      filesystem: fixture.filesystem,
      args: [],
      env: {},
      signal: new AbortController().signal,
    });
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

      const syscallMkdirPath = "usr/signalbox-new-dir/syscall-created";
      const syscallMkdirBytes = new TextEncoder().encode(syscallMkdirPath);
      expect(
        await syscallHost.call({
          name: "path_create_directory",
          args: [rootFd, 64, syscallMkdirBytes.length],
          memorySize: 256,
          regions: [{ pointer: 64, direction: "in", bytes: syscallMkdirBytes }],
        }),
      ).toMatchObject({ kind: "return", value: 0 });
      expect(fixture.fs.statSync("/usr/signalbox-new-dir/syscall-created").isDirectory()).toBe(
        true,
      );

      const syscallOpenPath = "usr/signalbox-new-open-dir/syscall-open-created";
      const syscallOpenBytes = new TextEncoder().encode(syscallOpenPath);
      const syscallOpen = await syscallHost.call({
        name: "path_open",
        args: [rootFd, 0, 64, syscallOpenBytes.length, 1 | 4, 0n, 0n, 0, 128],
        memorySize: 256,
        regions: [
          { pointer: 64, direction: "in", bytes: syscallOpenBytes },
          { pointer: 128, direction: "out", bytes: new Uint8Array(), length: 4 },
        ],
      });
      expect(syscallOpen).toMatchObject({ kind: "return", value: 0 });
      if (syscallOpen.kind !== "return") throw new Error("WASI open did not return");
      const fdRegion = syscallOpen.regions.find((region) => region.pointer === 128);
      if (fdRegion === undefined) throw new Error("WASI open omitted its descriptor");
      const syscallFd = new DataView(
        fdRegion.bytes.buffer,
        fdRegion.bytes.byteOffset,
        fdRegion.bytes.byteLength,
      ).getUint32(0, true);
      await syscallHost.call({ name: "fd_close", args: [syscallFd], memorySize: 0, regions: [] });
      expect(fixture.fs.statSync("/usr/signalbox-new-open-dir/syscall-open-created").isFile()).toBe(
        true,
      );

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

        const lowerDestination = "/usr/lower-only-directory";
        const lowerDestinationInode = fixture.fs.statSync(lowerDestination).ino;
        expect(() => fixture.fs.renameSync(syncPath, lowerDestination)).toThrow(
          expect.objectContaining({ code: "EISDIR" }),
        );
        expect(fixture.fs.statSync(syncPath).ino).toBe(created.ino);
        expect(fixture.fs.fstatSync(syncDescriptor).ino).toBe(created.ino);
        const lowerDestinationStat = fixture.fs.statSync(lowerDestination);
        expect(lowerDestinationStat.ino).toBe(lowerDestinationInode);
        expect(lowerDestinationStat.isDirectory()).toBe(true);

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
      const lowerDestinationInode = (await fixture.fs.promises.stat("/usr/lower-only-directory"))
        .ino;
      await expect(
        fixture.fs.promises.rename("/usr/open-created", "/usr/lower-only-directory"),
      ).rejects.toMatchObject({ code: "EISDIR" });
      expect((await fixture.fs.promises.stat("/usr/open-created")).ino).toBe(created.ino);
      expect((await handle.stat()).ino).toBe(created.ino);
      const lowerDestination = await fixture.fs.promises.stat("/usr/lower-only-directory");
      expect(lowerDestination.ino).toBe(lowerDestinationInode);
      expect(lowerDestination.isDirectory()).toBe(true);
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
      syscallHost.close();
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
        includeSpecialLiveEntries: false,
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
        expect(() => fixture.fs.lstatSync("/usr/bin/uname")).toThrow(
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

describe.skipIf(pinnedInventory === undefined)("pinned machine inventory proof", () => {
  it("refreshes the full hash-checked image inventory", async () => {
    const inventory = pinnedInventory;
    if (inventory === undefined) throw new Error("Pinned inventory is required");
    const fixture = makeFixture({ inventory });
    try {
      expect(inventory.entries).toHaveLength(16_880);
      const { exit } = await fixture.route();
      expect(exit).toEqual({ exitCode: 0, signal: 0, coreDumped: false });
      expect(fixture.fs.lstatSync("/usr/bin/uname").size).toBeGreaterThan(0);
      expect(fixture.lookups.length).toBeGreaterThan(0);
    } finally {
      await fixture.close();
    }
  });
});

function writeGuestPath(memory: WebAssembly.Memory, pointer: number, path: string) {
  const bytes = new TextEncoder().encode(path);
  new Uint8Array(memory.buffer, pointer, bytes.byteLength).set(bytes);
}
