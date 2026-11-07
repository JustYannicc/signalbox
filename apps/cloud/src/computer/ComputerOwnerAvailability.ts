/** The one failure an evicted Computer gives; only it may be retried after a restore. */
export const COMPUTER_OWNER_UNAVAILABLE = "Computer execution owner is unavailable";

/** RPC carries a plain Error, so the message is the only identity that survives the hop. */
export const isComputerOwnerUnavailable = (error: unknown) =>
  error instanceof Error && error.message.includes(COMPUTER_OWNER_UNAVAILABLE);
