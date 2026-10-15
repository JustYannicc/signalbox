// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { WorkflowSourceWatch } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { toJson } from "../json.ts";
import { durationMs } from "../stepPolicy.ts";

/**
 * What a watched source is and how two reads of it differ. Pure, so the
 * poller (sourceWatches.ts) and the matching in triggers and waits agree on
 * which source an event came from.
 */

export const DEFAULT_EVERY_MS = 5 * 60_000;
export const MIN_EVERY_MS = 60_000;

/** JSON with object keys sorted, so equal values always print the same. */
export function canonicalJson(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input === null || typeof input !== "object") return input;
    return Object.fromEntries(
      Object.keys(input)
        .toSorted()
        .map((key) => [key, sort((input as Record<string, unknown>)[key])]),
    );
  };
  return toJson(sort(value) ?? null);
}

/** A short, stable digest of a value: equal values, equal fingerprints. */
export const fingerprint = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 16);

export const isSourceWatch = Schema.is(WorkflowSourceWatch);

const ids = new WeakMap<WorkflowSourceWatch, Map<string, string>>();

/**
 * One id per thing read: the same operation, arguments, account, list and key
 * in one project is one source, whatever `fields` and `every` each watcher
 * asks for. Projects never share a source; their connections may differ.
 * Watches come from cached trigger indexes and run listeners, so ids are
 * remembered per watch object.
 */
export function sourceIdOf(projectId: string, watch: WorkflowSourceWatch): string {
  const known = ids.get(watch) ?? new Map<string, string>();
  ids.set(watch, known);
  const cached = known.get(projectId);
  if (cached) return cached;
  const id = `source_${fingerprint({
    projectId,
    operation: watch.operation,
    connection: watch.connection ?? null,
    args: watch.args ?? {},
    items: watch.items ?? null,
    key: watch.key,
  })}`;
  known.set(projectId, id);
  return id;
}

/** How often a watch asks to be checked, never under a minute. */
export function everyMsOf(watch: WorkflowSourceWatch): number {
  const ms = watch.every === undefined ? null : durationMs(watch.every);
  return Math.max(MIN_EVERY_MS, ms ?? DEFAULT_EVERY_MS);
}

/** `a.b.c` into a value's own fields; undefined when any part is missing. */
export function pathValue(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, part))
      return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * What an operation answered, without an MCP tool's envelope: Executor passes
 * MCP-backed tools' results through as `{ content, structuredContent }`.
 */
export function unwrapToolResult(answer: unknown): unknown {
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) return answer;
  const record = answer as Record<string, unknown>;
  if (!("content" in record) || !Array.isArray(record.content)) return answer;
  if (record.structuredContent !== undefined && record.structuredContent !== null)
    return record.structuredContent;
  const texts = record.content.filter(
    (block): block is { type: "text"; text: string } =>
      typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text",
  );
  if (texts.length !== 1) return answer;
  try {
    return JSON.parse(texts[0]!.text) as unknown;
  } catch {
    return answer;
  }
}

/** The list in an operation's answer: at `items`, else the answer itself, else its only list. */
export function listOf(
  raw: unknown,
  items: string | undefined,
):
  | { readonly ok: true; readonly list: ReadonlyArray<unknown> }
  | { readonly ok: false; readonly error: string } {
  const answer = unwrapToolResult(raw);
  if (items !== undefined) {
    const found = pathValue(answer, items);
    return Array.isArray(found)
      ? { ok: true, list: found }
      : { ok: false, error: `The answer has no list at "${items}".` };
  }
  if (Array.isArray(answer)) return { ok: true, list: answer };
  if (answer !== null && typeof answer === "object") {
    const lists = Object.entries(answer).filter(([, value]) => Array.isArray(value));
    if (lists.length === 1) return { ok: true, list: lists[0]![1] as ReadonlyArray<unknown> };
    if (lists.length > 1)
      return {
        ok: false,
        error: `The answer has several lists (${lists.map(([name]) => name).join(", ")}); say which with items.`,
      };
  }
  return { ok: false, error: "The answer isn't a list; say where the list is with items." };
}

/** Items by key, in the order the source lists them. Items without a key are skipped; the first of a repeated key wins. */
export type Snapshot = ReadonlyArray<readonly [key: string, item: unknown]>;

export function snapshotOf(list: ReadonlyArray<unknown>, key: string): Snapshot {
  const items = new Map<string, unknown>();
  for (const item of list) {
    const value = pathValue(item, key);
    if (typeof value !== "string" && typeof value !== "number") continue;
    const id = String(value);
    if (!items.has(id)) items.set(id, item);
  }
  return [...items];
}

export type SourceChange =
  | { readonly kind: "added"; readonly key: string; readonly item: unknown }
  | {
      readonly kind: "changed";
      readonly key: string;
      readonly item: unknown;
      readonly before: unknown;
      /** Top-level fields that differ; the whole item when it isn't an object. */
      readonly changed: ReadonlyArray<string>;
    }
  | { readonly kind: "removed"; readonly key: string; readonly item: unknown };

function changedFields(before: unknown, after: unknown): ReadonlyArray<string> {
  const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isObject(before) || !isObject(after))
    return canonicalJson(before) === canonicalJson(after) ? [] : ["*"];
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names]
    .filter((name) => canonicalJson(before[name]) !== canonicalJson(after[name]))
    .toSorted();
}

/** Whether an event came from the source `watch` reads, and changed a field it cares about. */
export function watchMatches(
  projectId: string,
  watch: WorkflowSourceWatch,
  envelope: Readonly<Record<string, unknown>>,
): boolean {
  if (envelope.sourceId !== sourceIdOf(projectId, watch)) return false;
  const changed = envelope.changed;
  return watchCares(
    watch,
    Array.isArray(changed)
      ? changed.filter((name): name is string => typeof name === "string")
      : undefined,
  );
}

/** What changed between two reads, in the order the new read lists items, removals last. */
export function diffSnapshots(before: Snapshot, after: Snapshot): ReadonlyArray<SourceChange> {
  const previous = new Map(before);
  const current = new Map(after);
  const changes: SourceChange[] = [];
  for (const [key, item] of after) {
    if (!previous.has(key)) {
      changes.push({ kind: "added", key, item });
      continue;
    }
    if (fingerprint(previous.get(key)) === fingerprint(item)) continue;
    const changed = changedFields(previous.get(key), item);
    if (changed.length > 0)
      changes.push({ kind: "changed", key, item, before: previous.get(key), changed });
  }
  for (const [key, item] of before) {
    if (!current.has(key)) changes.push({ kind: "removed", key, item });
  }
  return changes;
}

/** Whether a watch's `fields` care about a change: always for adds and removes. */
export function watchCares(
  watch: Pick<WorkflowSourceWatch, "fields">,
  changed: ReadonlyArray<string> | undefined,
): boolean {
  if (!watch.fields || changed === undefined) return true;
  return changed.includes("*") || watch.fields.some((field) => changed.includes(field));
}
