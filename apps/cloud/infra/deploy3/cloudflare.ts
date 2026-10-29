import { effectiveDeploy3Deadline, parseDeploy3Name } from "./deadline.ts";
import {
  deploy3ExternalBindings,
  deploy3NamespaceBindingIds,
  getDeploy3WorkerSettings,
  listDeploy3Namespaces,
  listDeploy3Tails,
  listDeploy3WorkerInventory as listWorkerRows,
  namespaceOwner,
  type Deploy3Observation,
  type WorkerInventoryItem,
} from "./cloudflareApi.ts";
import {
  createDeploy3CloudflareApi,
  safeCloudflareId,
  type Deploy3CloudflareApi,
} from "./cloudflareTransport.ts";

export type { Deploy3Observation, WorkerInventoryItem } from "./cloudflareApi.ts";

export interface Deploy3CleanupOptions {
  readonly accountId: string;
  readonly token: string;
  readonly workerName: string;
  readonly expectedTag?: string;
  readonly nowMs: number;
  readonly registeredDeadlineUtc?: string;
  readonly expectedNamespaceIds?: readonly string[];
  readonly releasedRegistrationSha256?: string;
  readonly fetchImpl?: typeof fetch;
  readonly observe?: (event: Deploy3Observation) => void | Promise<void>;
  /** Compatibility hint only; it never bypasses the encoded deadline. */
  readonly forceDue?: boolean;
}

export interface Deploy3CleanupResult {
  readonly schema: "sb1070/deploy3-cloud-cleanup/v1";
  readonly status: "verified-absent" | "not-due" | "refused" | "failed-or-uncertain";
  readonly cleanClaim: boolean;
  readonly workerName: string;
  readonly runId?: string;
  readonly deadlineUtc?: string;
  readonly assets: "worker-script-managed";
  readonly checks: readonly {
    readonly name: string;
    readonly status: "passed" | "failed";
    readonly detail?: unknown;
  }[];
  readonly failures: readonly string[];
  readonly externalBindingsPreserved: readonly string[];
}

type Check = { name: string; status: "passed" | "failed"; detail?: unknown };

function result(
  workerName: string,
  status: Deploy3CleanupResult["status"],
  checks: readonly Check[],
  failures: readonly string[],
  identity?: { runId: string; deadlineUtc: string },
  externalBindingsPreserved: readonly string[] = [],
): Deploy3CleanupResult {
  return {
    schema: "sb1070/deploy3-cloud-cleanup/v1",
    status,
    cleanClaim: status === "verified-absent" && failures.length === 0,
    workerName,
    ...(identity ? { runId: identity.runId, deadlineUtc: identity.deadlineUtc } : {}),
    assets: "worker-script-managed",
    checks,
    failures,
    externalBindingsPreserved,
  };
}

function refused(
  workerName: string,
  status: "not-due" | "refused" | "failed-or-uncertain",
  failure: string,
  identity?: { runId: string; deadlineUtc: string },
): Deploy3CleanupResult {
  return result(workerName, status, [{ name: failure, status: "failed" }], [failure], identity);
}

function check(
  checks: Check[],
  failures: string[],
  name: string,
  passed: boolean,
  detail?: unknown,
): void {
  checks.push({
    name,
    status: passed ? "passed" : "failed",
    ...(detail === undefined ? {} : { detail }),
  });
  if (!passed) failures.push(name);
}

function effectiveTags(
  worker: WorkerInventoryItem,
  settings: Record<string, unknown>,
): readonly unknown[] | undefined {
  const inventoryTags = worker.tags;
  const settingsTags = settings.tags;
  if (
    inventoryTags !== undefined &&
    (!Array.isArray(inventoryTags) || inventoryTags.some((tag) => typeof tag !== "string"))
  ) {
    throw new Error("Worker inventory tags are malformed");
  }
  if (
    settingsTags !== undefined &&
    (!Array.isArray(settingsTags) || settingsTags.some((tag) => typeof tag !== "string"))
  ) {
    throw new Error("Worker settings tags are malformed");
  }
  if (inventoryTags !== undefined && settingsTags !== undefined) {
    const left = [...inventoryTags].sort();
    const right = [...settingsTags].sort();
    if (left.length !== right.length || left.some((tag, index) => tag !== right[index])) {
      throw new Error("Worker metadata tag views disagree");
    }
  }
  return settingsTags === undefined ? inventoryTags : settingsTags;
}

function identityOf(value: { runId: string; deadlineUtc: string }) {
  return { runId: value.runId, deadlineUtc: value.deadlineUtc };
}

async function cleanMissingWorker(
  api: Deploy3CloudflareApi,
  workerName: string,
  identity: { runId: string; deadlineUtc: string },
  expectedNamespaceIds: readonly string[],
): Promise<Deploy3CleanupResult> {
  try {
    const [tails, namespaces] = await Promise.all([
      listDeploy3Tails(api, workerName),
      listDeploy3Namespaces(api),
    ]);
    const remainingNamespaces = namespaces.filter(
      (item) =>
        namespaceOwner(item) === workerName || expectedNamespaceIds.includes(String(item.id)),
    );
    if (tails.length > 0 || remainingNamespaces.length > 0) {
      return refused(
        workerName,
        "failed-or-uncertain",
        "worker-absent-with-owned-resources",
        identity,
      );
    }
    return result(
      workerName,
      "verified-absent",
      [{ name: "already-absent", status: "passed" }],
      [],
      identity,
    );
  } catch {
    return refused(workerName, "failed-or-uncertain", "verify-existing-absence", identity);
  }
}

/**
 * Deletes an exact expired deploy3 Worker. Tails are removed first, then the Worker with
 * force omitted. Cloudflare deletes namespaces implemented by that Worker with it.
 * Its DELETE API has no separate namespace DELETE; verify the exact IDs afterward.
 * Shared bound resources stay.
 */
export async function cleanupDeploy3Worker(
  options: Deploy3CleanupOptions,
): Promise<Deploy3CleanupResult> {
  const { accountId, token, workerName, expectedTag, nowMs } = options;
  const parsedName = parseDeploy3Name(workerName);
  if (!parsedName) return refused(workerName, "refused", "invalid-deploy3-name");
  if (
    options.releasedRegistrationSha256 !== undefined &&
    !/^[a-f0-9]{64}$/.test(options.releasedRegistrationSha256)
  ) {
    return refused(workerName, "refused", "invalid-normal-release-authority");
  }
  const registeredDeadline =
    options.registeredDeadlineUtc === undefined
      ? undefined
      : Date.parse(options.registeredDeadlineUtc);
  if (
    registeredDeadline !== undefined &&
    (!Number.isSafeInteger(registeredDeadline) || registeredDeadline < parsedName.deadlineMs)
  ) {
    return refused(workerName, "refused", "invalid-registered-deadline");
  }
  if (options.expectedNamespaceIds?.some((value) => !safeCloudflareId(value))) {
    return refused(workerName, "refused", "invalid-registered-namespace");
  }
  const originalIdentity = {
    runId: parsedName.runId,
    deadlineUtc: options.registeredDeadlineUtc ?? parsedName.deadlineUtc,
  };
  if (!/^[a-f0-9]{32}$/.test(accountId) || !token) {
    return refused(
      workerName,
      "failed-or-uncertain",
      "cloudflare-configuration-incomplete",
      originalIdentity,
    );
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    return refused(workerName, "refused", "invalid-nowMs", originalIdentity);
  }
  if (expectedTag !== undefined && !safeCloudflareId(expectedTag)) {
    return refused(workerName, "refused", "invalid-expected-tag", originalIdentity);
  }
  // forceDue is accepted for caller compatibility but cannot authorize an early deletion.
  void options.forceDue;

  const api = createDeploy3CloudflareApi({
    accountId,
    token,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.observe ? { observe: options.observe } : {}),
  });
  let workers: WorkerInventoryItem[];
  try {
    workers = await listWorkerRows(api);
  } catch {
    return refused(
      workerName,
      "failed-or-uncertain",
      "worker-inventory-incomplete",
      originalIdentity,
    );
  }
  const matches = workers.filter((worker) => worker.id === workerName);
  if (matches.length > 1)
    return refused(workerName, "refused", "duplicate-worker-name", originalIdentity);
  const worker = matches[0];
  if (!worker)
    return cleanMissingWorker(
      api,
      workerName,
      originalIdentity,
      options.expectedNamespaceIds ?? [],
    );

  let settings: Record<string, unknown>;
  try {
    const current = await getDeploy3WorkerSettings(api, workerName);
    if (!current)
      return refused(
        workerName,
        "failed-or-uncertain",
        "worker-settings-unavailable",
        originalIdentity,
      );
    settings = current;
  } catch {
    return refused(
      workerName,
      "failed-or-uncertain",
      "worker-settings-unavailable",
      originalIdentity,
    );
  }
  let deadline;
  try {
    deadline = effectiveDeploy3Deadline(workerName, effectiveTags(worker, settings));
  } catch {
    return refused(workerName, "refused", "invalid-deploy3-deadline-tags", originalIdentity);
  }
  if (!deadline)
    return refused(workerName, "refused", "invalid-deploy3-deadline-tags", originalIdentity);
  // The durable registration carries accepted extensions after the Worker and its tags disappear.
  if (registeredDeadline !== undefined)
    deadline = {
      ...deadline,
      deadlineMs: registeredDeadline,
      deadlineUtc: options.registeredDeadlineUtc!,
    };
  const identity = identityOf(deadline);
  if (expectedTag !== undefined && worker.tag !== expectedTag) {
    return refused(workerName, "refused", "worker-immutable-tag-mismatch", identity);
  }
  if (nowMs < deadline.deadlineMs && options.releasedRegistrationSha256 === undefined) {
    return result(
      workerName,
      "not-due",
      [{ name: "deadline", status: "passed", detail: deadline.deadlineUtc }],
      [],
      identity,
    );
  }

  const checks: Check[] = [];
  const failures: string[] = [];
  const preservedBindings = deploy3ExternalBindings(settings);
  let tails: Record<string, unknown>[];
  let namespaces: Record<string, unknown>[];
  let bindingIds: string[];
  try {
    [tails, namespaces] = await Promise.all([
      listDeploy3Tails(api, workerName),
      listDeploy3Namespaces(api),
    ]);
    bindingIds = deploy3NamespaceBindingIds(settings);
  } catch {
    return refused(
      workerName,
      "failed-or-uncertain",
      "owned-resource-inventory-incomplete",
      identity,
    );
  }
  const byWorker = namespaces.filter((item) => namespaceOwner(item) === workerName);
  if (byWorker.some((item) => !safeCloudflareId(item.id))) {
    return refused(workerName, "failed-or-uncertain", "owned-namespace-id-missing", identity);
  }
  const byId = new Map<string, Record<string, unknown>>(
    namespaces.filter((item) => safeCloudflareId(item.id)).map((item) => [item.id as string, item]),
  );
  const ownedNamespaceIds = new Set(byWorker.map((item) => item.id as string));
  for (const id of bindingIds) {
    const namespace = byId.get(id);
    if (!namespace) continue;
    const owner = namespaceOwner(namespace);
    if (owner === workerName) ownedNamespaceIds.add(id);
    else if (typeof owner !== "string") {
      return refused(workerName, "failed-or-uncertain", "bound-namespace-owner-unknown", identity);
    } else {
      preservedBindings.push(`durable_object_namespace:${id}`);
    }
  }
  const tailIds = tails.map((tail) => tail.id as string);
  const namespaceIds = [...ownedNamespaceIds].sort();
  check(checks, failures, "preflight-worker-identity", true, {
    immutableTagChecked: expectedTag !== undefined,
    deadlineUtc: deadline.deadlineUtc,
  });
  check(checks, failures, "preflight-owned-resources", true, {
    tailIds: [...tailIds].sort(),
    namespaceIds,
  });

  for (const tailId of tailIds) {
    try {
      await api.request(
        `delete-tail-${tailId}`,
        "DELETE",
        `/workers/scripts/${encodeURIComponent(workerName)}/tails/${encodeURIComponent(tailId)}`,
        true,
      );
      check(checks, failures, `delete-tail:${tailId}`, true);
    } catch {
      check(checks, failures, `delete-tail:${tailId}`, false);
    }
  }
  try {
    await api.request(
      "delete-worker",
      "DELETE",
      `/workers/scripts/${encodeURIComponent(workerName)}`,
      true,
    );
    check(checks, failures, "delete-worker", true, { force: false });
  } catch {
    check(checks, failures, "delete-worker", false, { force: false });
  }

  const verify = async (name: string, operation: () => Promise<boolean>) => {
    try {
      check(checks, failures, name, await operation());
    } catch {
      check(checks, failures, name, false);
    }
  };
  await verify("verify-worker-absence", async () =>
    (await listWorkerRows(api)).every((item) => item.id !== workerName),
  );
  await verify(
    "verify-tail-absence",
    async () => (await listDeploy3Tails(api, workerName)).length === 0,
  );
  await verify("verify-namespace-absence", async () => {
    const all = await listDeploy3Namespaces(api);
    return !all.some(
      (item) =>
        namespaceIds.includes(String(item.id)) ||
        options.expectedNamespaceIds?.includes(String(item.id)) ||
        namespaceOwner(item) === workerName,
    );
  });
  const status = failures.length === 0 ? "verified-absent" : "failed-or-uncertain";
  return result(
    workerName,
    status,
    checks,
    failures,
    identity,
    [...new Set(preservedBindings)].sort(),
  );
}

/** Exposed for the hourly backstop; it only returns a complete inventory or throws. */
export async function listDeploy3WorkerInventory(options: {
  readonly accountId: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  readonly observe?: (event: Deploy3Observation) => void | Promise<void>;
}): Promise<WorkerInventoryItem[]> {
  if (!/^[a-f0-9]{32}$/.test(options.accountId) || !options.token) {
    throw new Error("Cloudflare configuration is incomplete");
  }
  const api = createDeploy3CloudflareApi(options);
  return listWorkerRows(api);
}
