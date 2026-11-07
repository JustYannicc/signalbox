import * as Exit from "effect/Exit";
import { productMachineFiles } from "./productMachineFiles.fixture.ts";
import { serializeHarnessFailure } from "../../../Harness.ts";
import { DurableObject } from "cloudflare:workers";
import { RunId, RunAttemptId, MessageId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createProductClaudeHarnessSessionHost } from "../../../ProductClaudeHarnessSessionHost.ts";
import { makeContinuationHostInputs } from "../../../tests/productHost/continuationHostInputs.ts";
import { loadClaudeSdkHost } from "../../../ClaudeSdkHostLoader.ts";
import { storageFor } from "./productFacet.common.fixture.ts";

export class ProductLifetime extends DurableObject<{ readonly PRODUCT_SDK_SOURCE: string }> {
  override async fetch(request: Request) {
    const scenario = new URL(request.url).pathname.slice(1);
    return Response.json(
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(
            function* (this: ProductLifetime) {
              const input = yield* makeContinuationHostInputs(
                {
                  storage: storageFor(this.ctx),
                  rows: (query) => this.ctx.storage.sql.exec(query).toArray(),
                },
                false,
              );
              const sdk = loadClaudeSdkHost(`lifetime-sdk/${scenario}`, {
                mainModule: "sdk.mjs",
                modules: { "sdk.mjs": { js: this.env.PRODUCT_SDK_SOURCE } },
                env: { LIFETIME: true, SDK_OMISSION: scenario === "sdk-omission" },
                compatibilityDate: "2026-10-19",
                compatibilityFlags: ["nodejs_compat", "new_module_registry"],
                globalOutbound: null,
              });
              let launches = 0;
              let saves = 0;
              let disposed = false;
              let cleanupFailure: unknown;
              const entered = Promise.withResolvers<void>();
              const aborted = Promise.withResolvers<void>();
              const original = input.hostOptions;
              const disposing = scenario === "dispose" || scenario === "dispose-body";
              const host = yield* createProductClaudeHarnessSessionHost({
                ...original,
                commands: {
                  ...original.commands,
                  machine: (identity) => {
                    const machine = original.commands.machine(identity);
                    const files = productMachineFiles(original.machineInventory);
                    return {
                      ...machine,
                      files,
                      async spawn(command, signal) {
                        await files.markExecuted(files.current().generation!);
                        return machine.spawn(command, signal);
                      },
                    };
                  },
                },
                save: async (value) => {
                  saves++;
                  return await original.save(value);
                },
                native: {
                  sdkHost: sdk,
                  process: {
                    ...original.native.process,
                    onLaunch: () => {
                      launches++;
                    },
                  },
                },
                modelTransport:
                  scenario === "dispose-body"
                    ? async (request) =>
                        new Response(
                          new ReadableStream<Uint8Array>({
                            start(controller) {
                              controller.enqueue(
                                new TextEncoder().encode("partial model response"),
                              );
                              entered.resolve();
                              request.signal.addEventListener("abort", () => aborted.resolve(), {
                                once: true,
                              });
                            },
                            cancel() {
                              aborted.resolve();
                            },
                          }),
                        )
                    : scenario === "dispose"
                      ? (request) =>
                          new Promise<Response>((_resolve, reject) => {
                            entered.resolve();
                            const abort = () => {
                              aborted.resolve();
                              reject(request.signal.reason);
                            };
                            if (request.signal.aborted) abort();
                            else request.signal.addEventListener("abort", abort, { once: true });
                          })
                      : scenario === "error"
                        ? async () => {
                            throw new Error("controlled model stream failure");
                          }
                        : original.modelTransport,
              });
              yield* Effect.addFinalizer(() => host.dispose.pipe(Effect.ignoreCause));
              yield* host.seed("assets");
              yield* host.seed("programs");
              const session = yield* host.open({
                session: input.sessionInput,
                bootAttemptId: "lifetime",
              });
              const first = yield* Deferred.make<void>();
              const second = yield* Deferred.make<void>();
              const statuses: string[] = [];
              yield* session.events.pipe(
                Stream.runForEach((item) =>
                  Effect.gen(function* () {
                    if (item.kind !== "provider" || item.event.type !== "turn.terminal") return;
                    if (typeof item.event.status !== "string")
                      throw new Error("Missing terminal status");
                    statuses.push(item.event.status);
                    yield* Deferred.succeed(statuses.length === 1 ? first : second, undefined);
                  }),
                ),
                Effect.forkScoped,
              );
              yield* session.turn({ turn: input.turn, access: input.access });
              if (disposing) {
                yield* Effect.promise(() => entered.promise);
                const closed = yield* Effect.exit(host.dispose);
                if (Exit.isFailure(closed)) cleanupFailure = serializeHarnessFailure(closed.cause);
                yield* Effect.promise(() => aborted.promise);
                disposed = true;
              } else {
                yield* Deferred.await(first);
                if (scenario === "two-turns") {
                  const runId = RunId.make("split-sdk-turn-two");
                  input.setRunId(runId);
                  yield* session.turn({
                    turn: {
                      ...input.turn,
                      runId,
                      runOrdinal: 2,
                      providerTurnOrdinal: 2,
                      attemptId: RunAttemptId.make("split-sdk-attempt-two"),
                      message: {
                        ...input.turn.message,
                        messageId: MessageId.make("split-sdk-message-two"),
                        text: "Second turn",
                      },
                    },
                    access: input.access,
                  });
                  yield* Deferred.await(second);
                }
                const closed = yield* Effect.exit(host.dispose);
                if (Exit.isFailure(closed)) cleanupFailure = serializeHarnessFailure(closed.cause);
                disposed = true;
              }
              return {
                launches,
                saves,
                statuses,
                disposed,
                cleanupFailure,
                processes: host.commands.processes.size,
              };
            }.bind(this),
          ),
        ),
      ).catch((cause) => ({ failure: serializeHarnessFailure(cause) })),
    );
  }
}
