// @effect-diagnostics nodeBuiltinImport:off - Resolves source paths for the local Worker fixture.
import * as NodePath from "node:path";

export interface ProductComputerWorkerArtifact {
  readonly path: string;
  readonly sha256: string;
}

export function productComputerSixCoreutilsWorkerSource(input: {
  readonly cloudRoot: string;
  readonly workerDir: string;
  readonly artifacts: readonly ProductComputerWorkerArtifact[];
}): string {
  const moduleNames = input.artifacts.map((_, index) => `program${index}`);
  const moduleImports = input.artifacts
    .map(
      ({ path }, index) =>
        `import ${moduleNames[index]} from ${JSON.stringify(`./programs/${path}`)};`,
    )
    .join("\n");
  const modules = input.artifacts
    .map(({ sha256 }, index) => `[${JSON.stringify(sha256)}, ${moduleNames[index]}]`)
    .join(",\n");
  const source = (path: string) => {
    const relative = NodePath.relative(input.workerDir, NodePath.join(input.cloudRoot, path))
      .split(NodePath.sep)
      .join("/");
    return relative.startsWith(".") ? relative : `./${relative}`;
  };

  return `${moduleImports}
import { DurableObject } from "cloudflare:workers";
import { createFacetSqliteStorage } from ${JSON.stringify(source("src/kernel/FacetSqliteStorage.ts"))};
import { KernelForwardingUnavailable } from ${JSON.stringify(source("src/kernel/KernelCommandForwarder.ts"))};
import { KernelFileSystem } from ${JSON.stringify(source("src/kernel/KernelFileSystem.ts"))};
import { KernelWakeRegistry } from ${JSON.stringify(source("src/kernel/KernelWakeRegistry.ts"))};
import { createNodeFs } from ${JSON.stringify(source("src/isolate/NodeFs.ts"))};
import { ChildWorkerCapacity } from ${JSON.stringify(source("src/computer/ChildWorkerCapacity.ts"))};
import { createProductComputer } from ${JSON.stringify(source("src/computer/ProductComputer.ts"))};
import { createSeededCommandProgramCodes } from ${JSON.stringify(source("infra/childPrograms/runtime.ts"))};
import type { FullChildProgramSources } from ${JSON.stringify(source("infra/childPrograms/prepare.ts"))};
import inventory from "./inventory.json" with { type: "json" };
import childPrograms from "./programs.json" with { type: "json" };
import fixtures from "./fixtures.json" with { type: "json" };

const compiledModules = new Map([
${modules}
]);

function errorInfo(error) {
  const value = error && typeof error === "object" ? error : {};
  return {
    name: typeof value.name === "string" ? value.name : "Error",
    message: typeof value.message === "string" ? value.message : String(error),
    ...(typeof value.code === "string" ? { code: value.code } : {}),
  };
}

async function observe(computer, command, signal) {
  let child;
  try {
    child = await computer.exec(command, signal, undefined);
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return {
      label: command.label,
      executable: command.executable,
      exitCode: status.exitCode,
      stdout,
      stderr,
    };
  } catch (error) {
    return {
      label: command.label,
      executable: command.executable,
      error: errorInfo(error),
    };
  } finally {
    await child?.dispose();
  }
}

export class SixCoreutilsProbe extends DurableObject {
  async fetch() {
    const credentials = { uid: 1234, gid: 5678, euid: 1234, egid: 5678 };
    const storage = createFacetSqliteStorage(this.ctx.storage, () => 1n);
    storage.posix.initialize(storage.root, {
      uid: credentials.uid,
      gid: credentials.gid,
      mode: 0o755,
    });
    const filesystem = new KernelFileSystem({
      mounts: [{ path: "/", storage }],
      posix: { credentials, umask: 0o022 },
    });
    const fs = createNodeFs(filesystem).fs;
    fs.mkdirSync("/etc");
    fs.mkdirSync("/workspace");
    fs.mkdirSync("/workspace/shadow");
    fs.writeFileSync("/etc/passwd", fixtures.passwd);
    fs.writeFileSync("/etc/group", fixtures.group);
    fs.writeFileSync("/workspace/lines.txt", fixtures.lines);
    fs.writeFileSync("/workspace/repeated.txt", fixtures.repeated);
    fs.writeFileSync("/workspace/object.json", fixtures.object);
    fs.writeFileSync("/workspace/shadow/id", fixtures.shadow, { mode: 0o755 });

    const machineCalls = [];
    let machineLookups = 0;
    const machineFiles = {
      current: () => ({
        generation: null,
        generationAbsent: true,
        imageDigest: inventory.imageDigest,
        pristine: false,
      }),
      async markExecuted() {
        throw new Error("No machine is attached");
      },
      async lookup() {
        machineLookups++;
        throw new Error("No machine file transport is attached");
      },
    };
    const machine = () => ({
      files: machineFiles,
      async spawn(command) {
        machineCalls.push({ executable: command.executable, argv: [...command.argv] });
        throw new KernelForwardingUnavailable("RUNNER_NOT_READY", "No machine is attached");
      },
    });
    const wakes = new KernelWakeRegistry();
    const computer = createProductComputer({
      threadId: "six-coreutils-public-no-machine",
      filesystem,
      wakes,
      capacity: new ChildWorkerCapacity(2, {
        owner: "test/six-coreutils-public-no-machine",
        RESIDENT_BYTE_LIMIT: String(104 * 1024 * 1024),
      }),
      programs: createSeededCommandProgramCodes(childPrograms as FullChildProgramSources),
      loader: { workerLoader: this.env.LOADER, compiledModules },
      machineInventory: inventory,
      machine,
      signal: new AbortController().signal,
    });

    const env = {
      PATH: "/usr/bin:/bin",
      PWD: "/workspace",
      LANG: "C",
      LC_ALL: "C",
      SIGNALBOX_SIX: "isolated",
    };
    const commands = [
      { label: "env PATH", executable: "env", argv: ["env"] },
      { label: "env absolute", executable: "/usr/bin/env", argv: ["/usr/bin/env"] },
      { label: "id -u PATH", executable: "id", argv: ["id", "-u"] },
      { label: "id -u absolute", executable: "/usr/bin/id", argv: ["/usr/bin/id", "-u"] },
      { label: "id -g PATH", executable: "id", argv: ["id", "-g"] },
      { label: "id -g absolute", executable: "/usr/bin/id", argv: ["/usr/bin/id", "-g"] },
      { label: "id -un PATH", executable: "id", argv: ["id", "-un"] },
      { label: "id -un absolute", executable: "/usr/bin/id", argv: ["/usr/bin/id", "-un"] },
      { label: "id -gn PATH", executable: "id", argv: ["id", "-gn"] },
      { label: "id -gn absolute", executable: "/usr/bin/id", argv: ["/usr/bin/id", "-gn"] },
      { label: "wc -l PATH", executable: "wc", argv: ["wc", "-l", "lines.txt"] },
      { label: "wc -l absolute", executable: "/usr/bin/wc", argv: ["/usr/bin/wc", "-l", "lines.txt"] },
      { label: "sort PATH", executable: "sort", argv: ["sort", "lines.txt"] },
      { label: "sort absolute", executable: "/usr/bin/sort", argv: ["/usr/bin/sort", "lines.txt"] },
      { label: "uniq PATH", executable: "uniq", argv: ["uniq", "repeated.txt"] },
      { label: "uniq absolute", executable: "/usr/bin/uniq", argv: ["/usr/bin/uniq", "repeated.txt"] },
      { label: "jq PATH", executable: "jq", argv: ["jq", ".", "object.json"] },
      { label: "jq absolute", executable: "/usr/bin/jq", argv: ["/usr/bin/jq", ".", "object.json"] },
    ];
    const signal = new AbortController().signal;
    const results = [];
    try {
      filesystem.chdir("/workspace");
      for (const command of commands) {
        results.push(await observe(computer, { ...command, cwd: "/workspace", env }, signal));
      }
      const shadow = await observe(
        computer,
        {
          label: "upper script shadows PATH alias",
          executable: "/bin/bash",
          argv: ["/bin/bash", "--noprofile", "--norc", "-c", "id -u"],
          cwd: "/workspace",
          env: { ...env, PATH: "/workspace/shadow:/usr/bin:/bin" },
        },
        signal,
      );
      return Response.json({
        results,
        shadow,
        processCount: computer.processes.size,
        machine: {
          generationAbsent: machineFiles.current().generationAbsent,
          spawns: machineCalls,
          lookups: machineLookups,
        },
      });
    } finally {
      await computer.close();
      wakes.dispose();
      filesystem.dispose();
    }
  }
}

export default {
  fetch(request, env) {
    const id = env.PROBE.idFromName("six-coreutils");
    return env.PROBE.get(id).fetch(request);
  },
};
`;
}
