/**
 * Sends rail feedback to our Sentry project through the Sentry browser SDK,
 * which also runs in the desktop renderer. The SDK is imported on the first
 * send, so page loads don't pay for it, and it starts with no default
 * integrations: feedback is the only thing reported, never errors, console
 * output, or navigation.
 *
 * The DSN comes from `VITE_T3CODE_FEEDBACK_DSN` at build time (repo `.env`);
 * without it the button explains that feedback isn't set up.
 */
import { readAccountSession } from "../../../account/accountSession";
import { APP_STAGE_LABEL, APP_VERSION } from "../../../branding";
import { isElectron } from "../../../env";

export const FEEDBACK_DSN = import.meta.env.VITE_T3CODE_FEEDBACK_DSN?.trim() || null;

const CHANNEL_BY_STAGE: Record<typeof APP_STAGE_LABEL, "stable" | "nightly" | "dev"> = {
  Alpha: "stable",
  Latest: "stable",
  Nightly: "nightly",
  Dev: "dev",
};

type SentryBrowser = typeof import("@sentry/browser");
let sentry: Promise<SentryBrowser> | null = null;

function loadSentry(dsn: string): Promise<SentryBrowser> {
  sentry ??= import("@sentry/browser").then(
    (Sentry) => {
      Sentry.init({
        dsn,
        release: `signalbox@${APP_VERSION}`,
        environment: import.meta.env.MODE,
        defaultIntegrations: false,
        initialScope: {
          tags: {
            channel: CHANNEL_BY_STAGE[APP_STAGE_LABEL],
            surface: isElectron ? "desktop" : "web",
          },
        },
      });
      return Sentry;
    },
    (error: unknown) => {
      // A failed chunk load shouldn't stick; the next send retries.
      sentry = null;
      throw error;
    },
  );
  return sentry;
}

/** Starts loading the SDK early (on popover open) so Send doesn't wait for it. */
export function preloadFeedbackSdk(): void {
  if (FEEDBACK_DSN) loadSentry(FEEDBACK_DSN).catch(() => {});
}

interface FeedbackSubmission {
  readonly message: string;
  readonly screenshot: Blob | null;
  readonly serverLogs: string | null;
}

export async function sendFeedback(submission: FeedbackSubmission): Promise<void> {
  if (!FEEDBACK_DSN) throw new Error("Feedback isn't set up on this build.");
  const Sentry = await loadSentry(FEEDBACK_DSN);

  // Read per send: signing in or out reloads the page, but cheap to be exact.
  const account = readAccountSession()?.account ?? null;
  Sentry.setUser(account ? { id: account.id, email: account.email } : null);

  const attachments = [];
  if (submission.screenshot) {
    attachments.push({
      filename: "screenshot.png",
      contentType: "image/png",
      data: new Uint8Array(await submission.screenshot.arrayBuffer()),
    });
  }
  if (submission.serverLogs !== null) {
    attachments.push({
      filename: "server-logs.txt",
      contentType: "text/plain",
      data: submission.serverLogs,
    });
  }

  const name = account ? [account.firstName, account.lastName].filter(Boolean).join(" ") : "";
  await Sentry.sendFeedback(
    {
      message: submission.message,
      source: "sidebar-rail",
      ...(account ? { email: account.email } : {}),
      ...(name ? { name } : {}),
    },
    {
      attachments,
      includeReplay: false,
      errorMessages: {
        ERROR_TIMEOUT: "Sentry didn't answer in time.",
        ERROR_FORBIDDEN: "Sentry rejected the feedback.",
        ERROR_GENERIC: "Couldn't reach Sentry. An ad blocker may be in the way.",
      },
    },
  );
}
