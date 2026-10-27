// @effect-diagnostics nodeBuiltinImport:off - Controlled native modules run in an isolated test realm.
import * as NodeAssert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import type { ClaudeSdkQuery } from "@signalbox/provider-claude/ClaudeSdkQueryRunner";
import type { PreparedClaudeSdk } from "../../ClaudeIsolateAdapter.ts";
import type { createNodeProcess } from "../../../isolate/NodeProcess.ts";
import { createProductClaudeHarnessSessionHost } from "../../ProductClaudeHarnessSessionHost.ts";
import { continuationHostInputs } from "./continuationHost.ts";

const message = "Error processing settings: ENOTSUP: mkdir '/tmp/claude-1000'";

export function run() {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const input = yield* continuationHostInputs;
        const exited = Promise.withResolvers<unknown>();
        const stderr: Uint8Array[] = [];
        const kills: boolean[] = [];
        const host = yield* createProductClaudeHarnessSessionHost({
          ...input.hostOptions,
          observeOutput: (fd, bytes) => {
            if (fd === 2) stderr.push(bytes.slice());
          },
          native: {
            ...input.hostOptions.native,
            processObserver: {
              started(process) {
                void process.exited.then(exited.resolve, exited.reject);
              },
              abandoned: exited.reject,
            },
            loadSdk: async (bridge): Promise<PreparedClaudeSdk> => {
              const guest = bridge.require("process") as ReturnType<typeof createNodeProcess>;
              return {
                query({ options }) {
                  const spawn = options.spawnClaudeCodeProcess;
                  if (spawn === undefined) throw new Error("Missing native spawn");
                  const child = spawn({
                    command: "/runtime/claude",
                    args: ["--input-format", "stream-json"],
                    cwd: "/workspace",
                    env: { HOME: "/home/recorded", PATH: "/bin" },
                    signal: new AbortController().signal,
                  });
                  const closed = Promise.withResolvers<void>();
                  child.on("error", closed.reject);
                  child.once("exit", () => closed.resolve());
                  // The real SDK registers its cleanup against this shared guest process.
                  guest.once("exit", () => kills.push(child.kill("SIGTERM")));
                  async function* messages(): AsyncGenerator<never> {
                    await closed.promise;
                    yield* [];
                  }
                  return Object.assign(messages(), {
                    initializationResult: async () =>
                      ({}) as Awaited<ReturnType<ClaudeSdkQuery["initializationResult"]>>,
                    close: () => child.kill("SIGTERM"),
                    setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
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
              };
            },
            process: {
              ...input.hostOptions.native.process,
              loadRelease: async (bridge) => ({
                launch() {
                  const guest = bridge.require("process") as ReturnType<typeof createNodeProcess>;
                  const guestConsole = bridge.require("console") as Pick<Console, "error">;
                  guestConsole.error(message);
                  guest.exit(1);
                },
              }),
            },
          },
        });
        yield* Effect.addFinalizer(() => host.dispose.pipe(Effect.orDie));
        yield* host.seed("assets");
        yield* host.seed("programs");
        const session = yield* host.open({
          session: input.sessionInput,
          bootAttemptId: "exit-output",
        });
        yield* session.events.pipe(Stream.runDrain, Effect.forkScoped);
        const turn = yield* session
          .turn({ turn: input.turn, access: input.access })
          .pipe(Effect.exit, Effect.forkScoped);
        NodeAssert.deepEqual(yield* Effect.promise(() => exited.promise), {
          exitCode: 1,
          signal: 0,
          coreDumped: false,
        });
        yield* Fiber.interrupt(turn);
        NodeAssert.equal(Buffer.concat(stderr).toString(), `${message}\n`);
        NodeAssert.deepEqual(kills, [false]);
      }),
    ),
  );
}
