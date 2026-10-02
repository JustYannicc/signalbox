import { APP_VERSION } from "../../../branding";
import { isElectron } from "../../../env";
import { buildFeedbackEnvelope, type EnvelopeAttachment } from "./feedbackEnvelope";

/**
 * Sends user feedback to Sentry as a `feedback` envelope item, with the
 * optional screenshot and logs as attachments in the same envelope (Sentry
 * links attachments to the feedback by the shared event id). Talks to the
 * ingest endpoint directly instead of pulling in the Sentry SDK: feedback is
 * the only thing this fork reports, and the SDK would cost every page load.
 *
 * The DSN comes from `VITE_T3CODE_FEEDBACK_DSN` (repo `.env`); without it the
 * button reports that feedback is not configured.
 */
export const FEEDBACK_DSN = import.meta.env.VITE_T3CODE_FEEDBACK_DSN?.trim() || null;

interface ParsedDsn {
  readonly envelopeUrl: string;
  readonly dsn: string;
}

function parseDsn(dsn: string): ParsedDsn | null {
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace(/^\/+/, "");
    if (!url.username || !projectId) return null;
    const query = new URLSearchParams({ sentry_key: url.username, sentry_version: "7" });
    return {
      dsn,
      envelopeUrl: `${url.protocol}//${url.host}/api/${projectId}/envelope/?${query}`,
    };
  } catch {
    return null;
  }
}

function randomEventId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export interface FeedbackSubmission {
  readonly message: string;
  readonly screenshot: Blob | null;
  readonly logs: string | null;
}

export async function sendFeedback(submission: FeedbackSubmission): Promise<void> {
  const parsed = FEEDBACK_DSN ? parseDsn(FEEDBACK_DSN) : null;
  if (!parsed) throw new Error("Feedback isn't configured (VITE_T3CODE_FEEDBACK_DSN).");

  const eventId = randomEventId();
  const now = new Date();
  const event = {
    event_id: eventId,
    type: "feedback",
    timestamp: now.getTime() / 1000,
    platform: "javascript",
    level: "info",
    release: `t3code-fork@${APP_VERSION}`,
    environment: import.meta.env.MODE,
    request: { url: window.location.href, headers: { "User-Agent": navigator.userAgent } },
    tags: { surface: isElectron ? "desktop" : "web" },
    contexts: {
      feedback: {
        message: submission.message,
        url: window.location.href,
        source: "sidebar-rail",
      },
      app: {
        viewport: `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio}x`,
        locale: navigator.language,
      },
    },
  };

  const attachments: EnvelopeAttachment[] = [];
  if (submission.screenshot) {
    attachments.push({
      filename: "screenshot.png",
      contentType: "image/png",
      data: new Uint8Array(await submission.screenshot.arrayBuffer()),
    });
  }
  if (submission.logs !== null) {
    attachments.push({
      filename: "logs.txt",
      contentType: "text/plain",
      data: new TextEncoder().encode(submission.logs),
    });
  }
  const envelope = buildFeedbackEnvelope({
    header: { event_id: eventId, sent_at: now.toISOString(), dsn: parsed.dsn },
    event,
    attachments,
  });

  // No Content-Type: a bare binary body keeps this a simple CORS request, which
  // is how Sentry's own fetch transport posts envelopes.
  const response = await fetch(parsed.envelopeUrl, { method: "POST", body: envelope });
  if (!response.ok) throw new Error(`Sentry rejected the feedback (${response.status}).`);
}
