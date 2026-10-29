import {
  isRecord,
  safeCloudflareId,
  type Deploy3CloudflareApi,
  type JsonRecord,
} from "./cloudflareTransport.ts";
export type { Deploy3Observation } from "./cloudflareTransport.ts";

const PAGE_SIZE = 100;
const MAX_PAGES = 100;

export interface WorkerInventoryItem extends JsonRecord {
  readonly id: string;
  readonly tag?: string;
  readonly etag?: string;
  readonly tags?: readonly string[];
}

function requireRows(result: unknown, key: string): JsonRecord[] {
  if (!Array.isArray(result) || result.some((item) => !isRecord(item))) {
    throw new Error(`Incomplete Cloudflare ${key} response`);
  }
  return result as JsonRecord[];
}

function pageTotal(info: JsonRecord | undefined): number | undefined {
  if (info === undefined || info.total_pages === undefined) return undefined;
  const total = info.total_pages;
  if (!Number.isSafeInteger(total) || (total as number) < 0 || (total as number) > MAX_PAGES) {
    throw new Error("Invalid Cloudflare pagination total");
  }
  return total as number;
}

function checkedWorkers(rows: JsonRecord[]): WorkerInventoryItem[] {
  const seen = new Set<string>();
  return rows.map((row) => {
    if (typeof row.id !== "string" || row.id.length === 0 || seen.has(row.id)) {
      throw new Error("Worker inventory is incomplete or has duplicate IDs");
    }
    seen.add(row.id);
    return row as WorkerInventoryItem;
  });
}

/** Cloudflare's Worker script list is a complete single page unless it reports result_info. */
export async function listDeploy3WorkerInventory(
  api: Deploy3CloudflareApi,
): Promise<WorkerInventoryItem[]> {
  const first = await api.request("list-workers-1", "GET", "/workers/scripts");
  let rows = requireRows(first.result, "Worker inventory");
  const total = pageTotal(first.resultInfo);
  if (total === undefined) return checkedWorkers(rows);
  if (total === 0) {
    if (rows.length !== 0) throw new Error("Worker pagination total conflicts with its first page");
    return [];
  }
  if (total === 1) return checkedWorkers(rows);
  for (let page = 2; page <= total; page += 1) {
    const next = await api.request(
      `list-workers-${page}`,
      "GET",
      `/workers/scripts?page=${page}&per_page=${PAGE_SIZE}`,
    );
    if (pageTotal(next.resultInfo) !== total) {
      throw new Error("Worker inventory pagination changed during listing");
    }
    rows = rows.concat(requireRows(next.result, "Worker inventory"));
  }
  return checkedWorkers(rows);
}

export function namespaceOwner(row: JsonRecord): unknown {
  return row.script ?? row.script_name;
}

export async function listDeploy3Namespaces(api: Deploy3CloudflareApi): Promise<JsonRecord[]> {
  const rows: JsonRecord[] = [];
  const seen = new Set<string>();
  let total: number | undefined;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await api.request(
      `list-namespaces-${page}`,
      "GET",
      `/workers/durable_objects/namespaces?page=${page}&per_page=${PAGE_SIZE}`,
    );
    const pageRows = requireRows(response.result, "Durable Object namespace inventory");
    const reported = pageTotal(response.resultInfo);
    if (reported !== undefined) {
      if (reported === 0 && pageRows.length === 0) return rows;
      if (reported < 1 || (total !== undefined && reported !== total)) {
        throw new Error("Invalid Durable Object namespace pagination");
      }
      total = reported;
    }
    for (const row of pageRows) {
      if (!safeCloudflareId(row.id) || seen.has(row.id)) {
        throw new Error("Namespace inventory is incomplete or has duplicate IDs");
      }
      seen.add(row.id);
      rows.push(row);
    }
    if (total !== undefined && page >= total) return rows;
    if (total === undefined && pageRows.length < PAGE_SIZE) return rows;
  }
  throw new Error("Durable Object namespace pagination exceeded its bound");
}

export async function listDeploy3Tails(
  api: Deploy3CloudflareApi,
  workerName: string,
): Promise<JsonRecord[]> {
  const response = await api.request(
    "list-worker-tails",
    "GET",
    `/workers/scripts/${encodeURIComponent(workerName)}/tails`,
    true,
  );
  if (response.notFound || response.result === null) return [];
  // Cloudflare returns the current script-scoped Tail as one object; no page API exists here.
  const rows = Array.isArray(response.result)
    ? requireRows(response.result, "Tail inventory")
    : isRecord(response.result)
      ? [response.result]
      : null;
  if (rows === null || rows.some((tail) => !safeCloudflareId(tail.id))) {
    throw new Error("Tail inventory is incomplete");
  }
  return rows;
}

export async function getDeploy3WorkerSettings(
  api: Deploy3CloudflareApi,
  workerName: string,
): Promise<JsonRecord | null> {
  const response = await api.request(
    "inspect-worker-settings",
    "GET",
    `/workers/scripts/${encodeURIComponent(workerName)}/settings`,
    true,
  );
  return response.notFound || !isRecord(response.result) ? null : response.result;
}

export function deploy3NamespaceBindingIds(settings: JsonRecord): string[] {
  if (settings.bindings === undefined) return [];
  if (
    !Array.isArray(settings.bindings) ||
    settings.bindings.some((binding) => !isRecord(binding))
  ) {
    throw new Error("Worker binding inventory is incomplete");
  }
  const ids: string[] = [];
  for (const binding of settings.bindings as JsonRecord[]) {
    if (binding.type !== "durable_object_namespace") continue;
    if (!safeCloudflareId(binding.namespace_id)) {
      throw new Error("Worker Durable Object binding has no exact namespace ID");
    }
    ids.push(binding.namespace_id);
  }
  return ids;
}

export function deploy3ExternalBindings(settings: JsonRecord): string[] {
  if (!Array.isArray(settings.bindings)) return [];
  return (settings.bindings as unknown[])
    .filter((binding): binding is JsonRecord => isRecord(binding))
    .filter(
      (binding) => typeof binding.type === "string" && binding.type !== "durable_object_namespace",
    )
    .map(
      (binding) =>
        `${String(binding.type)}:${typeof binding.name === "string" ? binding.name : "unnamed"}`,
    )
    .sort();
}
