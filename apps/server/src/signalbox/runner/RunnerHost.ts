// @effect-diagnostics nodeBuiltinImport:off - the local machine host is a Node HTTP boundary.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  machineEnsureJson,
  type MachineEnsureRequest,
} from "@signalbox/runner-protocol/RunnerProtocol";
import type { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { makeRunnerAdapters } from "./RunnerAdapters.ts";
import { writeModelToken } from "./RunnerModelAccess.ts";
import { makeRunnerSession, type RunnerSession } from "./RunnerSession.ts";
import { runnerConnectUrl, webSocketTransport } from "./runnerSocket.ts";
import { makeRunnerTurns } from "./RunnerTurns.ts";

/**
 * A development machine backend: this machine, serving every thread that
 * asks. The cloud's `local` backend posts `/machines/ensure` with a thread,
 * generation, token and ModelGateway; the host runs that thread's Runner until
 * the thread lets it go, and a higher generation replaces the thread's older
 * Runner. Real machines run one Runner per thread VM (#130); this stands in
 * for them, giving each thread a machine directory of its own
 * (`machines/<thread>`: home, harness config, model token) so no thread's
 * harnesses see this machine's own logins or another thread's token.
 *
 * `/machines/drop-sockets` closes every Runner's socket, as a network drop
 * would, so reconnecting mid-turn can be tried by hand.
 */

export interface RunnerHostConfig {
  /** The cloud's origin, e.g. `http://localhost:8787`. */
  readonly cloudUrl: string;
  readonly port: number;
  /** Where threads' working directories and machine state live. */
  readonly home: string;
  readonly machineId: string;
  readonly imageVersion: string;
}

interface HostedRunner {
  readonly generation: number;
  readonly scope: Scope.Closeable;
  readonly session: RunnerSession;
}

export const runRunnerHost = Effect.fn("runRunnerHost")(function* (config: RunnerHostConfig) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostScope = yield* Effect.scope;
  const runners = new Map<ThreadId, HostedRunner>();
  const lock = yield* Semaphore.make(1);

  const stop = (threadId: ThreadId, runner: HostedRunner) =>
    Effect.suspend(() => {
      if (runners.get(threadId) === runner) runners.delete(threadId);
      return Scope.close(runner.scope, Exit.void);
    });

  const ensure = (request: MachineEnsureRequest) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const existing = runners.get(request.threadId);
        if (existing?.generation === request.generation) return "running" as const;
        if (existing !== undefined && existing.generation > request.generation) {
          return "superseded" as const;
        }
        if (existing !== undefined) yield* stop(request.threadId, existing);
        const cwd = path.join(config.home, "threads", request.threadId);
        yield* fs.makeDirectory(cwd, { recursive: true });
        const scope = yield* Scope.fork(hostScope);
        const session = yield* Effect.gen(function* () {
          const { adapters, layout } = yield* makeRunnerAdapters({
            root: path.join(config.home, "machines", request.threadId),
            gatewayUrl: request.modelGatewayUrl,
          });
          return yield* makeRunnerSession({
            threadId: request.threadId,
            generation: request.generation,
            token: request.token,
            machineId: config.machineId,
            imageVersion: config.imageVersion,
            transport: webSocketTransport(runnerConnectUrl(config.cloudUrl, request.threadId)),
            makeTurns: (emit) =>
              makeRunnerTurns({
                threadId: request.threadId,
                adapters,
                cwd,
                useModelToken: (token) =>
                  writeModelToken(layout, token).pipe(
                    Effect.provideService(FileSystem.FileSystem, fs),
                  ),
                emit,
              }),
          });
        }).pipe(
          Scope.provide(scope),
          // A machine that failed to come up leaves nothing running behind.
          Effect.onError(() => Scope.close(scope, Exit.void)),
        );
        const runner: HostedRunner = { generation: request.generation, scope, session };
        runners.set(request.threadId, runner);
        yield* Effect.logInfo("runner started", {
          threadId: request.threadId,
          generation: request.generation,
        });
        yield* session.ended.pipe(
          Effect.flatMap((reason) =>
            Effect.logInfo("runner ended", { threadId: request.threadId, reason }),
          ),
          Effect.andThen(lock.withPermits(1)(stop(request.threadId, runner))),
          Effect.forkIn(hostScope),
        );
        return "started" as const;
      }),
    );

  const routes = Layer.mergeAll(
    HttpRouter.add(
      "POST",
      "/machines/ensure",
      Effect.gen(function* () {
        const body = yield* (yield* HttpServerRequest.HttpServerRequest).text;
        const outcome = yield* ensure(machineEnsureJson.decode(body));
        return outcome === "superseded"
          ? HttpServerResponse.text("A newer generation runs this thread.", { status: 409 })
          : HttpServerResponse.jsonUnsafe({ outcome });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("ensure failed", Cause.pretty(cause)).pipe(
            Effect.as(HttpServerResponse.text("Could not start a Runner.", { status: 500 })),
          ),
        ),
      ),
    ),
    HttpRouter.add(
      "POST",
      "/machines/drop-sockets",
      Effect.gen(function* () {
        yield* Effect.forEach(runners.values(), (runner) => runner.session.dropConnection);
        return HttpServerResponse.jsonUnsafe({ dropped: runners.size });
      }),
    ),
  );

  yield* HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provide(
      NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: config.port }),
    ),
    Layer.build,
  );
  yield* Effect.logInfo(`Runner host on http://127.0.0.1:${config.port}, cloud ${config.cloudUrl}`);
  return yield* Effect.never;
});
