import type { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";

export interface ThreadOwner {
  readonly userId: string;
  /** The context the thread acts as, fixed at creation in CloudThreadService. */
  readonly contextId: SignalboxContextId;
  /**
   * The drive the thread works in, fixed at creation. Null for threads created
   * before shared drives, which work in their owner's My Drive.
   */
  readonly driveId: string | null;
}
