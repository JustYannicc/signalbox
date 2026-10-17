import {
  type EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  type ModelSelection,
  type OrchestrationProjectShell,
  ORCHESTRATION_PROTOCOL_VERSION,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
  ProjectId,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerAuthDescriptor,
  type ServerConfig,
  type ServerProvider,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";

import webPackage from "../../web/package.json" with { type: "json" };
import { cloudProviderInstances, cloudProviders } from "./models/ModelCatalog.ts";
import { CLOUD_POOL_KINDS } from "./models/ModelRouting.ts";
import { scriptedModelSelection } from "./thread/scriptedProvider.ts";

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
 * Scratch, which clients show as "No project": the Personal context's project
 * until drives land (#140). Its root only has to match `scratchWorkspaceRoot`.
 * Work contexts have their own projects (see `user/contextProjects.ts`).
 */
export const SCRATCH_PROJECT_ID = ProjectId.make("scratch");
const SCRATCH_ROOT = "/scratch";
/** Scratch has no history of its own; it dates from the cloud's first threads. */
const SCRATCH_CREATED_AT = "2026-10-07T00:00:00.000Z";

/** No model of its own: new threads start on the environment's default (`serverConfig`). */
export const scratchProject: OrchestrationProjectShell = {
  id: SCRATCH_PROJECT_ID,
  title: "Scratch",
  workspaceRoot: SCRATCH_ROOT,
  defaultModelSelection: null,
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
  /** Whether the PreviewGateway serves threads' dev servers (`thread/preview/`). */
  readonly previews?: boolean;
  /** Whether clients may pick the scripted provider (`SCRIPTED_PROVIDER`; tests and dev only). */
  readonly scripted?: boolean;
  /** Whether threads take pasted screenshots and files (`attachments/`): the cloud has a bucket. */
  readonly attachments?: boolean;
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
    // Folders live in each user's object (`user/UserFolders.ts`); older clients read them as sections.
    sections: true,
    folders: true,
    // Notes on each level's pad, read by its assistant or agent (`notes/UserNotes.ts`).
    notes: true,
    // Standing sign-in grants, in each user's object (`signIn/SignInGrants.ts`).
    signInGrants: true,
    // Chats and tasks, and idle chats archiving themselves (`user/UserThreadKinds.ts`).
    threadKinds: true,
    // Threads' status notes, written by their agents or the runtime (`user/UserThreadStatus.ts`).
    threadStatusNotes: true,
    threadSettlement: true,
    threadPinning: true,
    threadPinReorder: true,
    threadAutoSettleOptOut: true,
    // The thread object picks start or queue itself, so clients skip reading the projection first.
    serverResolvedCommandContext: true,
    // Each account pool reports its accounts as a source (`pool/poolViews.ts`).
    usageLimitSources: true,
    // Pools only sign in Claude and ChatGPT accounts, for now: no API keys, imports or OpenCode.
    poolFeatures: CLOUD_POOL_KINDS,
    signalboxPreviews: identity.previews === true,
    threadBrowsing: true,
    // Uploaded to R2 and claimed into the thread on send (`attachments/CloudAttachments.ts`).
    ...(identity.attachments === true
      ? {
          attachmentUploads: true,
          fileAttachments: { maxUploadBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES },
        }
      : {}),
    // Importing a GitHub repository registers it at once (`github/GitHubImport.ts`).
    projectCloneTracking: true,
    // Threads link pull requests and keep their state synced (`thread/pullRequests/`), and this
    // environment serves PR reads through `github/CloudPullRequests.ts` (#814).
    pullRequests: true,
    pullRequestChecks: true,
    threadPullRequests: true,
    // Threads run on machines nobody operates, and the user never runs this server.
    terminal: false,
    worktrees: false,
    serverSettingsWrite: false,
    modelSettingsWrite: true,
    analyticsSettings: true,
    devices: false,
    scheduledTasks: false,
    localFilesystem: false,
    // Only GitHub repositories import (`github/GitHubImport.ts`).
    cloneFromUrl: false,
    sourceControlImports: [SourceControlProviderKind.make("github")],
    remoteAccess: false,
    // Pairing links and client sessions are not served (`http/environmentApi.ts`).
    accessManagement: false,
    // Automations run on each user's object (`automations/`); their Executor connection doesn't yet.
    connectedServices: false,
    // The cloud is the user's one environment; desktop and mobile are gateways to it.
    otherEnvironments: false,
  },
});

/** The user's pools as provider instances (see `pool/poolViews.ts`). */
export interface PoolProviders {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly instances: Record<ProviderInstanceId, ProviderInstanceConfig>;
  /** What new threads start on: a model a pool serves, or null when none can run. */
  readonly defaultModelSelection: ModelSelection | null;
}

const NO_POOL_PROVIDERS: PoolProviders = {
  providers: [],
  instances: {},
  defaultModelSelection: null,
};

/** `checkedAt`: when the connection asked; the cloud's providers are always ready. */
export const serverConfig = (
  identity: CloudEnvironmentIdentity,
  checkedAt: string,
  pools: PoolProviders = NO_POOL_PROVIDERS,
): ServerConfig => {
  const scripted = identity.scripted === true;
  return {
    environment: descriptor(identity),
    auth: authDescriptor,
    cwd: CLOUD_ROOT,
    keybindingsConfigPath: CLOUD_ROOT,
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    issues: [],
    providers: [...cloudProviders(checkedAt, { scripted }), ...pools.providers],
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
      // Never Scripted where clients can't pick it: without a pool model, clients say to add an account.
      defaultModelSelection:
        pools.defaultModelSelection ?? (scripted ? scriptedModelSelection : null),
      // Clients enable a provider instance only when settings list it.
      providerInstances: {
        ...cloudProviderInstances({ scripted }),
        ...pools.instances,
      },
    },
    shellResumeCompletionMarker: true,
    threadResumeCompletionMarker: true,
    scratchWorkspaceRoot: SCRATCH_ROOT,
  };
};

/** Nothing to bootstrap: a cloud user starts with an empty sidebar. */
export const welcome = (identity: CloudEnvironmentIdentity) => ({
  environment: descriptor(identity),
  cwd: CLOUD_ROOT,
  projectName: identity.label,
  bootstrapStatus: "complete" as const,
});

/** A user's sidebar: their projects and the threads in their index, at `sequence`. */
export const shellSnapshot = (input: {
  readonly sequence: number;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
}): OrchestrationV2ShellSnapshot => ({
  schemaVersion: SHELL_SCHEMA_VERSION,
  snapshotSequence: input.sequence,
  projects: input.projects,
  threads: input.threads.filter((thread) => thread.archivedAt === null),
  archivedThreads: input.threads.filter((thread) => thread.archivedAt !== null),
});
