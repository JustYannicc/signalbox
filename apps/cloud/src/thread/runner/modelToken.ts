import type { ModelGatewayProvider } from "@signalbox/runner-protocol/RunnerProtocol";
import type { RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";

/**
 * Model tokens: what a thread's harness presents to the ModelGateway. There is
 * one per thread, provider and turn, derived from the machine's lease token,
 * so the thread stores nothing new and nothing needs revoking:
 *
 *   sbm1.<base64url(thread id)>.<base64url(HMAC-SHA256(lease token, run id + provider))>
 *
 * The gateway reads the thread id to know which thread to ask, and the thread
 * recomputes the token for the run it has live. A token from a finished run,
 * another provider, an older machine or another thread never matches.
 */

const PREFIX = "sbm1";

export interface ModelGrant {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly provider: ModelGatewayProvider;
}

const encoder = new TextEncoder();

export const modelToken = (leaseToken: string, grant: ModelGrant) =>
  Effect.promise(async () => {
    const subtle = globalThis.crypto.subtle;
    const key = await subtle.importKey(
      "raw",
      encoder.encode(leaseToken),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await subtle.sign("HMAC", key, encoder.encode(`${grant.runId}\n${grant.provider}`));
    return `${PREFIX}.${Base64Url.encode(grant.threadId)}.${Base64Url.encode(new Uint8Array(mac))}`;
  });

/** The thread a model token names, or null when it is not one. Says nothing about validity. */
export function threadOfModelToken(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX || parts[1] === undefined) return null;
  const decoded = Base64Url.decode(parts[1]);
  return Result.isSuccess(decoded) ? new TextDecoder().decode(decoded.success) : null;
}

/** Whether `token` is `grant`'s, compared in constant time. */
export const isModelToken = (token: string, leaseToken: string, grant: ModelGrant) =>
  Effect.map(modelToken(leaseToken, grant), (expected) => {
    if (token.length !== expected.length) return false;
    let difference = 0;
    for (let index = 0; index < expected.length; index++) {
      difference |= token.charCodeAt(index) ^ expected.charCodeAt(index);
    }
    return difference === 0;
  });
