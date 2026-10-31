// @effect-diagnostics nodeBuiltinImport:off - The controlled SDK peer runs behind the real Node personality.
import * as NodeBuffer from "node:buffer";
import * as NodeConstants from "node:constants";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The local process personality needs Node's filesystem facade.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The local process personality needs Node's child process facade.
import * as NodeChildProcess from "node:child_process";
import * as Yaml from "yaml";
import type { ClaudeSdkQuery } from "@signalbox/provider-claude/ClaudeSdkQueryRunner";
import type { ClaudeAgentSdkMcpServers } from "@signalbox/provider-claude/ClaudeQueryRunner";
import type { ClaudeNativeHostBindingOptions } from "../../ClaudeNativeHostBinding.ts";
import type { ProductClaudeHarnessHostOptions } from "../../ProductClaudeHarnessSessionHost.ts";
import { successfulResult, type SDKMessage } from "../../node/tests/claudeSdkQueryFixture.ts";

export type FreshClaudeGrant = { readonly token: string };
type NativeProcess = ProductClaudeHarnessHostOptions<FreshClaudeGrant>["native"]["process"];

export function freshClaudeSdkProcessPeer() {
  const queryThreadIds: string[] = [];
  const mcpInstallations: ClaudeAgentSdkMcpServers[] = [];
  const mcpUrls: string[] = [];
  const mcpResponses: string[] = [];
  let consumedMessages = 0;
  const process: NativeProcess = {
    identity: {
      version: "v24.21.0",
      versions: { node: "24.21.0", bun: "1.3.11" },
      platform: "linux",
      arch: "x64",
      type: "Linux",
      endianness: "LE",
      availableParallelism: 1,
      user: { username: "recorded", uid: 1000, gid: 1000, shell: "/bin/bash" },
      homedir: "/home/recorded",
      tmpdir: "/tmp",
      pid: 1,
      ppid: 0,
      execPath: "/runtime/claude",
      argv0: "claude",
      argv: ["claude"],
    },
    env: { HOME: "/home/recorded", PATH: "/bin:/usr/bin" },
    nativeModules: {
      buffer: NodeBuffer,
      constants: NodeConstants,
      fs: NodeFS,
      child_process: NodeChildProcess,
    },
    loadPackages: async () => ({ yaml: Yaml }),
    loadRelease: async (_bridge, signal) => ({
      launch: () =>
        new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    }),
    bun: { main: "/release/cli", version: "1.3.11", revision: "controlled" },
  };
  const loadSdk: ClaudeNativeHostBindingOptions["loadSdk"] = async () => ({
    query({ prompt, options }) {
      const sessionId = options.resume ?? options.sessionId;
      if (sessionId === undefined) throw new Error("Claude SDK query has no native session ID.");
      const nativeId = sessionId;
      queryThreadIds.push(sessionId);
      if (options.spawnClaudeCodeProcess === undefined)
        throw new Error("The SDK process hook is missing.");
      const child = options.spawnClaudeCodeProcess({
        command: "/runtime/claude",
        args: ["--input-format", "stream-json"],
        cwd: "/workspace",
        env: { HOME: "/home/recorded", PATH: "/bin:/usr/bin" },
        signal: new AbortController().signal,
      });
      child.on("error", () => {});
      child.stdout.on("error", () => {});
      child.stdout.resume();
      async function* messages(): AsyncGenerator<SDKMessage> {
        for await (const message of prompt) {
          consumedMessages++;
          yield { ...successfulResult(message), session_id: nativeId };
        }
      }
      return Object.assign(messages(), {
        initializationResult: async () =>
          ({}) as Awaited<ReturnType<ClaudeSdkQuery["initializationResult"]>>,
        close() {
          child.kill("SIGTERM");
        },
        async setMcpServers(servers: ClaudeAgentSdkMcpServers) {
          mcpInstallations.push(servers);
          const executor = servers.executor;
          if (executor === undefined || !("url" in executor))
            throw new Error("The current MCP route is missing.");
          mcpUrls.push(executor.url);
          // @effect-diagnostics-next-line globalFetch:off - Exercise the real guest transport and canonical MCP access route.
          const response = await globalThis.fetch(executor.url, {
            method: "POST",
            body: "mcp access probe",
          });
          if (!response.ok)
            throw new Error(`The current MCP route rejected access: ${response.status}`);
          mcpResponses.push(await response.text());
          return { added: Object.keys(servers), removed: [], errors: {} };
        },
        setModel: async () => {},
        applyFlagSettings: async () => {},
        setPermissionMode: async () => {},
        stopTask: async () => {},
        backgroundTasks: async () => true,
        interrupt: async () => undefined,
      }) satisfies ClaudeSdkQuery;
    },
    forkSession: async (sessionId) => ({ sessionId }),
    getSubagentMessages: async () => [],
  });
  return {
    process,
    loadSdk,
    queryThreadIds,
    mcpInstallations,
    mcpUrls,
    mcpResponses,
    get consumedMessages() {
      return consumedMessages;
    },
  };
}
