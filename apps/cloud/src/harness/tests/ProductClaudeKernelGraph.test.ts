// @effect-diagnostics nodeBuiltinImport:off - The deployed entrypoints are bundled without launching a Worker.
import * as NodeURL from "node:url";
import { build } from "esbuild";
import { expect, it } from "vite-plus/test";
const root = NodeURL.fileURLToPath(new URL("../../../../../", import.meta.url));

it("registers separate CLI, Computer and host graphs through the deployed product entries", async () => {
  const entries = {
    cli: "apps/cloud/infra/deploy3/qualification/fixture/claudeCliFacet.ts",
    kernel: "apps/cloud/infra/deploy3/qualification/fixture/claudeKernelFacet.ts",
    computer: "apps/cloud/src/computer/ComputerExecutionObject.ts",
    thread: "apps/cloud/src/thread/ProductClaudeThreadHost.ts",
  };
  const graphs = new Map<string, string[]>();
  for (const [owner, entry] of Object.entries(entries)) {
    const result = await build({
      absWorkingDir: root,
      entryPoints: [entry],
      bundle: true,
      format: "esm",
      platform: "neutral",
      conditions: ["workerd", "worker", "browser"],
      external: ["cloudflare:workers", "node:*"],
      metafile: true,
      write: false,
    });
    graphs.set(owner, Object.keys(result.metafile.inputs));
  }
  const cli = graphs.get("cli")!;
  expect(cli).toContain("apps/cloud/src/harness/ClaudeCliProcess.ts");
  expect(cli).toContain("apps/cloud/src/harness/ClaudeCliSession.ts");
  expect(
    cli.filter(
      (path) =>
        /(?:^|\/)effect\//.test(path) ||
        path.includes("/computer/") ||
        /\/kernel\/(?!Kernel(?:OpenFlags|WasiAbi|Errno|SyscallPort|FsSyscallAbi|ProcessSignal|FileTransferPort)\.ts)/.test(
          path,
        ),
    ),
  ).toEqual([]);
  const kernel = graphs.get("kernel")!;
  expect(kernel).toContain("apps/cloud/src/kernel/KernelFileSystem.ts");
  expect(kernel).toContain("apps/cloud/src/kernel/KernelComputerHost.ts");
  expect(kernel).not.toContain("apps/cloud/src/harness/ClaudeCliProcess.ts");
  expect(kernel).not.toContain("apps/cloud/src/harness/ClaudeCliSession.ts");
  expect(
    cli.filter((path) =>
      /\/computer\/(?:CommandGateway|ComputerProgramOwner|ComputerProgramResolver|ComputerProgramAdmission|ComputerExecutionObject|ChildWorker(?:Capacity|InvocationRunner|Program)|WorkerLoaderDispatch|EscalationTable)\.ts$|\/harness\/(?:ProductClaudeKernelHost|ClaudeSdkNativeBinding|HarnessSessionHost|HarnessSessionFacet|HarnessRequestFacetObject|host\/lifecycle)\.ts$/.test(
        path,
      ),
    ),
  ).toEqual([]);
  expect(graphs.get("computer")).toContain("apps/cloud/src/computer/ComputerProgramOwner.ts");
  expect(graphs.get("computer")).toContain("apps/cloud/src/computer/ChildWorkerCapacity.ts");
  expect(
    graphs
      .get("computer")!
      .filter((path) =>
        /\/harness\/(?:ClaudeCliProcess|host\/lifecycle)\.ts$|\/kernel\/KernelFileSystem\.ts$/.test(
          path,
        ),
      ),
  ).toEqual([]);
  const thread = graphs.get("thread")!;
  expect(thread).toContain("apps/cloud/src/harness/host/lifecycle.ts");
  expect(thread).toContain("apps/cloud/src/thread/facet/ClaudeFacetHost.ts");
  expect(thread).toContain("apps/cloud/src/harness/ClaudeProductOwners.ts");
  expect(thread).toContain("apps/cloud/src/computer/ComputerExecutionPort.ts");
  expect(thread).toContain("apps/cloud/src/harness/ProductClaudeKernelHost.ts");
  expect(thread).toContain("apps/cloud/src/harness/ClaudeSdkNativeBinding.ts");
  expect(
    thread.filter((path) =>
      /\/computer\/(?:ProductComputer|CommandGateway|ComputerProgramOwner|ComputerExecutionObject)\.ts$|\/harness\/(?:ClaudeCliProcess|ClaudeRemoteNativeBinding|ProductClaudeHarnessSessionHost|NodeHarnessProcess|node\/process)\.ts$|\/kernel\/KernelFileSystem\.ts$/.test(
        path,
      ),
    ),
  ).toEqual([]);
});
