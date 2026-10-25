import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { WsRpcGroup } from "@t3tools/contracts";
import {
  ClientIssue as ClientIssueSchema,
  type ClientIssue,
} from "@t3tools/contracts/clientIssues";
import {
  createClientIssueQueue,
  type ClientIssueFlushResult,
  type ClientIssueReportingStats,
  type ClientIssueQueueSender,
} from "./clientIssueQueue.ts";

export type { ClientIssueFlushResult, ClientIssueReportingStats } from "./clientIssueQueue.ts";

export interface ClientIssueContext {
  readonly threadId?: string | null;
  readonly folderId?: string | null;
  readonly environmentId?: string | null;
}

export interface ClientIssueReportingConfig {
  readonly client: ClientIssue["client"];
  readonly release: string;
  readonly context?: () => ClientIssueContext;
  readonly folderOfThread?: (environmentId: string, threadId: string) => string | null;
  readonly send: ClientIssueQueueSender["send"];
  readonly scheduleRetry?: ClientIssueQueueSender["scheduleRetry"];
}

export interface ClientIssueReportInput extends ClientIssueContext {
  readonly code: ClientIssue["code"];
  readonly severity: ClientIssue["severity"];
  readonly source: ClientIssue["source"];
  readonly traceId?: string;
  readonly spanId?: string;
  readonly method?: string;
  readonly durationMs?: number;
  /** Suppresses only unchanged state for this explicit, safe key. */
  readonly dedupeKey?: string;
}

const SAFE_DEDUPE_KEY = /^[a-zA-Z0-9_.:-]{1,160}$/;
const TRACE_ID = /^(?!0{32}$)[a-f0-9]{32}$/;
const SPAN_ID = /^(?!0{16}$)[a-f0-9]{16}$/;
const CONTEXT_ID = Schema.NullOr(
  Schema.String.check(
    Schema.isPattern(
      /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|(?:user|org)_[0-9A-HJKMNP-TV-Z]{26})$/,
    ),
  ),
);
const ENVIRONMENT_ID = Schema.NullOr(Schema.String.check(Schema.isMaxLength(128)));
const isContextId = Schema.is(CONTEXT_ID);
const isEnvironmentId = Schema.is(ENVIRONMENT_ID);
const isRelease = Schema.is(ClientIssueSchema.fields.release);
const decodeClientIssue = Schema.decodeUnknownOption(ClientIssueSchema);
const issueQueue = createClientIssueQueue();

/** Configure the one client-runtime reporter. Passing null clears it on sign-out. */
export function configureClientIssueReporting(next: ClientIssueReportingConfig | null): void {
  issueQueue.reset();
  if (next === null) {
    config = null;
    return;
  }

  config = {
    client: next.client,
    release: next.release,
    send: next.send,
    ...(next.context === undefined ? {} : { context: next.context }),
    ...(next.folderOfThread === undefined ? {} : { folderOfThread: next.folderOfThread }),
    ...(next.scheduleRetry === undefined ? {} : { scheduleRetry: next.scheduleRetry }),
  };
}

let config: ClientIssueReportingConfig | null = null;

/** Captures an allow-listed issue and queues it without throwing into app work. */
export function reportClientIssue(input: ClientIssueReportInput): ClientIssue | null {
  const current = config;
  if (current === null) return null;

  try {
    const context = readContext(current);
    const contextEnvironmentId = sanitizeEnvironmentId(context.environmentId);
    const environmentId = sanitizeEnvironmentId(
      input.environmentId === undefined ? contextEnvironmentId : input.environmentId,
    );
    const sameEnvironment = environmentId !== null && environmentId === contextEnvironmentId;
    const contextThreadId = sanitizeContextId(context.threadId);
    const threadId = sanitizeContextId(
      input.threadId === undefined ? (sameEnvironment ? contextThreadId : null) : input.threadId,
    );
    const sameThread = sameEnvironment && threadId === contextThreadId;
    const folderId = resolveFolderId(current, input.folderId, environmentId, threadId, {
      context,
      sameThread,
    });

    const traceId = isTraceId(input.traceId) ? input.traceId : randomHex(16, TRACE_ID);
    const spanId = isSpanId(input.spanId) ? input.spanId : randomHex(8, SPAN_ID);
    if (traceId === null || spanId === null) return null;

    const method = safeIdentifier(input.method);
    const durationMs = safeDuration(input.durationMs);
    const candidate = {
      code: input.code,
      severity: input.severity,
      source: input.source,
      client: current.client,
      release: safeRelease(current.release),
      threadId,
      folderId,
      environmentId,
      traceId,
      spanId,
      ...(isTraceId(input.traceId) && isSpanId(input.spanId) ? { existingSpan: true } : {}),
      ...(method === undefined ? {} : { method }),
      ...(durationMs === undefined ? {} : { durationMs }),
    };
    const decoded = decodeClientIssue(candidate);
    if (Option.isNone(decoded)) return null;

    const dedupeKey = safeDedupeKey(input.dedupeKey);
    const queued = {
      event: decoded.value,
      send: current.send,
      ...(current.scheduleRetry === undefined ? {} : { scheduleRetry: current.scheduleRetry }),
      ...(dedupeKey === undefined ? {} : { dedupeKey }),
    };
    return issueQueue.enqueue(queued) ? decoded.value : null;
  } catch {
    return null;
  }
}

/** Explicitly retries retained reports, for example after focus or reconnect. */
export function flushClientIssues(): Promise<ClientIssueFlushResult> {
  return issueQueue.flush();
}

export function getClientIssueReportingStats(): ClientIssueReportingStats {
  return issueQueue.stats();
}

/** A warning that disappeared must be reportable if it returns. */
export function clearClientIssueState(dedupeKey: string): void {
  issueQueue.clearState(dedupeKey);
}

function readContext(current: ClientIssueReportingConfig): ClientIssueContext {
  try {
    return current.context?.() ?? {};
  } catch {
    return {};
  }
}

function resolveFolderId(
  current: ClientIssueReportingConfig,
  explicitFolderId: string | null | undefined,
  environmentId: string | null,
  threadId: string | null,
  fallback: { readonly context: ClientIssueContext; readonly sameThread: boolean },
): string | null {
  if (explicitFolderId !== undefined) return sanitizeContextId(explicitFolderId);
  if (environmentId !== null && threadId !== null && current.folderOfThread !== undefined) {
    try {
      return sanitizeContextId(current.folderOfThread(environmentId, threadId));
    } catch {
      return null;
    }
  }
  return fallback.sameThread ? sanitizeContextId(fallback.context.folderId) : null;
}

function sanitizeContextId(value: unknown): string | null {
  return isContextId(value) ? value : null;
}

function sanitizeEnvironmentId(value: unknown): string | null {
  return isEnvironmentId(value) ? value : null;
}

function safeRelease(value: unknown): string {
  return isRelease(value) ? value : "unknown";
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && WsRpcGroup.requests.has(value) ? value : undefined;
}

function safeDedupeKey(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_DEDUPE_KEY.test(value) ? value : undefined;
}

function safeDuration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 86_400_000
    ? value
    : undefined;
}

function isTraceId(value: unknown): value is string {
  return typeof value === "string" && TRACE_ID.test(value);
}

function isSpanId(value: unknown): value is string {
  return typeof value === "string" && SPAN_ID.test(value);
}

function randomHex(byteLength: number, pattern: RegExp): string | null {
  const crypto = globalThis.crypto;
  if (crypto === undefined || typeof crypto.getRandomValues !== "function") return null;
  const bytes = new Uint8Array(byteLength);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    crypto.getRandomValues(bytes);
    const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (pattern.test(value)) return value;
  }
  return null;
}
