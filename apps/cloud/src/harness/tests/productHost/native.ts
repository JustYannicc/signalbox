import * as NodeAssert from "node:assert/strict";
import type { SystemIdentity } from "@t3tools/contracts/systemIdentity";
import type { ClaudeSdkQuery } from "@signalbox/provider-claude/ClaudeSdkQueryRunner";
import type { PreparedClaudeSdk, SdkSpawnedProcess } from "../../ClaudeIsolateAdapter.ts";
import type { NodeBridge } from "../../../isolate/NodeBridge.ts";
import type { createNodeChildProcess } from "../../../isolate/NodeChildProcess.ts";
import type { createNodeProcess } from "../../../isolate/NodeProcess.ts";
import type { createNodeFs } from "../../../isolate/NodeFs.ts";
import type { createNodeOs } from "../../../isolate/NodeOs.ts";

type Message = Exclude<Awaited<ReturnType<ClaudeSdkQuery["next"]>>["value"], void>;
const usage = {
  input_tokens: 1,
  output_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  inference_geo: "",
  iterations: [],
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: "standard" as const,
  speed: "standard" as const,
};

/** SDK and CLI doubles, behind the real native adapter and its shared Node personality. */
export function nativeFixture(
  nativeId: string,
  systemIdentity: SystemIdentity,
  onExit?: () => void,
  queryNativeId: () => string = () => nativeId,
  model?: string,
) {
  const outputs: string[] = [];
  let consumed = 0;
  let launched = false;
  let sdkIdentity: string | undefined;
  const querySelections: Array<{ model: string | undefined; effort: string | undefined }> = [];
  let active: AbortController | undefined;
  let failure: unknown;
  const loadSdk = async (_bridge: NodeBridge): Promise<PreparedClaudeSdk> => ({
    query({ prompt, options }) {
      querySelections.push({ model: options.model, effort: options.effort });
      sdkIdentity = options.resume ?? options.sessionId;
      NodeAssert.equal(sdkIdentity, queryNativeId());
      if (options.spawnClaudeCodeProcess === undefined) throw new Error("Missing native spawn");
      const child = options.spawnClaudeCodeProcess({
        command: "/runtime/claude",
        args: ["--input-format", "stream-json"],
        cwd: "/workspace",
        env: { HOME: "/home/recorded", PATH: "/bin:/usr/bin" },
        signal: new AbortController().signal,
      });
      let closing = false;
      child.on("error", () => {});
      void (async () => {
        for await (const message of prompt) {
          if (closing) break;
          await writeInput(child, `${JSON.stringify(message)}\n`);
        }
      })().catch(() => {});
      async function* messages(): AsyncGenerator<Message> {
        let buffer = "";
        try {
          for await (const chunk of child.stdout) {
            buffer += String(chunk);
            for (;;) {
              const end = buffer.indexOf("\n");
              if (end < 0) break;
              const line = buffer.slice(0, end);
              buffer = buffer.slice(end + 1);
              consumed++;
              // The double writes only typed Message frames below.
              yield JSON.parse(line) as Message;
            }
          }
        } catch (error) {
          if (!closing) throw error;
        }
      }
      return Object.assign(messages(), {
        close() {
          closing = true;
          child.kill("SIGTERM");
        },
        setMcpServers: async (servers: object) => ({
          added: Object.keys(servers),
          removed: [],
          errors: {},
        }),
        setModel: async () => {},
        applyFlagSettings: async () => {},
        setPermissionMode: async () => {},
        stopTask: async () => {},
        backgroundTasks: async () => true,
        interrupt: async () => {
          active?.abort(new Error("turn interrupted"));
          return undefined;
        },
      }) satisfies ClaudeSdkQuery;
    },
    forkSession: async (sessionId) => ({ sessionId }),
    getSubagentMessages: async () => [],
  });
  const loadRelease = async (bridge: NodeBridge, signal: AbortSignal) => ({
    async launch() {
      launched = true;
      const fs = bridge.require("node:fs") as ReturnType<typeof createNodeFs>["fs"];
      NodeAssert.equal(fs.readFileSync("/workspace/.git", "utf8"), "gitdir: /recorded/git\n");
      NodeAssert.equal(fs.readFileSync("/source-alias/file.txt", "utf8"), "before\n");
      NodeAssert.equal(fs.readFileSync("/home/recorded/session", "utf8"), nativeId);
      NodeAssert.equal(
        fs.statSync("/usr/share/git-core/templates/description").mode & 0o777,
        0o644,
      );
      const logicalProcess = bridge.require("node:process") as ReturnType<typeof createNodeProcess>;
      if (onExit !== undefined) logicalProcess.once("exit", onExit);
      const os = bridge.require("node:os") as ReturnType<typeof createNodeOs>;
      NodeAssert.equal(logicalProcess.arch, systemIdentity.arch);
      NodeAssert.equal(logicalProcess.platform, systemIdentity.platform);
      NodeAssert.equal(os.arch(), logicalProcess.arch);
      NodeAssert.equal(os.platform(), logicalProcess.platform);
      NodeAssert.equal(os.release(), systemIdentity.release);
      NodeAssert.equal(os.version(), systemIdentity.version);
      NodeAssert.equal(os.machine(), systemIdentity.machine);
      NodeAssert.equal(os.hostname(), systemIdentity.hostname);
      const children = bridge.require("node:child_process") as ReturnType<
        typeof createNodeChildProcess
      >;
      NodeAssert.equal(logicalProcess.pid, 1);
      let buffer = "";
      try {
        for await (const chunk of logicalProcess.stdin) {
          buffer += String(chunk);
          const end = buffer.indexOf("\n");
          if (end < 0) continue;
          buffer = buffer.slice(end + 1);
          active = new AbortController();
          // @effect-diagnostics-next-line globalFetch:off - Exercise the installed model transport.
          const rootResponse = await globalThis.fetch(
            model === undefined
              ? "https://recorded.invalid/root"
              : "https://recorded.invalid/v1/messages?fixture=root",
            model === undefined
              ? undefined
              : {
                  method: "POST",
                  signal: active.signal,
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    model,
                    max_tokens: 32,
                    messages: [{ role: "user", content: "Run the controlled root request." }],
                  }),
                },
          );
          NodeAssert.equal(await rootResponse.text(), "root response");
          for (const [executable, args] of [
            ["/usr/bin/git", ["status", "--short"]],
            ["/bin/sed", ["-i", "s/before/after/", "file.txt"]],
            ["/usr/bin/machine-tool", ["--recorded"]],
          ] as const) {
            outputs.push(await runChild(children, executable, args, active.signal));
          }
          // @effect-diagnostics-next-line globalFetch:off - A child response uses the same recorded route.
          const childResponse = await globalThis.fetch(
            model === undefined
              ? "https://recorded.invalid/child"
              : "https://recorded.invalid/v1/messages?fixture=child",
            model === undefined
              ? undefined
              : {
                  method: "POST",
                  signal: active.signal,
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    model,
                    max_tokens: 32,
                    messages: [{ role: "user", content: "Run the controlled child request." }],
                  }),
                },
          );
          NodeAssert.equal(await childResponse.text(), "child response");
          const frame: Message = {
            type: "result",
            subtype: "success",
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            num_turns: 1,
            result: "commands complete",
            stop_reason: "end_turn",
            total_cost_usd: 0,
            usage,
            modelUsage: {},
            permission_denials: [],
            uuid: "00000000-0000-4000-8000-000000000001",
            session_id: queryNativeId(),
          };
          logicalProcess.stdout.write(`${JSON.stringify(frame)}\n`);
        }
      } catch (error) {
        if (!signal.aborted) {
          failure = error;
          throw error;
        }
      } finally {
        if (onExit !== undefined) logicalProcess.exit(0);
      }
    },
  });
  return {
    loadSdk,
    loadRelease,
    outputs,
    get failure() {
      return failure;
    },
    get consumed() {
      return consumed;
    },
    get launched() {
      return launched;
    },
    get sdkIdentity() {
      return sdkIdentity;
    },
    get querySelections() {
      return [...querySelections];
    },
  };
}

function writeInput(child: SdkSpawnedProcess, text: string) {
  return new Promise<void>((resolve, reject) =>
    child.stdin.write(text, (error) => (error ? reject(error) : resolve())),
  );
}

async function runChild(
  children: ReturnType<typeof createNodeChildProcess>,
  executable: string,
  args: readonly string[],
  signal: AbortSignal,
) {
  const child = children.spawn(executable, [...args], {
    cwd: "/workspace",
    env: { HOME: "/home/recorded", PATH: "/bin:/usr/bin" },
    signal,
  });
  let stdout = "";
  child.stdout?.on("data", (bytes: Uint8Array) => {
    stdout += new TextDecoder().decode(bytes);
  });
  child.stderr?.on("data", () => {});
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`Command exit ${code}`)),
    );
  });
  return stdout;
}
