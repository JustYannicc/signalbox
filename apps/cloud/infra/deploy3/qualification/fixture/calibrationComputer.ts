import { readRpcData } from "../../../../src/rpc/Resources.ts";
import { createFacetSqliteStorage } from "../../../../src/kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../../../src/kernel/KernelFileSystem.ts";
import { KernelWakeRegistry } from "../../../../src/kernel/KernelWakeRegistry.ts";
import { createNodeFs } from "../../../../src/isolate/NodeFs.ts";
import { ChildWorkerCapacity } from "../../../../src/computer/ChildWorkerCapacity.ts";
import { createProductComputer } from "../../../../src/computer/ProductComputer.ts";
import type { ChildWorkerLoaderPort } from "../../../../src/computer/WorkerLoaderDispatch.ts";
import type { QualifierCapabilities } from "./capabilities.ts";
import { assert } from "./common.ts";

/** Exercises actual command workers from the inert calibration facet, before any official engine is instantiated. */
export async function calibrateComputer(
  ctx: DurableObjectState,
  cap: QualifierCapabilities,
  loader: ChildWorkerLoaderPort,
) {
  await readRpcData(cap.append("observer-computer-entered", {}));
  const catalog = await readRpcData(cap.catalog("codex"));
  const inventory = await readRpcData(cap.inventory("codex"));
  const credentials = { uid: 1000, gid: 1000, euid: 1000, egid: 1000 };
  const storage = createFacetSqliteStorage(ctx.storage, () => 1n);
  storage.posix.initialize(storage.root, { uid: 1000, gid: 1000, mode: 0o755 });
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    posix: { credentials, umask: 0o022 },
  });
  const fs = createNodeFs(filesystem).fs;
  const wakes = new KernelWakeRegistry();
  const abort = new AbortController();
  for (const [path, file] of Object.entries(catalog.files)) {
    fs.mkdirSync(path.slice(0, path.lastIndexOf("/")) || "/", { recursive: true });
    fs.writeFileSync(path, await readRpcData(cap.read(path)), { mode: file.mode });
    fs.chmodSync(path, file.mode);
  }
  fs.mkdirSync("/workspace", { recursive: true });
  fs.writeFileSync("/workspace/calibration.txt", "observer-command-calibration\n");
  filesystem.chdir("/workspace");
  await readRpcData(
    cap.append("observer-computer-files-seeded", {
      fileCount: Object.keys(catalog.files).length,
    }),
  );
  const computer = createProductComputer({
    threadId: "observer-calibration-only",
    filesystem,
    wakes,
    capacity: new ChildWorkerCapacity(2, {
      owner: "qualifier/observer-calibration",
      RESIDENT_BYTE_LIMIT: String(104 * 1024 * 1024),
    }),
    programs: catalog.codes,
    loader,
    machineInventory: inventory,
    machine: () => ({
      files: {
        current: () => ({
          generation: null,
          generationAbsent: true,
          pristine: true,
          imageDigest: inventory.imageDigest,
        }),
        markExecuted: async () => {
          throw new Error("Calibration has no machine");
        },
        lookup: async () => {
          throw new Error("Calibration has no machine file transport");
        },
      },
      spawn: async () => {
        throw new Error("Calibration cannot forward commands to a machine");
      },
    }),
    signal: abort.signal,
  });
  const commands = [
    {
      executable: "/bin/printf",
      argv: ["/bin/printf", "observer-printf-calibration\\n"],
      expected: "observer-printf-calibration\n",
    },
    {
      executable: "/bin/bash",
      argv: ["/bin/bash", "--noprofile", "--norc", "-c", "cat calibration.txt"],
      expected: "observer-command-calibration\n",
    },
    { executable: "/usr/bin/git", argv: ["/usr/bin/git", "--version"], expected: "git version " },
  ];
  const results = [];
  try {
    for (const { expected, ...command } of commands) {
      await readRpcData(cap.append("observer-computer-command-entered", command));
      const child = await computer.exec(
        {
          ...command,
          cwd: "/workspace",
          env: {
            PATH: "/bin:/usr/bin",
            PWD: "/workspace",
            LANG: "C",
            LC_ALL: "C",
            HOME: "/workspace",
          },
        },
        abort.signal,
        undefined,
      );
      try {
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        assert(
          exit.exitCode === 0 && exit.signal === 0 && stderr === "",
          `Actual command calibration failed: ${command.executable}/${stderr}`,
        );
        assert(
          command.executable === "/usr/bin/git" ? stdout.startsWith(expected) : stdout === expected,
          `Actual calibration stdout changed: ${command.executable}`,
        );
        results.push({ command, stdout, stderr, exit });
        await readRpcData(
          cap.append("observer-computer-command-finished", { command, stdout, stderr, exit }),
        );
      } finally {
        await child.dispose();
      }
    }
  } finally {
    await computer.close();
    wakes.dispose();
    filesystem.dispose();
  }
  await readRpcData(
    cap.append("observer-computer-closed", { processCount: computer.processes.size }),
  );
  assert(computer.processes.size === 0, "Calibration left an admitted process running");
  return { results, processCount: computer.processes.size, officialNativeStarted: false };
}
