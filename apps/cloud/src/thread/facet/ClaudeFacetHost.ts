import type { ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import { HarnessError } from "../../harness/Harness.ts";
import type { HostOpenInput, TurnAccess } from "../../harness/HarnessSessionHost.ts";
import {
  createProductClaudeHarnessSessionHost,
  type ProductClaudeHarnessHostOptions,
} from "../../harness/ProductClaudeHarnessSessionHost.ts";
import type { Actor } from "../ThreadAccess.ts";
import { createThreadClaudeSessions } from "../ThreadClaudeSessions.ts";
import { createThreadHarnessHost } from "../ThreadHarnessHost.ts";
import { ThreadRunner, type RunnerWork } from "../runner/ThreadRunner.ts";
import type { ThreadEngine } from "../ThreadEngine.ts";
import type { ThreadStore } from "../ThreadStore.ts";
import type { Threads } from "../Threads.ts";
import type { SessionRows } from "../session/SessionRows.ts";
import type { FacetHostPort } from "./FacetMachineBackend.ts";

type ClaudeHost<G> = Effect.Success<ReturnType<typeof createProductClaudeHarnessSessionHost<G>>>;

export interface ClaudeFacetHostOptions<G> {
  readonly threadId: ThreadId;
  readonly actor: Effect.Effect<Actor, HarnessError>;
  readonly host: Omit<ProductClaudeHarnessHostOptions<G>, "continuations">;
  readonly open: (work: RunnerWork) => HostOpenInput<G>;
  readonly access: (work: RunnerWork) => Effect.Effect<TurnAccess<G>, HarnessError>;
}

const failed = (message: string, cause?: unknown) =>
  new HarnessError({ operation: "open", message, ...(cause === undefined ? {} : { cause }) });

export const createClaudeFacetHost = <G>(
  options: ClaudeFacetHostOptions<G>,
  onFailure: (error: HarnessError) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const runner = yield* ThreadRunner;
    const services = yield* Effect.context<
      ThreadRunner | ThreadEngine | ThreadStore | Threads | SessionRows
    >();
    const owner = yield* Scope.Scope;
    const available = yield* Deferred.make<ClaudeHost<G>, HarnessError>();
    let live:
      | {
          readonly machineId: string;
          readonly generation: number;
          readonly scope: Scope.Closeable;
          readonly host: ClaudeHost<G>;
          attached: boolean;
        }
      | undefined;
    const stop = (threadId: ThreadId) =>
      Effect.gen(function* () {
        if (threadId !== options.threadId) return yield* failed("Wrong facet thread.");
        const previous = live;
        if (previous === undefined) return false;
        live = undefined;
        yield* previous.host.dispose.pipe(Effect.ensuring(Scope.close(previous.scope, Exit.void)));
        return true;
      });
    const port: FacetHostPort = {
      stop,
      inspect: (threadId, machineId) =>
        Effect.succeed(
          threadId === options.threadId && live?.machineId === machineId && live.attached,
        ),
      ensure: (request, machineId) =>
        Effect.gen(function* () {
          if (request.threadId !== options.threadId || options.host.threadId !== options.threadId)
            return yield* failed("The facet can only open its own thread.");
          if (live?.machineId === machineId && live.attached) return;
          if (live !== undefined) yield* stop(options.threadId);
          const scope = yield* Scope.fork(owner);
          yield* Effect.gen(function* () {
            const binding = yield* createThreadHarnessHost({
              threadId: options.threadId,
              hello: {
                threadId: options.threadId,
                generation: request.generation,
                token: request.token,
                machineId,
                imageVersion: options.host.release.identity.artifactHash,
              },
              actor: options.actor,
              access: options.access,
              persistCheckpoint: (checkpoint) =>
                Effect.gen(function* () {
                  const current = live;
                  if (current === undefined || current.generation !== request.generation)
                    return yield* failed("This facet no longer owns its checkpoint.");
                  const sessions = yield* createThreadClaudeSessions({
                    files: current.host.computer.files,
                    configurationDirectory:
                      options.host.native.process.env.CLAUDE_CONFIG_DIR ??
                      `${options.host.native.process.identity.homedir}/.claude`,
                  });
                  yield* sessions.persist(checkpoint.snapshot.providerThread);
                }).pipe(Effect.provide(services)),
            });
            yield* binding.authorize;
            const work = yield* runner.work;
            if (work.turn === null)
              return yield* failed("The facet has no canonical turn to open.");
            const input = yield* Effect.try({
              try: () => options.open(work),
              catch: (cause) => failed("Could not resolve the facet's open input.", cause),
            });
            const host = yield* createProductClaudeHarnessSessionHost({
              ...options.host,
              continuations: binding.continuations,
            });
            yield* host.seed("assets");
            yield* host.seed("programs");
            yield* binding.authorize;
            const session = yield* host.open(input);
            const opened = {
              machineId,
              generation: request.generation,
              scope,
              host,
              attached: false,
            };
            live = opened;
            if (input.checkpoint !== undefined) {
              const sessions = yield* createThreadClaudeSessions({
                files: host.computer.files,
                configurationDirectory:
                  options.host.native.process.env.CLAUDE_CONFIG_DIR ??
                  `${options.host.native.process.identity.homedir}/.claude`,
              });
              yield* sessions.persist(input.checkpoint.snapshot.providerThread);
            }
            yield* binding.attach(session);
            opened.attached = true;
            yield* Deferred.succeed(available, host);
            yield* binding.failure.pipe(
              Effect.catch((error) => (live === opened ? onFailure(error) : Effect.void)),
              Effect.forkIn(scope),
            );
          }).pipe(
            Scope.provide(scope),
            Effect.onError(() =>
              Effect.gen(function* () {
                if (live?.scope === scope) live = undefined;
                yield* Scope.close(scope, Exit.void);
              }),
            ),
          );
        }).pipe(Effect.provide(services)),
    };
    return {
      ...port,
      host: Deferred.await(available),
      dispose: Effect.asVoid(stop(options.threadId)),
    };
  });
