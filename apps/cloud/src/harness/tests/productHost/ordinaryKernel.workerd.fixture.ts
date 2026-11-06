// @effect-diagnostics nodeBuiltinImport:off - Controlled CLI bytes use the native builtin modules.
// @effect-diagnostics cryptoRandomUUID:off - The test observes real isolate identities.
import { createClaudeKernelFacetClass } from "../../ClaudeKernelSession.ts";
import { createMemoryFilePersistencePorts } from "../../../kernel/MemoryFilePersistencePorts.ts";
import { createNodeFs } from "../../../isolate/NodeFs.ts";
import { machineFixture } from "./machine.ts";
import type { OrdinaryOwnerEnvironment } from "./ordinaryOwnerObservation.fixture.ts";

let nonce: string | undefined;
const realm = () => (nonce ??= crypto.randomUUID());

const Base = createClaudeKernelFacetClass<OrdinaryOwnerEnvironment>(
  async ({ ctx, env, configuration }) => {
    const nativeId = configuration.nativeSessionId ?? "12345678-1234-4234-8234-123456789abc";
    await env.OBSERVE.record({ kind: "kernel", realm: realm() });
    return {
      files: {
        database: ctx.storage,
        persistencePorts: createMemoryFilePersistencePorts(),
        nowNs: () => 0n,
      },
      observeOutput: (fd, bytes) => {
        void env.OBSERVE.record({
          kind: `kernel-output:${fd}`,
          realm: realm(),
          detail: new TextDecoder().decode(bytes),
        });
      },
      machine: () => machineFixture("turn", () => {}).port,
      hydrate: async ({ files }) => {
        const fs = createNodeFs(files).fs;
        fs.mkdirSync("/home/recorded/.claude/projects/-workspace", { recursive: true });
        fs.mkdirSync("/recorded/git", { recursive: true });
        fs.writeFileSync("/workspace/.git", "gitdir: /recorded/git\n");
        fs.writeFileSync("/workspace/file.txt", "before\n");
        fs.writeFileSync("/home/recorded/session", nativeId);
        fs.symlinkSync("/workspace", "/source-alias");
      },
      save: async () => ({ commit: "ordinary-split-checkpoint" }),
      port: async () => ({ fetch: async () => new Response("machine service") }),
    };
  },
);

export class ClaudeKernelFacet extends Base {
  override async close() {
    try {
      await super.close();
      await this.env.OBSERVE.record({ kind: "kernel-closed", realm: realm() });
    } catch (cause) {
      await this.env.OBSERVE.record({
        kind: "kernel-close-error",
        realm: realm(),
        detail: String(cause),
      });
      throw cause;
    }
  }
  override async captureTranscripts(
    ...args: Parameters<InstanceType<typeof Base>["captureTranscripts"]>
  ) {
    await this.env.OBSERVE.record({
      kind: "kernel-transcript-capture",
      realm: realm(),
      detail: JSON.stringify(args),
    });
    return await super.captureTranscripts(...args);
  }
}
