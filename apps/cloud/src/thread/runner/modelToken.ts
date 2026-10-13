import type { ModelGatewayProvider } from "@signalbox/runner-protocol/RunnerProtocol";
import type { RunId, ThreadId } from "@t3tools/contracts";

import { isLeaseToken, signLeaseToken, threadOfLeaseToken } from "./leaseToken.ts";

/**
 * Model tokens: what a thread's harness presents to the ModelGateway. There is
 * one per thread, provider and turn, derived from the machine's lease token
 * (`leaseToken.ts`):
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

export const modelToken = (leaseToken: string, grant: ModelGrant) =>
  signLeaseToken(PREFIX, leaseToken, grant.threadId, `${grant.runId}\n${grant.provider}`);

/** The thread a model token names, or null when it is not one. Says nothing about validity. */
export const threadOfModelToken = (token: string) => threadOfLeaseToken(PREFIX, token);

/** Whether `token` is `grant`'s, compared in constant time. */
export const isModelToken = (token: string, leaseToken: string, grant: ModelGrant) =>
  isLeaseToken(token, modelToken(leaseToken, grant));
