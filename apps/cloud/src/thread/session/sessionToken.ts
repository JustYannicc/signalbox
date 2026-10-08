import type { ThreadId } from "@t3tools/contracts";

import { signLeaseToken, threadOfLeaseToken } from "../runner/leaseToken.ts";

/**
 * Session tokens: what a thread's Runner presents to the session API
 * (`SessionProtocol.ts`). One per thread and machine generation, derived from
 * the machine's lease token like drive tokens are (`runner/leaseToken.ts`):
 *
 *   sbs1.<base64url(thread id)>.<base64url(HMAC-SHA256(lease token, "session" + generation))>
 */

const PREFIX = "sbs1";

export const sessionToken = (leaseToken: string, threadId: ThreadId, generation: number) =>
  signLeaseToken(PREFIX, leaseToken, threadId, `session\n${generation}`);

/** The thread a session token names, or null when it is not one. Says nothing about validity. */
export const threadOfSessionToken = (token: string) => threadOfLeaseToken(PREFIX, token);
