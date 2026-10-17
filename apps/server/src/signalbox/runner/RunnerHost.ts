// @effect-diagnostics nodeBuiltinImport:off - the local machine host is a Node HTTP boundary.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { threadRemoteBranch } from "@signalbox/runner-protocol/DriveProtocol";
import type { DriveAccess } from "@signalbox/runner-protocol/DriveProtocol";
import { PREVIEW_TUNNEL_PATH } from "@signalbox/runner-protocol/PreviewTunnel";
import type { PreviewService } from "@signalbox/runner-protocol/PreviewServices";
import {
  machineEnsureJson,
  type MachineEnsureRequest,
  type RunnerBuild,
} from "@signalbox/runner-protocol/RunnerProtocol";
import type { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
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
import { makeMachineCaches } from "./RunnerCaches.ts";
import { layerSessionQueryRunner } from "./RunnerClaudeSessions.ts";
import { makeContextClient } from "./RunnerContextClient.ts";
import { startContextServer, withContextServer } from "./RunnerContextServer.ts";
import { makeRunnerDrive } from "./RunnerDrive.ts";
import { makeRunnerDependencies } from "./RunnerDependencies.ts";
import { makeDriveClient } from "./RunnerDriveClient.ts";
import { outsideFolders } from "./RunnerMachineFolders.ts";
import { machineLayout, writeModelToken } from "./RunnerModelAccess.ts";
import { makeDiscoveredPorts } from "./RunnerPreviewPorts.ts";
import {
  previewTunnelTransport,
  runPreviewTunnel,
  type PreviewTunnel,
} from "./RunnerPreviewTunnel.ts";
import { onePasswordSdk, type OnePassword } from "./RunnerOnePassword.ts";
import { makeRunnerSecrets, makeSecretsRegistrar } from "./RunnerSecrets.ts";
import { makeRunnerSession, RunnerConnectionError, type RunnerSession } from "./RunnerSession.ts";
import { makeRunnerSessions } from "./RunnerSessions.ts";
import {
  maskingTransport,
  runnerConnectUrl,
  threadSocketUrl,
  webSocketTransport,
} from "./runnerSocket.ts";
import { makeRunnerAttachments } from "./RunnerAttachments.ts";
import type { SecretMask } from "./secretMask.ts";
import { makeRunnerTurns } from "./RunnerTurns.ts";
import type { RunnerDrive } from "./RunnerDrive.ts";
import { makePreviewServices } from "./RunnerPreviewServices.ts";
import { makeRunnerUsage } from "./RunnerUsage.ts";

/**
 * Runs threads' Runners on this machine. `ensure` starts a thread's Runner at
 * a generation and keeps it until the thread lets it go; asking again for the
 * same generation is a no-op, and a higher generation replaces the thread's
 * older Runner. Each thread gets a machine directory of its own
 * (`machines/<thread>`: home, harness config, model token) so no thread's
 * harnesses see this machine's own logins or another thread's token, and a
 * working directory (`workspaces/<thread>/drive`).
 *
 * Each Runner also runs the PreviewGateway's tunnel for its thread, which
 * starts and stops with that generation and mirrors the agent's browser.
 *
 * A thread's secrets (`RunnerSecrets.ts`) reach only its own harness
 * sessions, and the host's one mask (`secretMask.ts`) covers everything its
 * Runners send and log.
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
  /** Sent in every `hello`. */
  readonly build: RunnerBuild;
  /**
   * Where each Runner mounts `/drives` (#141): only on a thread's own VM,
   * where one Runner runs at a time. Absent: the context tool alone reads it.
   */
  readonly drivesMountPoint?: string;
  /** Masks every secret a Runner here loaded; the host's logger uses it too. */
  readonly secretMask: SecretMask;
  /** Reads 1Password Environments. Absent: 1Password's SDK. */
  readonly onePassword?: OnePassword;
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
  const previewPorts = yield* makeDiscoveredPorts;
  const caches = yield* makeMachineCaches(config.home);
  const mask = config.secretMask;

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
        if (existing !== undefined) {
          // The thread asked for a newer machine only after it let this one go.
          yield* existing.session.replaced;
          yield* stop(request.threadId, existing);
        }
        // The checkout sits one folder down: the folder above holds the instructions
        // its shortcuts bring, outside the drive (`RunnerInstructions.ts`).
        const cwd = path.join(config.home, "workspaces", request.threadId, "drive");
        yield* fs.makeDirectory(cwd, { recursive: true });
        const scope = yield* Scope.fork(hostScope);
        const session = yield* Effect.gen(function* () {
          const root = path.join(config.home, "machines", request.threadId);
          // The harnesses' sessions leave the machine as they are written (#132).
          const sessions = yield* makeRunnerSessions({
            cloudUrl,
            codexHome: machineLayout(path, root).codexHome,
            mask,
          }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(driveServices));
          // Every drive the user can read, for the harnesses (#141).
          const previewServices = yield* makePreviewServices({ cwd });
          const previewServicesPublisher = yield* Deferred.make<PreviewTunnel>();
          const persistPreviewServices = (services: ReadonlyArray<PreviewService>) =>
            Deferred.await(previewServicesPublisher).pipe(
              Effect.flatMap((tunnel) => tunnel.persistServices(services)),
            );
          const context = yield* startContextServer({
            mountPoint: config.drivesMountPoint ?? null,
            threadId: request.threadId,
            previewServices,
            persistPreviewServices,
            previewServicesReady: Deferred.await(previewServicesPublisher).pipe(
              Effect.flatMap((tunnel) => tunnel.ready),
            ),
            previewHosts: Effect.gen(function* () {
              if (!(yield* Deferred.isDone(previewServicesPublisher))) return null;
              const tunnel = yield* Deferred.await(previewServicesPublisher);
              return yield* tunnel.previewHosts;
            }),
          });
          // What the harness environment sets itself; known once the adapters are made.
          let harnessVariables: ReadonlySet<string> = new Set();
          const secrets = makeRunnerSecrets({
            onePassword: config.onePassword ?? onePasswordSdk,
            mask,
            reserved: () => harnessVariables,
          });
          const made = yield* makeRunnerAdapters({
            root,
            gatewayUrl: request.modelGatewayUrl,
            claudeQueryRunner: layerSessionQueryRunner(sessions.claude, (runner) =>
              withContextServer(runner, context.mcpServers),
            ),
            mcpServers: context.mcpServers,
            caches: caches.environment,
            sessionEnvironment: secrets.environment,
            mask: mask.text,
          });
          const { adapters, layout, stderr, environment, attachmentsDir } = made;
          harnessVariables = made.harnessVariables;
          const dependencies = yield* makeRunnerDependencies({ cwd, caches, environment });
          const preparing = yield* Semaphore.make(1);
          const openingDrive = yield* Semaphore.make(1);
          let filesPrepared = false;
          let openedDrive: { readonly driveId: string; readonly drive: RunnerDrive } | null = null;
          const openDrive = (access: DriveAccess) =>
            openingDrive.withPermits(1)(
              Effect.gen(function* () {
                if (openedDrive?.driveId === access.driveId) return openedDrive.drive;
                const drive = yield* Effect.flatMap(
                  makeDriveClient({ cloudUrl, access }),
                  (client) =>
                    makeRunnerDrive({
                      cwd,
                      client,
                      branch: threadRemoteBranch(request.threadId),
                      machine: { outside: outsideFolders(layout), trees: dependencies.trees },
                      secretMask: mask,
                    }),
                ).pipe(
                  Effect.provide(FetchHttpClient.layer),
                  Effect.provide(driveServices),
                  Scope.provide(scope),
                );
                const preparedDrive = {
                  ...drive,
                  prepare: (...args: Parameters<RunnerDrive["prepare"]>) =>
                    drive.prepare(...args).pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          filesPrepared = true;
                        }),
                      ),
                    ),
                };
                openedDrive = { driveId: access.driveId, drive: preparedDrive };
                yield* context.attachDrive(preparedDrive);
                return preparedDrive;
              }),
            );
          const prepareServices = (access: DriveAccess) =>
            preparing.withPermits(1)(
              Effect.gen(function* () {
                // A late tunnel must not re-prepare files an agent is already editing.
                if (filesPrepared) return;
                const drive = yield* openDrive(access);
                yield* drive.prepare(null, access.author, access.instructions).pipe(
                  Effect.mapError(
                    (cause) =>
                      new RunnerConnectionError({
                        message: "Could not restore the preview's files.",
                        cause,
                      }),
                  ),
                );
                if (request.machineClass !== "light") {
                  yield* dependencies.prepare(() => Effect.void);
                  yield* drive.restoreDependencyEdits.pipe(
                    Effect.mapError(
                      (cause) =>
                        new RunnerConnectionError({
                          message: "Could not restore the preview's dependency edits.",
                          cause,
                        }),
                    ),
                  );
                }
              }),
            );
          const attachments = yield* makeRunnerAttachments({ cloudUrl, attachmentsDir }).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.provide(driveServices),
          );
          const usage = yield* makeRunnerUsage(config.home);
          const registerSecrets = yield* makeSecretsRegistrar(cloudUrl).pipe(
            Effect.provide(FetchHttpClient.layer),
          );
          const session = yield* makeRunnerSession({
            threadId: request.threadId,
            generation: request.generation,
            token: request.token,
            machineId: config.machineId,
            imageVersion: config.imageVersion,
            build: config.build,
            transport: maskingTransport(
              webSocketTransport(runnerConnectUrl(cloudUrl, request.threadId)),
              mask,
            ),
            makeTurns: (emit) =>
              makeRunnerTurns({
                threadId: request.threadId,
                adapters,
                stderr,
                cwd,
                claudeConfigDir: layout.claudeHome,
                useModelToken: (token) =>
                  writeModelToken(layout, token).pipe(
                    Effect.provideService(FileSystem.FileSystem, fs),
                  ),
                usage: usage.sample,
                emit,
                dependencies,
                preparing,
                secrets,
                registerSecrets,
                openDrive,
                sessions,
                attachments,
                // Each generation's class, as the thread asked for it.
                machineClass: request.machineClass ?? "heavy",
                pinDrives: (access) =>
                  makeContextClient({ cloudUrl, access }).pipe(
                    Effect.provide(FetchHttpClient.layer),
                    Effect.flatMap((client) =>
                      context.pin(client).pipe(Effect.map(() => context.currentView())),
                    ),
                  ),
              }),
          });
          const previewTunnel = yield* runPreviewTunnel({
            threadId: request.threadId,
            generation: request.generation,
            token: request.token,
            transport: previewTunnelTransport(
              threadSocketUrl(cloudUrl, PREVIEW_TUNNEL_PATH, request.threadId),
            ),
            ports: previewPorts,
            services: previewServices,
            prepareServices,
            // Viewers watch the same browser the agent's `preview_*` tools drive.
            ...(context.mirror === null ? {} : { mirror: context.mirror }),
          });
          yield* Deferred.succeed(previewServicesPublisher, previewTunnel);
          return session;
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
  /** The address to listen on: loopback, unless the host runs in a container its backend dials. */
  readonly listen?: string;
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
      NodeHttpServer.layer(NodeHttp.createServer, {
        host: config.listen ?? "127.0.0.1",
        port: config.port,
      }),
    ),
    Layer.build,
  );
  yield* Effect.logInfo(
    `Runner host on http://${config.listen ?? "127.0.0.1"}:${config.port}, cloud ${config.cloudUrl}`,
  );
  return yield* Effect.never;
});
