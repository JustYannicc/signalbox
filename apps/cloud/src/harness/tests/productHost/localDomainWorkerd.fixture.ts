import * as NodeAssert from "node:assert/strict";
import * as NodeUtil from "node:util";
import { DurableObject } from "cloudflare:workers";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  OrchestrationV2ThreadShellJson,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";

import { createLocalClaudeThreadHost } from "../../../LocalClaudeThreadHost.ts";
import { LocalPoolObject } from "../../../pool/LocalPoolObject.ts";
import { LocalUserObject } from "../../../user/LocalUserObject.ts";
import { createLocalClaudeThreadObject } from "../../../thread/LocalClaudeThreadObject.ts";
import type { ProductClaudeThreadMachine } from "../../../thread/ProductClaudeThreadHost.ts";
import { makeContinuationHostInputs } from "./continuationHostInputs.ts";
import { threadOwnerRuntimeFixture } from "./threadOwnerRuntime.fixture.ts";
import type { OrdinaryOwnerEvent } from "./ordinaryOwnerObservation.fixture.ts";

const selection: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "xhigh" }],
};
type Inputs = Effect.Success<ReturnType<typeof makeContinuationHostInputs>>;
const inputs = new Map<string, Inputs>();
const decodeIndexedShell = Schema.decodeUnknownSync(
  Schema.fromJsonString(OrchestrationV2ThreadShellJson),
);

interface Env {
  readonly USERS: DurableObjectNamespace<LocalUser>;
  readonly POOLS: DurableObjectNamespace<LocalPool>;
  readonly THREADS: DurableObjectNamespace<LocalThread>;
  readonly OBSERVATIONS: DurableObjectNamespace<OrdinaryObservations>;
  readonly LOADER: WorkerLoader;
  readonly REAL_OWNERS?: boolean;
  readonly KERNEL_SOURCE: string;
  readonly CLI_SOURCE: string;
  readonly COMPUTER_SOURCE: string;
  readonly SDK_SOURCE: string;
}

export class OrdinaryObservations extends DurableObject {
  readonly #events: OrdinaryOwnerEvent[] = [];
  async record(event: OrdinaryOwnerEvent) {
    this.#events.push(event);
  }
  async snapshot() {
    return [...this.#events];
  }
}

export class LocalUser extends LocalUserObject {
  storageShape() {
    return {
      object: this.ctx.id.toString(),
      grants: this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(grants)")
        .toArray()
        .map((row) => row.name),
      threads: this.ctx.storage.sql
        .exec<{ shell: string }>("SELECT shell FROM thread_index ORDER BY thread_id")
        .toArray()
        .map((row) => {
          const shell = decodeIndexedShell(row.shell);
          return {
            id: shell.id,
            latestRunId: shell.latestRunId,
            activeRunId: shell.activeRunId,
            completed: shell.latestRunCompletedAt != null,
          };
        }),
    };
  }
}

export class LocalPool extends LocalPoolObject {
  readonly #cancelled = Promise.withResolvers<void>();

  override forwardModel(...args: Parameters<LocalPoolObject["forwardModel"]>) {
    args[2].signal.addEventListener("abort", () => this.#cancelled.resolve(), { once: true });
    return super.forwardModel(...args);
  }

  async waitForCancellation() {
    await this.#cancelled.promise;
  }

  storageShape() {
    return {
      object: this.ctx.id.toString(),
      grants: this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(grants)")
        .toArray()
        .map((row) => row.name),
    };
  }
}

const ThreadBase = createLocalClaudeThreadObject<Env, string>((ctx, env, configuration) =>
  Effect.gen(function* () {
    const input = yield* makeContinuationHostInputs(
      {
        storage: ctx.storage,
        rows: (query) => ctx.storage.sql.exec(query).toArray(),
      },
      false,
      false,
      "explicit",
      true,
      configuration.modelSelection,
    );
    NodeAssert.equal(configuration.threadId, input.threadId);
    inputs.set(ctx.id.toString(), input);
    let host = threadOwnerRuntimeFixture(input.hostOptions, () => input.native.failure, ctx).host;
    if (env.REAL_OWNERS) {
      const observer = env.OBSERVATIONS.getByName(configuration.threadId);
      const code = (role: string, source: string): WorkerLoaderWorkerCode => ({
        compatibilityDate: "2026-10-01",
        compatibilityFlags: ["nodejs_compat"],
        mainModule: `${role}.mjs`,
        modules: { [`${role}.mjs`]: { js: source } },
        env: { OBSERVE: observer },
        globalOutbound: null,
      });
      host = {
        ...host,
        runtime: {
          loader: env.LOADER,
          facets: ctx.facets,
          code: {
            kernel: code("kernel", env.KERNEL_SOURCE),
            cli: code("cli", env.CLI_SOURCE),
            computer: code("computer", env.COMPUTER_SOURCE),
            sdk: code("sdk", env.SDK_SOURCE),
          },
        },
      };
    }
    return {
      host,
      open: (work) => {
        NodeAssert.ok(work.turn);
        return {
          session: {
            ...input.sessionInput,
            modelSelection: work.turn.modelSelection,
            providerSessionId:
              work.turn.providerThread.providerSessionId ?? input.sessionInput.providerSessionId,
          },
          bootAttemptId: "workerd-local-domain-turn",
        };
      },
      access: (work) =>
        Effect.sync(() => {
          NodeAssert.ok(work.turn);
          input.setRunId(work.turn.runId);
          return input.access;
        }),
    } satisfies ProductClaudeThreadMachine<string>;
  }).pipe(Effect.orDie),
);

export class LocalThread extends ThreadBase {
  async proofState() {
    const binding = await this.getBinding();
    await binding.afterChange();
    NodeAssert.equal(await Effect.runPromise(binding.engine.pendingSummary), null);
    const input = inputs.get(this.ctx.id.toString());
    if (input === undefined) throw new Error("No controlled machine has opened.");
    if (this.env.REAL_OWNERS) {
      const events = await this.env.OBSERVATIONS.getByName("thread").snapshot();
      return {
        object: this.ctx.id.toString(),
        querySelections: events
          .filter((event) => event.kind === "sdk-query")
          .map(({ model, effort }) => ({ model, effort })),
        prompts: events.filter((event) => event.kind === "sdk-prompt").length,
        queries: events.filter((event) => event.kind === "sdk-query").length,
        owners: events,
      };
    }
    return {
      object: this.ctx.id.toString(),
      querySelections: input.native.querySelections,
      prompts: input.native.userPromptCount,
      queries: input.native.queryIdentities.length,
      owners: new Array<OrdinaryOwnerEvent>(),
    };
  }
}

export default {
  async fetch(_request: Request, env: Env) {
    const interrupt = new URL(_request.url).pathname === "/interrupt";
    try {
      return await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const modelRequests: string[] = [];
            const entered = Promise.withResolvers<void>();
            const stopped = Promise.withResolvers<void>();
            const binding = yield* createLocalClaudeThreadHost({
              modelSelection: selection,
              modelTransport: async (request) => {
                const body: unknown = await request.clone().json();
                NodeAssert.ok(body !== null && typeof body === "object" && "model" in body);
                NodeAssert.equal(body.model, selection.model);
                const url = new URL(request.url);
                modelRequests.push(`${url.pathname}${url.search}`);
                if (interrupt) {
                  let sent = false;
                  return new Response(
                    new ReadableStream<Uint8Array>(
                      {
                        start(controller) {
                          request.signal.addEventListener(
                            "abort",
                            () => {
                              stopped.resolve();
                              controller.error(request.signal.reason);
                            },
                            { once: true },
                          );
                        },
                        pull(controller) {
                          if (sent) return;
                          sent = true;
                          controller.enqueue(new TextEncoder().encode("root response"));
                          entered.resolve();
                        },
                      },
                      { highWaterMark: 0 },
                    ),
                  );
                }
                return new Response(
                  url.searchParams.get("fixture") === "root" ? "root response" : "child response",
                );
              },
              machine: {
                type: "workerd",
                threadId: "thread",
                objects: {
                  user: env.USERS,
                  pool: env.POOLS,
                  thread: env.THREADS,
                },
              },
            });
            const actor = yield* binding.actor;
            const models = yield* binding.pool.models({ userId: actor.userId });
            NodeAssert.deepEqual(
              models.models.map((model) => model.id),
              [selection.model],
            );
            yield* Effect.flip(binding.pool.models({ userId: "unrelated-owner" }));
            const catalog = yield* binding.domain.catalog;
            NodeAssert.ok(
              catalog.providers.some(
                (provider) =>
                  provider.status === "ready" &&
                  provider.models.some((model) => model.slug === selection.model),
              ),
            );
            const launch = {
              commandId: CommandId.make("workerd-local-launch"),
              threadId: ThreadId.make("thread"),
              projectId: ProjectId.make("scratch"),
              title: "A workerd local thread",
              modelSelection: binding.modelSelection,
              runtimeMode: "full-access" as const,
              interactionMode: "default" as const,
              workspaceStrategy: { type: "root" as const },
              initialMessage: {
                messageId: MessageId.make("workerd-initial-message"),
                text: "Run the controlled commands.",
                attachments: [],
              },
            };
            yield* Effect.flip(
              binding.launch({
                ...launch,
                commandId: CommandId.make("workerd-unserved-model"),
                modelSelection: { ...binding.modelSelection, model: "unregistered-model" },
              }),
            );
            NodeAssert.deepEqual(modelRequests, []);
            yield* binding.launch(launch);
            if (interrupt) {
              yield* Effect.promise(() => entered.promise);
              const running = yield* binding.snapshot();
              const run = running.projection.runs[0];
              NodeAssert.ok(run);
              yield* binding.dispatch({
                type: "run.interrupt",
                commandId: CommandId.make("workerd-local-interrupt"),
                threadId: ThreadId.make("thread"),
                runId: run.id,
              });
              const pool = env.POOLS.get(env.POOLS.idFromName("local:thread:pool"));
              yield* Effect.promise(() =>
                Promise.all([stopped.promise, pool.waitForCancellation()]),
              ).pipe(Effect.raceFirst(binding.failure));
              NodeAssert.deepEqual(modelRequests, ["/v1/messages?fixture=root"]);
              return Response.json({ ok: true, poolStopped: true, upstreamStopped: true });
            }
            yield* binding.subscribe().pipe(
              Stream.flattenIterable,
              Stream.takeUntil(
                (item) =>
                  (item.kind === "snapshot" &&
                    item.projection.runs.some((run) => run.status === "completed")) ||
                  (item.kind === "event" &&
                    item.event.type === "run.updated" &&
                    item.event.payload.status === "completed"),
              ),
              Stream.runDrain,
              Effect.raceFirst(binding.failure),
            );
            const snapshot = yield* binding.snapshot();
            NodeAssert.equal(snapshot.projection.runs.length, 1);
            NodeAssert.equal(snapshot.projection.runs[0]?.status, "completed");
            const user = env.USERS.get(env.USERS.idFromName("local:thread:user"));
            const pool = env.POOLS.get(env.POOLS.idFromName("local:thread:pool"));
            const thread = env.THREADS.get(env.THREADS.idFromName("thread"));
            const native = yield* Effect.promise(() => thread.proofState());
            const [userShape, poolShape] = yield* Effect.promise(() =>
              Promise.all([user.storageShape(), pool.storageShape()]),
            );
            NodeAssert.equal(new Set([userShape.object, poolShape.object, native.object]).size, 3);
            NodeAssert.equal(native.prompts, 1);
            NodeAssert.equal(native.queries, 1);
            NodeAssert.equal(userShape.threads.length, 1);
            NodeAssert.equal(userShape.threads[0]?.id, "thread");
            NodeAssert.equal(userShape.threads[0]?.latestRunId, snapshot.projection.runs[0]?.id);
            NodeAssert.equal(userShape.threads[0]?.activeRunId, null);
            NodeAssert.equal(userShape.threads[0]?.completed, true);
            NodeAssert.deepEqual(native.querySelections, [
              { model: selection.model, effort: "xhigh" },
            ]);
            return Response.json({
              ok: true,
              runs: snapshot.projection.runs.length,
              status: snapshot.projection.runs[0]?.status,
              querySelections: native.querySelections,
              modelRequests,
              userGrants: userShape.grants,
              poolGrants: poolShape.grants,
              indexedCompletedRuns: userShape.threads.length,
              owners: native.owners,
            });
          }),
        ),
      );
    } catch (error) {
      return Response.json(
        {
          ok: false,
          error: NodeUtil.inspect(error, { depth: 30 }),
          observations: env.REAL_OWNERS
            ? await env.OBSERVATIONS.getByName("thread").snapshot()
            : [],
        },
        { status: 500 },
      );
    }
  },
};
export * from "../../../FixtureWorkerExports.ts";
