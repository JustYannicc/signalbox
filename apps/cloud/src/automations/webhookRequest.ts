import type { WorkflowWebhookOptions } from "@t3tools/contracts";
import * as Base64 from "effect/encoding/Base64";
import * as Hex from "effect/encoding/Hex";

/** The original bytes cross the Worker-to-object boundary before any parsing. */
export interface HookRequest {
  readonly hookId: string;
  readonly token: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly query: string;
  readonly body: Uint8Array;
}

export type HookAnswer =
  | { readonly status: 202; readonly deliveryId: string; readonly duplicate: boolean }
  | { readonly status: 400 | 401 | 404 | 409 | 413 | 429 };

export const MAX_HOOK_BYTES = 1024 * 1024;

/** WebCrypto verifies the HMAC in constant time, using the sender's exact bytes. */
export async function verifySignature(
  signature: NonNullable<WorkflowWebhookOptions["signature"]>,
  secret: string,
  request: Pick<HookRequest, "headers" | "body">,
): Promise<boolean> {
  const header = request.headers[signature.header.toLowerCase()];
  const prefix = signature.prefix ?? "";
  if (header === undefined || !header.startsWith(prefix)) return false;
  const encoded = header.slice(prefix.length);
  const decoded = signature.encoding === "hex" ? Hex.decode(encoded) : Base64.decode(encoded);
  if (decoded._tag === "Failure" || decoded.success.length !== 32) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    new Uint8Array(decoded.success),
    new Uint8Array(request.body),
  );
}

/** Hash both values before comparing, so tokens of different lengths take the same path. */
export async function sameToken(left: string, right: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(right),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const bytes = new TextEncoder().encode("signalbox-hook-token");
  const signature = await crypto.subtle.sign("HMAC", key, bytes);
  const candidate = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(left),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", candidate, signature, bytes);
}

export function hookInput(request: Pick<HookRequest, "body" | "headers">): unknown {
  const text = new TextDecoder().decode(request.body);
  if (text === "") return null;
  if (request.headers["content-type"]?.includes("application/x-www-form-urlencoded"))
    return Object.fromEntries(new URLSearchParams(text));
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

const CREDENTIAL =
  /^(authorization|proxy-authorization|cookie|set-cookie)$|token|secret|signature|key|password|auth/i;
export const publicHeaders = (headers: Readonly<Record<string, string>>) =>
  Object.fromEntries(
    Object.entries(headers)
      .filter(([name]) => !name.startsWith("x-t3-"))
      .map(([name, value]) => [name, CREDENTIAL.test(name) ? "[redacted]" : value]),
  );
export const publicQuery = (query: string) =>
  Object.fromEntries(
    [...new URLSearchParams(query)].map(([name, value]) => [
      name,
      CREDENTIAL.test(name) ? "[redacted]" : value,
    ]),
  );

/** GitHub keeps this id on redelivery. It takes precedence over an arbitrary sender key. */
export const deliveryKey = (headers: Readonly<Record<string, string>>) =>
  headers["x-github-delivery"] ?? headers["idempotency-key"] ?? headers["x-request-id"];
