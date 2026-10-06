import {
  type EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  ORCHESTRATION_PROTOCOL_VERSION,
  type OrchestrationV2ShellSnapshot,
  type ServerAuthDescriptor,
  type ServerConfig,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";

import webPackage from "../../web/package.json" with { type: "json" };

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
  capabilities: { repositoryIdentity: false, connectionProbe: true, signalboxCloud: true },
});

export const serverConfig = (identity: CloudEnvironmentIdentity): ServerConfig => ({
  environment: descriptor(identity),
  auth: authDescriptor,
  cwd: CLOUD_ROOT,
  keybindingsConfigPath: CLOUD_ROOT,
  keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
  issues: [],
  providers: [],
  availableEditors: [],
  observability: {
    logsDirectoryPath: CLOUD_ROOT,
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
    otlpLogsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
  shellResumeCompletionMarker: true,
});

/** Nothing to bootstrap: a cloud user starts with an empty sidebar. */
export const welcome = (identity: CloudEnvironmentIdentity) => ({
  environment: descriptor(identity),
  cwd: CLOUD_ROOT,
  projectName: identity.label,
  bootstrapStatus: "complete" as const,
});

/** A user's shell before the cloud holds any threads. */
export const emptyShellSnapshot: OrchestrationV2ShellSnapshot = {
  schemaVersion: SHELL_SCHEMA_VERSION,
  snapshotSequence: 0,
  projects: [],
  threads: [],
  archivedThreads: [],
};
