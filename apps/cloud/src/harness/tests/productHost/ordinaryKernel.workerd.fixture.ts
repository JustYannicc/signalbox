// @effect-diagnostics nodeBuiltinImport:off - Controlled CLI bytes use the native builtin modules.
// @effect-diagnostics cryptoRandomUUID:off - The test observes real isolate identities.
import * as NodeBuffer from "node:buffer";
import * as NodeConstants from "node:constants";
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as Yaml from "yaml";
import { systemIdentityForThread } from "@t3tools/contracts/systemIdentity";
import { createClaudeKernelFacetClass } from "../../ClaudeKernelSession.ts";
import { createMemoryFilePersistencePorts } from "../../../kernel/MemoryFilePersistencePorts.ts";
import { createNodeFs } from "../../../isolate/NodeFs.ts";
import type { createNodeProcess } from "../../../isolate/NodeProcess.ts";
import { nativeFixture } from "./native.ts";
import { machineFixture } from "./machine.ts";
import type { OrdinaryOwnerEnvironment } from "./ordinaryOwnerObservation.fixture.ts";

let nonce: string | undefined;
const realm = () => (nonce ??= crypto.randomUUID());

export const ClaudeKernelFacet = createClaudeKernelFacetClass<OrdinaryOwnerEnvironment>(
  async ({ ctx, env, configuration }) => {
    const nativeId = configuration.nativeSessionId ?? "12345678-1234-4234-8234-123456789abc";
    await env.OBSERVE.record({ kind: "kernel", realm: realm() });
    const identity = systemIdentityForThread(
      configuration.threadId,
      configuration.process.systemIdentity,
    );
    let sessionId = nativeId;
    const native = nativeFixture(nativeId, identity, undefined, () => sessionId, "claude-opus-5-5");
    return {
      files: {
        database: ctx.storage,
        persistencePorts: createMemoryFilePersistencePorts(),
        nowNs: () => 0n,
      },
      native: () => ({
        nativeModules: {
          buffer: NodeBuffer,
          constants: NodeConstants,
          fs: NodeFS,
          child_process: NodeChildProcess,
        },
        loadPackages: async () => ({ yaml: Yaml }),
        loadRelease: async (bridge, signal) => {
          const process = bridge.require("node:process") as ReturnType<typeof createNodeProcess>;
          const index = process.argv.indexOf("--session-id");
          const requestedId = process.argv[index + 1];
          if (index < 0 || requestedId === undefined)
            throw new Error("SDK did not pass its native session ID");
          sessionId = requestedId;
          const release = await native.loadRelease(bridge, signal);
          return {
            launch: async () => {
              await env.OBSERVE.record({ kind: "cli-launch", realm: realm() });
              try {
                return await release.launch();
              } catch (error) {
                await env.OBSERVE.record({
                  kind: "cli-failure",
                  realm: realm(),
                  detail: NodeUtil.inspect(error, { depth: 15 }),
                });
                throw error;
              }
            },
          };
        },
      }),
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
