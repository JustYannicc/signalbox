import type { RunId, ThreadId } from "@t3tools/contracts";

import { isLeaseToken, signLeaseToken, threadOfLeaseToken } from "../thread/runner/leaseToken.ts";

/**
 * Remote tokens: what a thread's Runner presents to fetch its drive's remote
 * repository through the cloud (`DRIVE_PATHS.remote`). One per thread and
 * turn or pending pull, derived from the machine's lease token like model tokens are
 * (`thread/runner/leaseToken.ts`):
 *
 *   sbr1.<base64url(thread id)>.<base64url(HMAC-SHA256(lease token, "remote\n" + run id))>
 *
 * The thread grants access only while the named turn or pull is live, so an
 * ended operation, an older machine or another thread cannot use it. The
 * machine holds no credential for the remote itself.
 */

const PREFIX = "sbr1";

export const remoteToken = (leaseToken: string, threadId: ThreadId, runId: RunId) =>
  signLeaseToken(PREFIX, leaseToken, threadId, `remote\n${runId}`);

/** The thread a remote token names, or null when it is not one. Says nothing about validity. */
export const threadOfRemoteToken = (token: string) => threadOfLeaseToken(PREFIX, token);

/** Whether `token` is the remote token of this lease and run, compared in constant time. */
export const isRemoteToken = (
  token: string,
  leaseToken: string,
  threadId: ThreadId,
  runId: RunId,
) => isLeaseToken(token, remoteToken(leaseToken, threadId, runId));

export const remoteOperationToken = (leaseToken: string, threadId: ThreadId, operationId: string) =>
  signLeaseToken(PREFIX, leaseToken, threadId, `remote-operation\n${operationId}`);

export const isRemoteOperationToken = (
  token: string,
  leaseToken: string,
  threadId: ThreadId,
  operationId: string,
) => isLeaseToken(token, remoteOperationToken(leaseToken, threadId, operationId));
