import * as NodeServices from "@effect/platform-node/NodeServices";
import { type ProviderInstanceId, defaultInstanceIdForDriver } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import {
  ClaudeAdapterV2Driver,
  ClaudeAgentSdkQueryRunner,
  type ClaudeAgentSdkQueryRunnerShape,
  layerQueryRunner as layerClaudeQueryRunner,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  CodexAdapterV2Driver,
  CodexAppServerClientFactory,
  type CodexAppServerClientFactoryShape,
  layerAppServerClientFactory as layerCodexClientFactory,
} from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { ProviderAdapterV2 } from "@t3tools/provider-core/server/ProviderAdapter";
import { type HarnessStderr, makeHarnessStderr } from "./harnessStderr.ts";
import {
  claudeSettings,
  codexSettings,
  harnessEnvironment,
  machineLayout,
  prepareMachine,
} from "./RunnerModelAccess.ts";

/**
 * The provider adapters a Runner drives, built by upstream's own adapter
 * drivers (`ClaudeAdapterV2Driver`, `CodexAdapterV2Driver`): the stock CLIs on
 * PATH, configured to reach their models through the ModelGateway rather than
 * any login or key on this machine (see `RunnerModelAccess.ts`). Only the
 * services those constructors ask for are provided, not the server's layer
 * graph, so the Runner carries no settings store, MCP server or session
 * database, and an upstream change to an adapter reaches the Runner through a
 * normal merge. The Claude query runner can be swapped, which is how its
 * session reaches the thread (`RunnerClaudeSessions.ts`).
 *
 * Each harness session also gets `sessionEnvironment` as it opens, under the
 * machine's own environment: the folder's secrets (`RunnerSecrets.ts`). Both
 * harness CLIs live as long as their session, so a session started after the
 * secrets change sees the new ones.
 */

type ClaudeQueryRunnerLayer = typeof layerClaudeQueryRunner;
type SessionEnvironment = () => Readonly<Record<string, string>>;

/** Claude Code's CLI, spawned per query, with the session environment under the machine's. */
export const claudeWithSessionEnvironment = (
  inner: ClaudeAgentSdkQueryRunnerShape,
  extra: SessionEnvironment,
): ClaudeAgentSdkQueryRunnerShape => ({
  ...inner,
  open: (input) =>
    inner.open({
      ...input,
      options: { ...input.options, env: { ...extra(), ...input.options.env } },
    }),
});

/** Codex's app-server, spawned per session, the same way. */
export const codexWithSessionEnvironment = (
  inner: CodexAppServerClientFactoryShape,
  extra: SessionEnvironment,
): CodexAppServerClientFactoryShape => ({
  open: (input) => inner.open({ ...input, environment: { ...extra(), ...input.environment } }),
});

const layerClaudeSessionEnvironment = (
  queryRunner: ClaudeQueryRunnerLayer,
  extra: SessionEnvironment,
): ClaudeQueryRunnerLayer =>
  Layer.effect(
    ClaudeAgentSdkQueryRunner,
    Effect.map(ClaudeAgentSdkQueryRunner, (inner) =>
      ClaudeAgentSdkQueryRunner.of(claudeWithSessionEnvironment(inner, extra)),
    ),
  ).pipe(Layer.provide(queryRunner));

const layerCodexSessionEnvironment = (extra: SessionEnvironment) =>
  Layer.effect(
    CodexAppServerClientFactory,
    Effect.map(CodexAppServerClientFactory, (inner) =>
      CodexAppServerClientFactory.of(codexWithSessionEnvironment(inner, extra)),
    ),
  ).pipe(Layer.provide(layerCodexClientFactory));

/**
 * What the adapter constructors need. The server config only supplies paths
 * under `home`; the adapters read nothing else from it. `environment` is all
 * of the host's environment the harnesses see.
 */
const layerAdapterServices = (
  home: string,
  environment: NodeJS.ProcessEnv,
  claudeQueryRunner: ClaudeQueryRunnerLayer,
  stderr: HarnessStderr,
  sessionEnvironment: SessionEnvironment,
) =>
  Layer.mergeAll(
    layerClaudeSessionEnvironment(claudeQueryRunner, sessionEnvironment),
    layerCodexSessionEnvironment(sessionEnvironment),
    IdAllocator.layer,
    ServerConfig.layerTest(home, home),
    Layer.succeed(HostProcess.Environment, environment),
  ).pipe(
    Layer.provideMerge(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
    // The harnesses' stderr is kept for the turn's diagnostic record.
    Layer.provideMerge(stderr.layerSpawner),
    Layer.provideMerge(NodeServices.layer),
  );

/**
 * One machine's adapters, each under the instance id a self-hosted server
 * gives it by default, with its state under `root`, and the environment
 * their harnesses run in. The adapters and their sessions live as long as
 * the scope.
 */
export const makeRunnerAdapters = Effect.fn("makeRunnerAdapters")(function* (machine: {
  readonly root: string;
  readonly gatewayUrl: string;
  /** Claude's query runner; upstream's own by default. */
  readonly claudeQueryRunner?: ClaudeQueryRunnerLayer;
  /** The Runner's context server, which Codex is configured with (Claude's query runner adds it). */
  readonly contextMcpUrl?: string;
  /** The machine's cache variables (`RunnerCaches.ts`), for the harnesses and what they run. */
  readonly caches?: Readonly<Record<string, string>>;
  /** Variables each harness session gets as it opens, under the machine's own. */
  readonly sessionEnvironment?: SessionEnvironment;
}) {
  const layout = machineLayout(yield* Path.Path, machine.root);
  const stderr = makeHarnessStderr();
  yield* prepareMachine(layout, machine.gatewayUrl, machine.contextMcpUrl ?? null);
  const environment = harnessEnvironment(
    yield* HostProcess.Environment,
    layout,
    machine.gatewayUrl,
    machine.caches,
  );
  const services = yield* Layer.build(
    layerAdapterServices(
      machine.root,
      environment,
      machine.claudeQueryRunner ?? layerClaudeQueryRunner,
      stderr,
      machine.sessionEnvironment ?? (() => ({})),
    ),
  );
  const common = { displayName: undefined, environment: [], enabled: true } as const;
  const claude = yield* ClaudeAdapterV2Driver.create({
    ...common,
    instanceId: defaultInstanceIdForDriver(ClaudeAdapterV2Driver.driverKind),
    config: claudeSettings(ClaudeAdapterV2Driver.defaultConfig(), layout),
  }).pipe(Effect.provide(services));
  const codex = yield* CodexAdapterV2Driver.create({
    ...common,
    instanceId: defaultInstanceIdForDriver(CodexAdapterV2Driver.driverKind),
    config: codexSettings(CodexAdapterV2Driver.defaultConfig(), layout),
  }).pipe(Effect.provide(services));
  return {
    layout,
    stderr,
    environment,
    /** What the harnesses' environment sets, each adapter's own config home included. */
    harnessVariables: new Set([
      ...Object.keys(environment),
      "CLAUDE_CONFIG_DIR",
      "CODEX_HOME",
    ]) as ReadonlySet<string>,
    adapters: new Map<ProviderInstanceId, ProviderAdapterV2["Service"]>([
      [claude.instanceId, claude],
      [codex.instanceId, codex],
    ]) as ReadonlyMap<ProviderInstanceId, ProviderAdapterV2["Service"]>,
  };
});
