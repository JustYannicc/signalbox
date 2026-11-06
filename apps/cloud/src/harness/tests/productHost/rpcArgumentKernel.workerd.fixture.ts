import { createClaudeKernelFacetClass } from "../../ClaudeKernelSession.ts";
import { createMemoryFilePersistencePorts } from "../../../kernel/MemoryFilePersistencePorts.ts";
import { rpcResourceSnapshot } from "../../../rpc/Resources.ts";

const Base = createClaudeKernelFacetClass(({ ctx }) => ({
  files: {
    database: ctx.storage,
    nowNs: () => 1n,
    persistencePorts: createMemoryFilePersistencePorts(),
  },
  native: () => {
    throw new Error("This command test never launches the CLI or SDK");
  },
  machine: () => ({
    files: {
      current: () => ({ generation: null, generationAbsent: true, pristine: false }),
      async markExecuted() {
        throw new Error("No machine execution allowed");
      },
      async lookup() {
        throw new Error("No machine lookup allowed");
      },
    },
    async spawn() {
      throw new Error("No machine fallback allowed");
    },
  }),
  save: async () => ({ commit: "command-test" }),
  port: async () => {
    throw new Error("No network service allowed");
  },
}));
export class ClaudeKernelFacet extends Base {
  resources() {
    return rpcResourceSnapshot();
  }
}
