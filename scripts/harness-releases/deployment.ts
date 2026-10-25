import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { object, sha256 } from "./fixture.ts";
import { isNodeErrorCode, text } from "./guards.ts";
import { assertSourcesUnchanged, freezeSources, readSourceFreeze } from "./sourceFreeze.ts";
import { PendingReleaseProof, writeOnce } from "./runner.ts";

const probeModules = [
  "worker.js",
  "runtime.js",
  "suspend.wasm",
  "esm.js",
  "facetSource.js",
  "wasmFixture.js",
  "moduleTransport.js",
  "moduleUpload.js",
  "codeGeneration.js",
  "childWorkerDispatch.js",
]
  .sort()
  .map((name) => ({ name, type: name.endsWith(".wasm") ? "wasm" : "js" })) as {
  name: string;
  type: "wasm" | "js";
}[];
const ownedScript = (script: string) => /^sb-isolate-probe-[a-f0-9]{24}$/u.test(script);

export interface ReleaseDeploymentCredentials {
  readonly enabled: boolean;
  readonly accountId?: string;
  readonly token?: string;
}

interface OwnedWorker {
  readonly script: string;
  namespace?: string;
  version?: string;
}

export interface ReleaseCloudflare {
  deploy(
    worker: OwnedWorker,
    root: string,
    modules: ReadonlyArray<{ readonly name: string; readonly type: "wasm" | "js" }>,
    secret: string,
  ): Promise<string>;
  request(path: string): Promise<unknown>;
}

type CloudflareCliRequest =
  | {
      readonly action: "deploy";
      readonly script: string;
      readonly root: string;
      readonly modules: ReadonlyArray<{ readonly name: string; readonly type: "js" | "wasm" }>;
      readonly secret: string;
    }
  | {
      readonly action: "request";
      readonly script: string;
      readonly resource: "settings" | "deployments";
    }
  | { readonly action: "cleanup"; readonly script: string };

function deploymentCredentials(credentials: ReleaseDeploymentCredentials) {
  if (!credentials.enabled)
    throw new PendingReleaseProof("Disposable deployment requires the harness release CI job.");
  const account = credentials.accountId;
  const token = credentials.token;
  if (!account || !token) throw new PendingReleaseProof("CI Cloudflare credentials are missing.");
  return { account, token };
}

function runCloudflareCli(
  repository: string,
  credentials: ReleaseDeploymentCredentials,
  input: CloudflareCliRequest,
): Promise<unknown> {
  const { account, token } = deploymentCredentials(credentials);
  const environment = { ...process.env };
  delete environment.CLOUDFLARE_ACCOUNT_ID;
  delete environment.CLOUDFLARE_API_TOKEN;
  delete environment.HARNESS_RELEASE_DEPLOY;
  environment.CLOUDFLARE_ACCOUNT_ID = account;
  environment.CLOUDFLARE_API_TOKEN = token;
  const script = NodePath.join(
    repository,
    "apps/cloud/infra/harnessReleases/harnessReleaseCloudflare.ts",
  );
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(process.execPath, ["--experimental-strip-types", script], {
      cwd: repository,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `RELEASE_CLOUDFLARE_CLI_FAILED: ${Buffer.concat(stderr).toString("utf8").trim() || code}`,
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")));
      } catch (error) {
        reject(new Error("RELEASE_CLOUDFLARE_CLI_OUTPUT_INVALID", { cause: error }));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

/** Remove deployment secrets from the runner environment before any release stage starts. */
export function takeReleaseDeploymentCredentials(
  environment: NodeJS.ProcessEnv = process.env,
): ReleaseDeploymentCredentials {
  const credentials: ReleaseDeploymentCredentials = {
    enabled: environment.GITHUB_ACTIONS === "true" && environment.HARNESS_RELEASE_DEPLOY === "1",
    ...(environment.CLOUDFLARE_ACCOUNT_ID ? { accountId: environment.CLOUDFLARE_ACCOUNT_ID } : {}),
    ...(environment.CLOUDFLARE_API_TOKEN ? { token: environment.CLOUDFLARE_API_TOKEN } : {}),
  };
  delete environment.CLOUDFLARE_ACCOUNT_ID;
  delete environment.CLOUDFLARE_API_TOKEN;
  delete environment.HARNESS_RELEASE_DEPLOY;
  return credentials;
}

function cloudConfig(
  repository: string,
  credentials: ReleaseDeploymentCredentials,
): ReleaseCloudflare {
  deploymentCredentials(credentials);
  return {
    async deploy(worker, root, modules, secret) {
      const result = object(
        await runCloudflareCli(repository, credentials, {
          action: "deploy",
          script: worker.script,
          root,
          modules,
          secret,
        }),
      );
      worker.namespace = text(result.namespace, "RELEASE_DEPLOYMENT_NAMESPACE_MISSING");
      worker.version = text(result.version, "RELEASE_DEPLOYMENT_VERSION_MISSING");
      return text(result.url, "RELEASE_DEPLOYMENT_URL_MISSING");
    },
    request(path) {
      const match =
        /^\/workers\/scripts\/(sb-isolate-probe-[a-f0-9]{24})\/(settings|deployments)$/u.exec(path);
      if (!match) throw new Error("RELEASE_CLOUDFLARE_RESOURCE_INVALID");
      return runCloudflareCli(repository, credentials, {
        action: "request",
        script: match[1]!,
        resource: match[2] as "settings" | "deployments",
      });
    },
  };
}

export interface PreparedProbeHost {
  readonly root: string;
  readonly modules: ReadonlyArray<{ readonly name: string; readonly type: "wasm" | "js" }>;
}

export interface DeploymentIdentity {
  readonly schemaVersion: 1;
  readonly script: string;
  readonly namespace: string;
  readonly version: string;
  readonly compatibility: { readonly date: string; readonly flags: ReadonlyArray<string> };
  readonly hostInventory: {
    readonly file: "probe-host-inventory.json";
    readonly moduleCount: number;
    readonly sha256: string;
  };
}

export interface DeploymentVersionCapture {
  readonly schemaVersion: 1;
  readonly stage: "before-measure" | "after-measure";
  readonly status: "passed" | "failed";
  readonly script: string;
  readonly expectedVersion: string;
  readonly activeVersions: ReadonlyArray<{ readonly version: string; readonly percentage: number }>;
  readonly error?: string;
}

export interface DeployedProbeHost {
  readonly url: string;
  readonly cloud: ReleaseCloudflare;
  readonly identity: DeploymentIdentity;
}

async function verifiedHostInventory(
  output: string,
  prepared: PreparedProbeHost,
): Promise<{ readonly sha256: string; readonly moduleCount: number }> {
  const inventoryBytes = await NodeFSP.readFile(NodePath.join(output, "probe-host-inventory.json"));
  const inventory = JSON.parse(inventoryBytes.toString("utf8"));
  if (!Array.isArray(inventory) || inventory.length !== prepared.modules.length)
    throw new Error("RELEASE_PROBE_HOST_INVENTORY_INVALID");
  const entries = new Map<string, ReturnType<typeof object>>();
  for (const value of inventory) {
    const item = object(value);
    if (
      typeof item.name !== "string" ||
      (item.type !== "js" && item.type !== "wasm") ||
      !Number.isSafeInteger(item.bytes) ||
      (item.bytes as number) < 0 ||
      typeof item.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(item.sha256) ||
      entries.has(item.name)
    )
      throw new Error("RELEASE_PROBE_HOST_INVENTORY_INVALID");
    entries.set(item.name, item);
  }
  for (const module of prepared.modules) {
    const entry = entries.get(module.name);
    if (!entry || entry.type !== module.type)
      throw new Error("RELEASE_PROBE_HOST_INVENTORY_MISMATCH");
    const bytes = await NodeFSP.readFile(
      NodePath.join(prepared.root, "host/generated", module.name),
    );
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256)
      throw new Error("RELEASE_PROBE_HOST_INVENTORY_MISMATCH");
  }
  return { sha256: sha256(inventoryBytes), moduleCount: inventory.length };
}

/** Builds deployment inputs from the generated host in its own recorded runner stage. */
export async function prepareReleaseProbeHost(
  repository: string,
  output: string,
): Promise<PreparedProbeHost> {
  const generated = NodePath.join(repository, "apps/cloud/infra/isolateProbe/generated");
  const root = NodePath.join(output, "probe-host");
  await NodeFSP.mkdir(NodePath.join(root, "host/generated"), { recursive: true });
  const inventory = [];
  for (const module of probeModules) {
    const bytes = await NodeFSP.readFile(NodePath.join(generated, module.name));
    await NodeFSP.writeFile(NodePath.join(root, "host/generated", module.name), bytes, {
      flag: "wx",
      mode: 0o444,
    });
    inventory.push({ ...module, bytes: bytes.length, sha256: sha256(bytes) });
  }
  await writeOnce(NodePath.join(output, "probe-host-inventory.json"), inventory);
  return { root, modules: probeModules };
}

/** Records ownership before upload so partial deployments remain recoverable. */
export async function deployReleaseProbeHost(
  repository: string,
  output: string,
  prepared: PreparedProbeHost,
  secret: string,
  credentials: ReleaseDeploymentCredentials,
  cloud: ReleaseCloudflare = cloudConfig(repository, credentials),
): Promise<DeployedProbeHost> {
  const worker: OwnedWorker = {
    script: `sb-isolate-probe-${NodeCrypto.randomBytes(12).toString("hex")}`,
  };
  await writeOnce(NodePath.join(output, "owned-worker.json"), worker);
  const inventoryBefore = await verifiedHostInventory(output, prepared);
  const url = await cloud.deploy(worker, prepared.root, [...prepared.modules], secret);
  const inventoryAfter = await verifiedHostInventory(output, prepared);
  if (inventoryAfter.sha256 !== inventoryBefore.sha256)
    throw new Error("RELEASE_PROBE_HOST_INVENTORY_CHANGED");
  const settings = object(await cloud.request(`/workers/scripts/${worker.script}/settings`));
  const flags = settings.compatibility_flags;
  if (
    !worker.namespace ||
    !worker.version ||
    typeof settings.compatibility_date !== "string" ||
    !Array.isArray(flags) ||
    !flags.every((flag) => typeof flag === "string")
  )
    throw new Error("RELEASE_DEPLOYMENT_IDENTITY_MISSING");
  const bindings = settings.bindings;
  if (!Array.isArray(bindings)) throw new Error("RELEASE_DEPLOYMENT_IDENTITY_MISSING");
  const probe = bindings.map(object).find((binding) => binding.name === "PROBE");
  if (probe?.namespace_id !== worker.namespace)
    throw new Error("RELEASE_DEPLOYMENT_NAMESPACE_CHANGED");
  const identity: DeploymentIdentity = {
    schemaVersion: 1,
    script: worker.script,
    namespace: worker.namespace,
    version: worker.version,
    compatibility: { date: settings.compatibility_date, flags },
    hostInventory: {
      file: "probe-host-inventory.json",
      moduleCount: inventoryAfter.moduleCount,
      sha256: inventoryAfter.sha256,
    },
  };
  await writeOnce(NodePath.join(output, "deployment-identity.json"), identity);
  return { url, cloud, identity };
}

function parseDeploymentIdentity(value: unknown): DeploymentIdentity {
  const identity = object(value);
  const compatibility = object(identity.compatibility);
  const inventory = object(identity.hostInventory);
  if (
    Object.keys(identity).sort().join(",") !==
      ["compatibility", "hostInventory", "namespace", "schemaVersion", "script", "version"]
        .sort()
        .join(",") ||
    Object.keys(compatibility).sort().join(",") !== "date,flags" ||
    Object.keys(inventory).sort().join(",") !== "file,moduleCount,sha256" ||
    identity.schemaVersion !== 1 ||
    typeof identity.script !== "string" ||
    !ownedScript(identity.script) ||
    typeof identity.namespace !== "string" ||
    !identity.namespace ||
    typeof identity.version !== "string" ||
    !identity.version ||
    typeof compatibility.date !== "string" ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(compatibility.date) ||
    !Array.isArray(compatibility.flags) ||
    !compatibility.flags.every((flag) => typeof flag === "string") ||
    inventory.file !== "probe-host-inventory.json" ||
    !Number.isSafeInteger(inventory.moduleCount) ||
    (inventory.moduleCount as number) <= 0 ||
    typeof inventory.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(inventory.sha256)
  )
    throw new Error("RELEASE_DEPLOYMENT_IDENTITY_INVALID");
  return {
    schemaVersion: 1,
    script: identity.script,
    namespace: identity.namespace,
    version: identity.version,
    compatibility: {
      date: compatibility.date,
      flags: compatibility.flags,
    },
    hostInventory: {
      file: "probe-host-inventory.json",
      moduleCount: inventory.moduleCount as number,
      sha256: inventory.sha256,
    },
  };
}

async function readDeploymentIdentity(output: string): Promise<DeploymentIdentity> {
  try {
    return parseDeploymentIdentity(
      JSON.parse(await NodeFSP.readFile(NodePath.join(output, "deployment-identity.json"), "utf8")),
    );
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT"))
      throw new Error("RELEASE_DEPLOYMENT_IDENTITY_MISSING", { cause: error });
    throw error;
  }
}

function activeVersions(value: unknown) {
  const result = object(value);
  if (!Array.isArray(result.deployments)) throw new Error("RELEASE_ACTIVE_VERSIONS_INVALID");
  const versions = result.deployments.flatMap((deployment) => {
    const rows = object(deployment).versions;
    if (!Array.isArray(rows)) throw new Error("RELEASE_ACTIVE_VERSIONS_INVALID");
    return rows.map((raw) => {
      const version = object(raw);
      if (
        typeof version.version_id !== "string" ||
        typeof version.percentage !== "number" ||
        !Number.isFinite(version.percentage)
      )
        throw new Error("RELEASE_ACTIVE_VERSIONS_INVALID");
      return { version: version.version_id, percentage: version.percentage };
    });
  });
  return versions;
}

async function captureActiveVersion(
  output: string,
  cloud: ReleaseCloudflare,
  identity: DeploymentIdentity,
  stage: DeploymentVersionCapture["stage"],
): Promise<DeploymentVersionCapture> {
  let capture: DeploymentVersionCapture;
  try {
    const versions = activeVersions(
      await cloud.request(`/workers/scripts/${identity.script}/deployments`),
    );
    const passed =
      versions.length === 1 &&
      versions[0]?.version === identity.version &&
      versions[0]?.percentage === 100;
    capture = {
      schemaVersion: 1,
      stage,
      status: passed ? "passed" : "failed",
      script: identity.script,
      expectedVersion: identity.version,
      activeVersions: versions,
      ...(!passed ? { error: "RELEASE_DEPLOYMENT_VERSION_CHANGED" } : {}),
    };
  } catch (error) {
    capture = {
      schemaVersion: 1,
      stage,
      status: "failed",
      script: identity.script,
      expectedVersion: identity.version,
      activeVersions: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const name =
    stage === "before-measure" ? "deployed-active-before.json" : "deployed-active-after.json";
  await writeOnce(NodePath.join(output, name), capture);
  if (capture.status !== "passed") throw new Error(capture.error);
  return capture;
}

/** Capture a fresh active-version read on both sides of the deployed measurement. */
export async function measureWithDeploymentIdentity<T>(
  output: string,
  cloud: ReleaseCloudflare,
  expectedIdentity: DeploymentIdentity,
  measure: () => Promise<T>,
): Promise<T> {
  const identity = await readDeploymentIdentity(output);
  if (JSON.stringify(identity) !== JSON.stringify(expectedIdentity))
    throw new Error("RELEASE_DEPLOYMENT_IDENTITY_CHANGED");
  await captureActiveVersion(output, cloud, identity, "before-measure");
  let value: T | undefined;
  let measurementError: unknown;
  try {
    value = await measure();
  } catch (error) {
    measurementError = error;
  }
  let identityError: unknown;
  try {
    await captureActiveVersion(output, cloud, identity, "after-measure");
  } catch (error) {
    identityError = error;
  }
  if (measurementError && identityError)
    throw new Error(
      `RELEASE_DEPLOYED_MEASUREMENT_AND_IDENTITY_FAILED: ${String(measurementError)}; ${String(identityError)}`,
      { cause: new AggregateError([measurementError, identityError]) },
    );
  if (identityError) throw identityError;
  if (measurementError) throw measurementError;
  return value as T;
}

export type CleanupDisposition = "deleted" | "not-needed";

export async function cleanupReleaseDeployment(
  repository: string,
  output: string,
  credentials: ReleaseDeploymentCredentials,
): Promise<CleanupDisposition> {
  const ledger = NodePath.join(output, "owned-worker.json");
  const bytes = await NodeFSP.readFile(ledger, "utf8").catch((error: unknown) => {
    if (isNodeErrorCode(error, "ENOENT")) return undefined;
    throw error;
  });
  if (bytes === undefined) return "not-needed";
  const state = object(JSON.parse(bytes));
  if (typeof state.script !== "string" || !/^sb-isolate-probe-[a-f0-9]{24}$/u.test(state.script))
    throw new Error("RELEASE_DEPLOYMENT_OWNERSHIP_INVALID");
  await runCloudflareCli(repository, credentials, { action: "cleanup", script: state.script });
  return "deleted";
}

type SourceCheck =
  | { readonly status: "passed"; readonly commit: string; readonly sha256: string }
  | { readonly status: "failed"; readonly error: string };

export interface CleanupRecoveryEvidence {
  readonly schemaVersion: 1;
  readonly status: "passed" | "failed";
  readonly sourceBefore: SourceCheck;
  readonly cleanup:
    | { readonly status: "deleted" | "not-needed" }
    | { readonly status: "failed"; readonly error: string };
  readonly sourceAfter: SourceCheck;
}

async function verifyPersistedSource(repository: string, output: string): Promise<SourceCheck> {
  try {
    const persisted = readSourceFreeze(
      JSON.parse(await NodeFSP.readFile(NodePath.join(output, "source-freeze.json"), "utf8")),
    );
    const current = await freezeSources(repository);
    assertSourcesUnchanged(persisted, current);
    return { status: "passed", commit: current.commit, sha256: current.sha256 };
  } catch (error) {
    return {
      status: "failed",
      error: isNodeErrorCode(error, "ENOENT")
        ? "RELEASE_SOURCE_FREEZE_MISSING"
        : error instanceof Error
          ? error.message
          : String(error),
    };
  }
}

/** Verify both sides of recovery while always attempting cleanup between them. */
export async function recoverReleaseCleanup(
  repository: string,
  output: string,
  cleanup: (output: string) => Promise<CleanupDisposition> = (directory) =>
    cleanupReleaseDeployment(repository, directory, { enabled: false }),
): Promise<CleanupRecoveryEvidence> {
  const directory = NodePath.resolve(output);
  await NodeFSP.mkdir(directory, { recursive: true }).catch(() => undefined);
  const sourceBefore = await verifyPersistedSource(repository, directory);
  let cleanupResult: CleanupRecoveryEvidence["cleanup"];
  try {
    cleanupResult = { status: await cleanup(directory) };
  } catch (error) {
    cleanupResult = {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const sourceAfter = await verifyPersistedSource(repository, directory);
  const evidence: CleanupRecoveryEvidence = {
    schemaVersion: 1,
    status:
      sourceBefore.status === "passed" &&
      sourceAfter.status === "passed" &&
      cleanupResult.status !== "failed"
        ? "passed"
        : "failed",
    sourceBefore,
    cleanup: cleanupResult,
    sourceAfter,
  };
  try {
    await writeOnce(
      NodePath.join(directory, `cleanup-recovery-${NodeCrypto.randomUUID()}.json`),
      evidence,
    );
  } catch {
    return { ...evidence, status: "failed" };
  }
  return evidence;
}
