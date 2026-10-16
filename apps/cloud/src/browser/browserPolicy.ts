import type { KernelApiError, KernelBrowserRequest } from "./KernelApi.ts";

/**
 * The person's browser's decisions (#574), apart from Kernel and storage so
 * each is testable alone.
 */

/** How long a browser outlives its last CDP connection; Kernel then deletes it, which saves the profile. */
export const BROWSER_TIMEOUT_SECONDS = 600;

export const OWNER_ONLY =
  "This browser signs in as the thread's owner; only their turns can use it.";

/**
 * The person's Kernel profile, named from a hash of their WorkOS user id
 * (`sha256Hex`), so Kernel never sees an id or email.
 */
export const profileNameOf = (sha256Hex: string) => `sb-${sha256Hex.slice(0, 32)}`;

/**
 * Whether a turn may attach a profile: only its person's own turns. Today a
 * cloud turn's requester is the thread's owner (#245), and the profile is
 * always the owner object's own, never one the machine names.
 */
export const mayAttachProfile = (requester: string, profileOwner: string) =>
  requester === profileOwner;

/**
 * Whether a new session writes the profile back. Only one browser may safely
 * write a profile at a time, so it does when none of the person's open
 * sessions already does; the others load it read-only, and what changes in
 * them isn't kept. The person's object serializes opening, which makes this
 * the lock.
 */
export const writesProfile = (openSessions: ReadonlyArray<{ readonly writer: boolean }>) =>
  !openSessions.some((session) => session.writer);

/** Kernel's own words, with its code and status, so a plan's limit shows plainly. */
export const refusalFor = (error: KernelApiError) => {
  const details = [error.code, error.status > 0 ? `HTTP ${error.status}` : null].filter(
    (detail) => detail !== null,
  );
  const message = error.message.trim().replace(/\.$/, "");
  return `Kernel couldn't open a browser: ${message}${details.length > 0 ? ` (${details.join(", ")})` : ""}.`;
};

export const browserRequest = (input: {
  readonly profileName: string;
  readonly writer: boolean;
  readonly threadId: string;
}): KernelBrowserRequest => ({
  stealth: true,
  headless: true,
  timeout_seconds: BROWSER_TIMEOUT_SECONDS,
  profile: { name: input.profileName, save_changes: input.writer },
  // A thread starts with no tabs: the profile's last ones were another thread's.
  start_url: "about:blank",
  tags: { signalbox_thread: input.threadId },
});
