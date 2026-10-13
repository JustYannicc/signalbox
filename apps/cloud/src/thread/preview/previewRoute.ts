import { type ThreadObjectNamespace, threadObjectStub } from "../ThreadDirectory.ts";
import { PREVIEW_COOKIE, PREVIEW_TICKET_PATH, readCookie } from "./previewHost.ts";
import { threadOfPreviewToken } from "./previewToken.ts";

/**
 * The Worker's half of the PreviewGateway: a request to a preview origin goes
 * to the thread its credential names (the link's ticket, or the origin's
 * cookie). Nothing here authenticates; the thread checks the credential, its
 * user and its machine (`PreviewGateway.serve`).
 */
export function routePreview(
  threads: ThreadObjectNamespace,
  request: Request,
  options: { readonly localWorkerd: boolean },
): Promise<Response> | Response {
  const url = new URL(request.url);
  const credential =
    (url.pathname === PREVIEW_TICKET_PATH ? url.searchParams.get("ticket") : null) ??
    readCookie(request.headers.get("cookie"), PREVIEW_COOKIE);
  const threadId = credential === null ? null : threadOfPreviewToken(credential);
  if (threadId === null) {
    return new Response("Open this preview from its thread in Signalbox.", {
      status: 401,
      headers: { "cache-control": "no-store" },
    });
  }
  return threadObjectStub(threads, threadId, options).fetch(request);
}
