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
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type { ChildProcessSpawner } from "effect/process";

import { makeRunnerAdapters } from "./RunnerAdapters.ts";
import { layerSessionQueryRunner } from "./RunnerClaudeSessions.ts";
import { makeRunnerDrive } from "./RunnerDrive.ts";
import { makeDriveClient } from "./RunnerDriveClient.ts";
import { machineLayout, writeModelToken } from "./RunnerModelAccess.ts";
import { makeRunnerSession, type RunnerSession } from "./RunnerSession.ts";
import { makeRunnerSessions } from "./RunnerSessions.ts";
import { runnerConnectUrl, webSocketTransport } from "./runnerSocket.ts";
import { makeRunnerTurns } from "./RunnerTurns.ts";

/**
 * Runs threads' Runners on this machine. `ensure` starts a thread's Runner at
 * a generation and keeps it until the thread lets it go; asking again for the
 * same generation is a no-op, and a higher generation replaces the thread's
 * older Runner. Each thread gets a machine directory of its own
 * (`machines/<thread>`: home, harness config, model token) so no thread's
 * harnesses see this machine's own logins or another thread's token.
 *
 * Two fronts use it: `runRunnerHost`, a development machine backend serving
 * every thread that asks over HTTP, and `runRunnerMachine`, the Runner on a
 * thread's own VM (`RunnerMachine.ts`).
 */

export interface RunnerHostConfig {
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

export type EnsureOutcome = "started" | "running" | "superseded";

export const makeRunnerHost = Effect.fn("makeRunnerHost")(function* (config: RunnerHostConfig) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostScope = yield* Effect.scope;
  // What a thread's drive checkout uses: the filesystem, git and HTTP to the cloud.
  const driveServices = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >();
  const runners = new Map<ThreadId, HostedRunner>();
  const lock = yield* Semaphore.make(1);

  const stop = (threadId: ThreadId, runner: HostedRunner) =>
    Effect.suspend(() => {
      if (runners.get(threadId) === runner) runners.delete(threadId);
      return Scope.close(runner.scope, Exit.void);
    });

  /** Runs `request`'s Runner, dialing the cloud at `cloudUrl`. */
  const ensure = (request: MachineEnsureRequest, cloudUrl: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const existing = runners.get(request.threadId);
        if (existing?.generation === request.generation) return "running";
        if (existing !== undefined && existing.generation > request.generation) {
          return "superseded";
        }
        if (existing !== undefined) yield* stop(request.threadId, existing);
        const cwd = path.join(config.home, "threads", request.threadId);
        yield* fs.makeDirectory(cwd, { recursive: true });
        const scope = yield* Scope.fork(hostScope);
        const session = yield* Effect.gen(function* () {
          const root = path.join(config.home, "machines", request.threadId);
          // The harnesses' sessions leave the machine as they are written (#132).
          const sessions = yield* makeRunnerSessions({
            cloudUrl,
            codexHome: machineLayout(path, root).codexHome,
          }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(driveServices));
          const { adapters, layout } = yield* makeRunnerAdapters({
            root,
            gatewayUrl: request.modelGatewayUrl,
            claudeQueryRunner: layerSessionQueryRunner(sessions.claude),
          });
          return yield* makeRunnerSession({
            threadId: request.threadId,
            generation: request.generation,
            token: request.token,
            machineId: config.machineId,
            imageVersion: config.imageVersion,
            transport: webSocketTransport(runnerConnectUrl(cloudUrl, request.threadId)),
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
                openDrive: (access) =>
                  Effect.flatMap(makeDriveClient({ cloudUrl, access }), (client) =>
                    makeRunnerDrive({ cwd, client }),
                  ).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(driveServices)),
                sessions,
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
        return "started";
      }),
    );

  /** Closes every Runner's socket, as a network drop would. Each reconnects. */
  const dropSockets = Effect.suspend(() =>
    Effect.as(
      Effect.forEach(runners.values(), (runner) => runner.session.dropConnection),
      runners.size,
    ),
  );

  return { ensure, dropSockets };
});

export interface RunnerHttpHostConfig extends RunnerHostConfig {
  /** The cloud's origin, e.g. `http://localhost:8787`. */
  readonly cloudUrl: string;
  readonly port: number;
}

/**
 * A development machine backend: this machine, serving every thread that
 * asks. The cloud's `local` backend posts `/machines/ensure` with a thread,
 * generation, token and ModelGateway. `/machines/drop-sockets` closes every
 * Runner's socket, so reconnecting mid-turn can be tried by hand.
 */
export const runRunnerHost = Effect.fn("runRunnerHost")(function* (config: RunnerHttpHostConfig) {
  const host = yield* makeRunnerHost(config);

  const routes = Layer.mergeAll(
    HttpRouter.add(
      "POST",
      "/machines/ensure",
      Effect.gen(function* () {
        const body = yield* (yield* HttpServerRequest.HttpServerRequest).text;
        const outcome = yield* host.ensure(machineEnsureJson.decode(body), config.cloudUrl);
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
      Effect.map(host.dropSockets, (dropped) => HttpServerResponse.jsonUnsafe({ dropped })),
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
