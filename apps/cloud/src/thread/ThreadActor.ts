import type { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";

/**
 * Who is acting. Only a thread's owner can read or change it until sharing
 * lands, and only while they're still in its context: `contextIds` are the
 * owner's contexts as their own object holds them at the time of the call.
 */
export interface Actor {
  readonly userId: string;
  readonly contextIds: ReadonlyArray<SignalboxContextId>;
}
