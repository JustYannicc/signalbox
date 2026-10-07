import {
  type EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  type OrchestrationProjectShell,
  ORCHESTRATION_PROTOCOL_VERSION,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
  ProjectId,
  type ServerAuthDescriptor,
  type ServerConfig,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";

import webPackage from "../../web/package.json" with { type: "json" };
import {
  SCRIPTED_DRIVER,
  SCRIPTED_INSTANCE_ID,
  scriptedModelSelection,
  scriptedServerProvider,
} from "./thread/scriptedProvider.ts";

/**
 * How the cloud describes itself to clients. It is an environment like any
 * other, so these are the same contract shapes a self-hosted server sends,
 * filled in for a machine that has no filesystem of its own yet. Capabilities
 * advertise only what the cloud implements; clients switch features on from
 * them.
 */

/** The cloud ships the web build it serves, so it reports that build's version. */
const CLOUD_VERSION = webPackage.version;

/** Projection layout version, matching the self-hosted server's shell. */
const SHELL_SCHEMA_VERSION = 2;

/** Placeholder for the path-shaped config fields; the cloud has no host paths. */
const CLOUD_ROOT = "/";

/**
 * Every user's one project until drives land (#140): Scratch, which clients
 * show as "No project". Its root only has to match `scratchWorkspaceRoot`.
 */
export const SCRATCH_PROJECT_ID = ProjectId.make("scratch");
const SCRATCH_ROOT = "/scratch";
/** Scratch has no history of its own; it dates from the cloud's first threads. */
const SCRATCH_CREATED_AT = "2026-10-07T00:00:00.000Z";

const scratchProject: OrchestrationProjectShell = {
  id: SCRATCH_PROJECT_ID,
  title: "Scratch",
  workspaceRoot: SCRATCH_ROOT,
  defaultModelSelection: scriptedModelSelection,
  scripts: [],
  createdAt: SCRATCH_CREATED_AT,
  updatedAt: SCRATCH_CREATED_AT,
};

export const DEFAULT_ENVIRONMENT_LABEL = "Signalbox Cloud";

/** The browser session cookie, advertised in the auth descriptor. */
export const SESSION_COOKIE_NAME = "signalbox_cloud_session";

export interface CloudEnvironmentIdentity {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export const authDescriptor: ServerAuthDescriptor = {
  policy: "remote-reachable",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["browser-session-cookie", "bearer-access-token"],
  sessionCookieName: SESSION_COOKIE_NAME,
};

export const descriptor = (identity: CloudEnvironmentIdentity): ExecutionEnvironmentDescriptor => ({
  environmentId: identity.environmentId,
  label: identity.label,
  platform: { os: "linux", arch: "other", machine: "cloud" },
  serverVersion: CLOUD_VERSION,
  orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
  capabilities: {
    repositoryIdentity: false,
    connectionProbe: true,
    signalboxCloud: true,
    // The thread object picks start or queue itself, so clients skip reading the projection first.
    serverResolvedCommandContext: true,
  },
});

/** `checkedAt`: when the connection asked; the scripted provider is always ready. */
export const serverConfig = (
  identity: CloudEnvironmentIdentity,
  checkedAt: string,
): ServerConfig => ({
  environment: descriptor(identity),
  auth: authDescriptor,
  cwd: CLOUD_ROOT,
  keybindingsConfigPath: CLOUD_ROOT,
  keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
  issues: [],
  providers: [scriptedServerProvider(checkedAt)],
  availableEditors: [],
  observability: {
    logsDirectoryPath: CLOUD_ROOT,
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
    otlpLogsEnabled: false,
  },
  settings: {
    ...DEFAULT_SERVER_SETTINGS,
    // Clients enable a provider instance only when settings list it.
    providerInstances: { [SCRIPTED_INSTANCE_ID]: { driver: SCRIPTED_DRIVER, enabled: true } },
  },
  shellResumeCompletionMarker: true,
  threadResumeCompletionMarker: true,
  scratchWorkspaceRoot: SCRATCH_ROOT,
});

/** Nothing to bootstrap: a cloud user starts with an empty sidebar. */
export const welcome = (identity: CloudEnvironmentIdentity) => ({
  environment: descriptor(identity),
  cwd: CLOUD_ROOT,
  projectName: identity.label,
  bootstrapStatus: "complete" as const,
});

/** A user's sidebar: their project and the threads in their index, at `sequence`. */
export const shellSnapshot = (input: {
  readonly sequence: number;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
}): OrchestrationV2ShellSnapshot => ({
  schemaVersion: SHELL_SCHEMA_VERSION,
  snapshotSequence: input.sequence,
  projects: [scratchProject],
  threads: input.threads.filter((thread) => thread.archivedAt === null),
  archivedThreads: input.threads.filter((thread) => thread.archivedAt !== null),
});
