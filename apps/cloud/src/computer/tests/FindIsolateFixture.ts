// @effect-diagnostics nodeBuiltinImport:off - Builds a local Worker around pinned Bash and BusyBox WASM.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { build } from "esbuild";
import { createTestHarness } from "wrangler";
import { KERNEL_BASH_ARTIFACT } from "../../kernel/KernelBashProgram.ts";
import { KERNEL_BUSYBOX_ARTIFACT } from "../../kernel/KernelBusyboxProgram.ts";
import { CHILD_COREUTILS_COMMANDS } from "../ChildProgramSet.ts";
import { machineInventoryFixture } from "../machineInventoryTesting.ts";
import coreutilsProvenance from "../../../infra/kernelPrograms/coreutils/provenance.json" with { type: "json" };
import {
  packageGraph,
  type ChildProgramSourceCode,
  type ChildProgramSourceRecord,
} from "../../../infra/childPrograms/packageGraph.ts";
import { readPinnedProgram } from "../../../infra/childPrograms/measured.ts";
import {
  bashMain,
  busyboxMain,
  measuredProgramMain,
} from "../../../infra/childPrograms/workerEntrypoints.ts";

export async function startFindFixture(programDir: string, testRoot: string) {
  const repositoryRoot = NodePath.resolve(import.meta.dirname, "../../../../..");
  const cloudRoot = NodePath.join(repositoryRoot, "apps/cloud");
  await NodeFSP.mkdir(testRoot, { recursive: true });
  const workerDir = await NodeFSP.mkdtemp(NodePath.join(testRoot, "find-worker-"));
  let harness: ReturnType<typeof createTestHarness> | undefined;
  try {
    const artifacts = [
      { path: "bash.wasm", pin: KERNEL_BASH_ARTIFACT },
      { path: "busybox.wasm", pin: KERNEL_BUSYBOX_ARTIFACT },
      { path: "coreutils/head.wasm", pin: coreutilsProvenance.commands.head },
    ];
    const artifactInventory = new Map<string, ChildProgramSourceRecord>();
    const verified = await Promise.all(
      artifacts.map(async ({ path, pin }) => {
        const result = await readPinnedProgram(programDir, path, pin, artifactInventory);
        return { path, sha256: result.sha256 };
      }),
    );
    const workerProgramsDir = NodePath.join(workerDir, "programs");
    await NodeFSP.mkdir(workerProgramsDir, { recursive: true });
    await Promise.all(
      artifacts.map(async ({ path }) => {
        const destination = NodePath.join(workerProgramsDir, path);
        await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
        await NodeFSP.copyFile(NodePath.join(programDir, path), destination);
      }),
    );

    const sources = new Map<string, ChildProgramSourceRecord>();
    const [bashGraph, busyboxGraph, coreutilsGraph] = await Promise.all([
      packageGraph(cloudRoot, "src/computer/ChildBashWorker.ts", "ChildBash", bashMain, sources),
      packageGraph(cloudRoot, "src/computer/ChildBusybox.ts", "ChildBusybox", busyboxMain, sources),
      packageGraph(
        cloudRoot,
        "src/computer/ChildCoreutils.ts",
        "ChildCoreutils",
        measuredProgramMain("Coreutils"),
        sources,
      ),
    ]);
    const unusedCode: ChildProgramSourceCode = {
      mainModule: "unused.js",
      modules: { "unused.js": "export default {};" },
    };
    const coreutils = Object.fromEntries(
      CHILD_COREUTILS_COMMANDS.map((command) => [
        command,
        command === "head" ? coreutilsGraph.code : unusedCode,
      ]),
    );
    const programs = {
      bash: bashGraph.code,
      busyboxCat: busyboxGraph.code,
      busyboxApplets: busyboxGraph.code,
      productBusyboxApplets: unusedCode,
      ripgrep: unusedCode,
      coreutils,
      git: unusedCode,
      sed: unusedCode,
      jq: unusedCode,
      ugrep: unusedCode,
    };
    const inventory = machineInventoryFixture([
      { path: "/bin/bash", mode: 0o755, uid: 0, gid: 0 },
      { path: "/bin/find", mode: 0o755, uid: 0, gid: 0 },
      { path: "/bin/head", mode: 0o755, uid: 0, gid: 0 },
    ]);
    await Promise.all([
      NodeFSP.writeFile(NodePath.join(workerDir, "programs.json"), `${JSON.stringify(programs)}\n`),
      NodeFSP.writeFile(
        NodePath.join(workerDir, "inventory.json"),
        `${JSON.stringify(inventory)}\n`,
      ),
    ]);

    const hostPath = NodePath.join(workerDir, "host.ts");
    await NodeFSP.writeFile(
      hostPath,
      findWorkerSource({ cloudRoot, workerDir, artifacts: verified }),
    );
    await build({
      entryPoints: [hostPath],
      absWorkingDir: repositoryRoot,
      outfile: NodePath.join(workerDir, "host.js"),
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "esnext",
      external: [
        "cloudflare:workers",
        "node:*",
        ...verified.map(({ path }) => `./programs/${path}`),
      ],
    });

    const configPath = NodePath.join(workerDir, "wrangler.jsonc");
    await NodeFSP.writeFile(
      configPath,
      JSON.stringify({
        name: "signalbox-find-isolate-test",
        main: "host.js",
        no_bundle: true,
        compatibility_date: "2026-10-19",
        compatibility_flags: ["nodejs_compat"],
        worker_loaders: [{ binding: "LOADER" }],
        rules: [{ type: "CompiledWasm", globs: ["**/*.wasm"], fallthrough: true }],
        durable_objects: { bindings: [{ name: "PROBE", class_name: "FindProbe" }] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["FindProbe"] }],
      }),
    );
    harness = createTestHarness({ workers: [{ configPath }] });
    const endpoint = (await harness.listen()).url;
    return {
      endpoint,
      async close() {
        try {
          await harness?.close();
        } finally {
          await NodeFSP.rm(workerDir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      await harness?.close();
    } finally {
      await NodeFSP.rm(workerDir, { recursive: true, force: true });
    }
    throw error;
  }
}

function findWorkerSource(input: {
  readonly cloudRoot: string;
  readonly workerDir: string;
  readonly artifacts: readonly { readonly path: string; readonly sha256: string }[];
}) {
  const names = input.artifacts.map((_, index) => `program${index}`);
  const imports = input.artifacts
    .map(
      ({ path }, index) => `import ${names[index]} from ${JSON.stringify(`./programs/${path}`)};`,
    )
    .join("\n");
  const compiled = input.artifacts
    .map(({ sha256 }, index) => `[${JSON.stringify(sha256)}, ${names[index]}]`)
    .join(",\n");
  const source = (path: string) => {
    const relative = NodePath.relative(input.workerDir, NodePath.join(input.cloudRoot, path))
      .split(NodePath.sep)
      .join("/");
    return relative.startsWith(".") ? relative : `./${relative}`;
  };
  // The generated Worker lives in a temp directory, so resolve this source from the fixture.
  const fixtureWorkerExports = NodeURL.fileURLToPath(
    new URL("../../FixtureWorkerExports.ts", import.meta.url),
  );
  return `${imports}
import { DurableObject } from "cloudflare:workers";
export * from ${JSON.stringify(fixtureWorkerExports)};
import { KernelForwardingUnavailable } from ${JSON.stringify(source("src/kernel/KernelCommandForwarder.ts"))};
import { createFacetSqliteStorage } from ${JSON.stringify(source("src/kernel/FacetSqliteStorage.ts"))};
import { KernelFileSystemUnavailable } from ${JSON.stringify(source("src/kernel/KernelLowerFileSystem.ts"))};
import { KernelFileSystem } from ${JSON.stringify(source("src/kernel/KernelFileSystem.ts"))};
import { KernelWakeRegistry } from ${JSON.stringify(source("src/kernel/KernelWakeRegistry.ts"))};
import { KERNEL_BASH_ARTIFACT } from ${JSON.stringify(source("src/kernel/KernelBashProgram.ts"))};
import { KERNEL_BUSYBOX_ARTIFACT } from ${JSON.stringify(source("src/kernel/KernelBusyboxProgram.ts"))};
import { createNodeFs } from ${JSON.stringify(source("src/isolate/NodeFs.ts"))};
import { ChildWorkerCapacity } from ${JSON.stringify(source("src/computer/ChildWorkerCapacity.ts"))};
import { createProductComputer } from ${JSON.stringify(source("src/computer/ProductComputer.ts"))};
import { createSeededCommandProgramCodes } from ${JSON.stringify(source("infra/childPrograms/runtime.ts"))};
import inventory from "./inventory.json" with { type: "json" };
import childPrograms from "./programs.json" with { type: "json" };

const compiledModules = new Map([
${compiled}
]);

export class FindProbe extends DurableObject {
  async fetch() {
    const credentials = { uid: 1000, gid: 1000, euid: 1000, egid: 1000 };
    const storage = createFacetSqliteStorage(this.ctx.storage, () => 1n);
    storage.posix.initialize(storage.root, { uid: credentials.uid, gid: credentials.gid, mode: 0o755 });
    const filesystem = new KernelFileSystem({ mounts: [{ path: "/", storage }], posix: { credentials, umask: 0o022 } });
    const fs = createNodeFs(filesystem).fs;
    fs.mkdirSync("/workspace/nested/sub/deeper", { recursive: true });
    fs.writeFileSync("/workspace/nested/entry.txt", "root\\n");
    fs.writeFileSync("/workspace/nested/sub/entry.txt", "sub\\n");
    fs.writeFileSync("/workspace/nested/sub/deeper/entry.txt", "deep\\n");

    const machineCalls = [];
    let machineLookups = 0;
    const machineFiles = {
      current: () => ({ generation: null, generationAbsent: true, imageDigest: inventory.imageDigest, pristine: false }),
      async markExecuted() { throw new Error("No machine generation"); },
      async lookup() { machineLookups++; throw new KernelFileSystemUnavailable("A machine generation is required for live file lookup"); },
    };
    const machine = () => ({
      files: machineFiles,
      async spawn(command) {
        machineCalls.push(command.executable);
        throw new KernelForwardingUnavailable("RUNNER_NOT_READY", "No machine is attached");
      },
    });
    const wakes = new KernelWakeRegistry();
    const computer = createProductComputer({
      threadId: "find-isolate-fixture",
      filesystem,
      wakes,
      capacity: new ChildWorkerCapacity(4, { owner: "test/find-isolate-fixture", RESIDENT_BYTE_LIMIT: String(104 * 1024 * 1024) }),
      programs: createSeededCommandProgramCodes(childPrograms),
      loader: { workerLoader: this.env.LOADER, compiledModules },
      machineInventory: inventory,
      machine,
      signal: new AbortController().signal,
    });
    let command;
    let child;
    try {
      filesystem.chdir("/workspace");
      child = await computer.exec({
        executable: "/bin/bash",
        argv: ["/bin/bash", "--noprofile", "--norc", "-c", "find nested -type f | head -50"],
        cwd: "/workspace",
        env: { PATH: "/bin", PWD: "/workspace", HOME: "/workspace", LANG: "C", LC_ALL: "C" },
      }, new AbortController().signal, undefined);
      const [stdout, stderr, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      command = { exitCode: status.exitCode, stdout, stderr };
    } catch (error) {
      const value = error && typeof error === "object" ? error : {};
      command = { error: { name: value.name ?? "Error", message: value.message ?? String(error), ...(typeof value.code === "string" ? { code: value.code } : {}) } };
    } finally {
      await child?.dispose();
      await computer.close();
      wakes.dispose();
      filesystem.dispose();
    }
    return Response.json({
      command,
      processCount: computer.processes.size,
      machine: { generationAbsent: machineFiles.current().generationAbsent, generation: machineFiles.current().generation, pristine: machineFiles.current().pristine, spawns: machineCalls, lookups: machineLookups },
    });
  }
}

export default {
  fetch(request, env) {
    const id = env.PROBE.idFromName("find-isolate");
    return env.PROBE.get(id).fetch(request);
  },
};
`;
}
