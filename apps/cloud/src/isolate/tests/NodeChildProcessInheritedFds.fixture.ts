import type { KernelCommandForwarder } from "../../kernel/KernelCommandForwarder.ts";
import type { KernelProgramAdmissionRequest } from "../../kernel/KernelProgramAdmission.ts";
import {
  assertComputerForwardingSupported,
  createComputerForwardedProgram,
} from "../../computer/ComputerForwardedProgram.ts";
import { createComputerCommands } from "../../computer/ComputerCommands.ts";
import { ABI_VERSION, KernelProgramRegistry, KernelWakeRegistry } from "../../kernel/KernelAbi.ts";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { KernelProgramHost } from "../../kernel/KernelProgramHost.ts";
import { createNodeChildProcess } from "../NodeChildProcess.ts";
import { createNodeComputerChildProcess } from "../NodeComputerProcess.ts";
import { createNodeFs } from "../NodeFs.ts";
import { sqliteFixture } from "./sqliteFixture.ts";

export function inheritedFdsFixture(
  route: "kernel" | "computer",
  machine?: KernelCommandForwarder,
  root = "/work",
) {
  const database = sqliteFixture();
  const wakes = new KernelWakeRegistry();
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage: createFacetSqliteStorage(database.storage, () => 1n) }],
  });
  const fs = createNodeFs(filesystem).fs;
  fs.mkdirSync(root, { recursive: true });
  filesystem.chdir(root);
  const registry = new KernelProgramRegistry();
  const manifest = {
    name: "read-fd",
    version: "1",
    abiVersion: ABI_VERSION,
    entrypoint: "read-fd",
    requiredCapabilities: ["process.spawn"] as const,
  };
  registry.register(manifest);
  const host = new KernelProgramHost({
    registry,
    wakes,
    ...(machine === undefined
      ? {}
      : {
          admit: async (request: KernelProgramAdmissionRequest) => {
            assertComputerForwardingSupported(request);
            return {
              kind: "forward" as const,
              implementation: createComputerForwardedProgram(machine, request.command),
            };
          },
        }),
    programs: new Map([
      [
        "/bin/read-fd",
        {
          manifest,
          implementation: {
            kind: "javascript",
            runInline({ filesystem: child, args }) {
              const fs = createNodeFs(child).fs;
              const input = args[1] === "fd" ? Number(args[2]) : args[2]!;
              fs.writeSync(1, fs.readFileSync(input));
              return 0;
            },
          },
        },
      ],
    ]),
  });
  const computer = createComputerCommands({
    mode: "admitted",
    kernel: { host, filesystem },
    isolateKernel: { host, filesystem },
  });
  const context = { filesystem, env: { PATH: "/bin", HOME: "/work" } };
  return {
    fs,
    filesystem,
    childProcess:
      route === "kernel"
        ? createNodeChildProcess(host, context)
        : createNodeComputerChildProcess(host, context, computer),
    async close() {
      await host.processes.dispose();
      filesystem.dispose();
      database.close();
      wakes.dispose();
    },
  };
}
