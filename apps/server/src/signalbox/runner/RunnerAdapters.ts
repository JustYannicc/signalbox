import * as NodeServices from "@effect/platform-node/NodeServices";
import { type ProviderInstanceId, defaultInstanceIdForDriver } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
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
import { type ClaudeGatewaySettings, claudeGatewaySettings } from "./RunnerGatewayPins.ts";
import {
  claudeSettings,
  codexSettings,
  machineLayout,
  prepareMachine,
  runnerEnvironments,
  type RunnerMcpServers,
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
 * secrets change sees the new ones. Each Claude query also gets the gateway's
 * flag settings, and Codex its provider as launch arguments, over any config a
 * repository or the agent writes (`RunnerGatewayPins.ts`).
 */

type ClaudeQueryRunnerLayer = typeof layerClaudeQueryRunner;
type SessionEnvironment = () => Readonly<Record<string, string>>;

/**
 * Claude Code's CLI, spawned per query, with the session environment under the
 * machine's and the gateway's settings over the adapter's. The Runner never
 * gives the adapter a settings file path, so one is dropped rather than merged.
 */
export const claudeWithSessionEnvironment = (
  inner: ClaudeAgentSdkQueryRunnerShape,
  extra: SessionEnvironment,
  gateway: ClaudeGatewaySettings,
): ClaudeAgentSdkQueryRunnerShape => ({
  ...inner,
  open: (input) => {
    const settings = typeof input.options.settings === "object" ? input.options.settings : {};
    return inner.open({
      ...input,
      options: {
        ...input.options,
        env: { ...extra(), ...input.options.env },
        settings: { ...settings, ...gateway, env: { ...settings.env, ...gateway.env } },
      },
    });
  },
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
  gateway: ClaudeGatewaySettings,
): ClaudeQueryRunnerLayer =>
  Layer.effect(
    ClaudeAgentSdkQueryRunner,
    Effect.map(ClaudeAgentSdkQueryRunner, (inner) =>
      ClaudeAgentSdkQueryRunner.of(claudeWithSessionEnvironment(inner, extra, gateway)),
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
  gateway: ClaudeGatewaySettings,
) =>
  Layer.mergeAll(
    layerClaudeSessionEnvironment(claudeQueryRunner, sessionEnvironment, gateway),
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
  /** The drive checkout path the provider shells should use. */
  readonly cwd: string;
  readonly gatewayUrl: string;
  /** Claude's query runner; upstream's own by default. */
  readonly claudeQueryRunner?: ClaudeQueryRunnerLayer;
  /** The Runner's MCP servers, which Codex is configured with (Claude's query runner adds them). */
  readonly mcpServers?: RunnerMcpServers;
  /** The machine's cache variables (`RunnerCaches.ts`), for the harnesses and what they run. */
  readonly caches?: Readonly<Record<string, string>>;
  /** Variables each harness session gets as it opens, under the machine's own. */
  readonly sessionEnvironment?: SessionEnvironment;
  /** Hides the folder's secrets in what the harnesses write to stderr (`secretMask.ts`). */
  readonly mask?: (text: string) => string;
}) {
  const layout = machineLayout(yield* Path.Path, machine.root);
  const stderr = makeHarnessStderr(machine.mask);
  yield* prepareMachine(layout, machine.gatewayUrl, machine.mcpServers, machine.cwd);
  const { dependencyEnvironment, toolEnvironment: environment } = runnerEnvironments(
    yield* HostProcess.Environment,
    layout,
    machine.gatewayUrl,
    machine.caches,
    machine.cwd,
  );
  const services = yield* Layer.build(
    layerAdapterServices(
      machine.root,
      environment,
      machine.claudeQueryRunner ?? layerClaudeQueryRunner,
      stderr,
      machine.sessionEnvironment ?? (() => ({})),
      claudeGatewaySettings(layout, machine.gatewayUrl),
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
    config: codexSettings(CodexAdapterV2Driver.defaultConfig(), layout, machine.gatewayUrl),
  }).pipe(Effect.provide(services));
  return {
    layout,
    stderr,
    environment,
    dependencyEnvironment,
    /** Where the adapters read a turn's attachments from (`RunnerAttachments.ts`). */
    attachmentsDir: Context.get(services, ServerConfig.ServerConfig).attachmentsDir,
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
