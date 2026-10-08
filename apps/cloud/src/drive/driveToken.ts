import type { ThreadId } from "@t3tools/contracts";

import { isLeaseToken, signLeaseToken, threadOfLeaseToken } from "../thread/runner/leaseToken.ts";

/**
 * Drive tokens: what a thread's Runner presents to the drive API. One per
 * thread and machine generation, derived from the machine's lease token like
 * model tokens are (`thread/runner/leaseToken.ts`):
 *
 *   sbd1.<base64url(thread id)>.<base64url(HMAC-SHA256(lease token, "drive" + generation))>
 */

const PREFIX = "sbd1";

export const driveToken = (leaseToken: string, threadId: ThreadId, generation: number) =>
  signLeaseToken(PREFIX, leaseToken, threadId, `drive\n${generation}`);

/** The thread a drive token names, or null when it is not one. Says nothing about validity. */
export const threadOfDriveToken = (token: string) => threadOfLeaseToken(PREFIX, token);

/** Whether `token` is the drive token of this lease, compared in constant time. */
export const isDriveToken = (
  token: string,
  leaseToken: string,
  threadId: ThreadId,
  generation: number,
) => isLeaseToken(token, driveToken(leaseToken, threadId, generation));
