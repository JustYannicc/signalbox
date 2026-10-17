import { makeSecretScrubber, type SecretValue } from "@signalbox/runner-protocol/SecretScrubber";

/**
 * A model request with the turn's secrets scrubbed from its body (#591,
 * `SecretScrubber.ts`), as the provider gets it. The body still streams
 * through, holding back only what a split value could need. A compressed
 * body is decompressed first and forwarded plain. Anything the scrubber can't
 * read (an encoding the runtime can't decode, a body that isn't JSON or
 * text, a WebSocket upgrade) is refused rather than forwarded unread. Without
 * secrets the request goes on untouched.
 *
 * Only the body is scrubbed: the harness writes the URL and headers itself,
 * from the Runner's configuration, never from what a tool printed.
 */

export type ScrubbedRequest =
  | { readonly _tag: "scrubbed"; readonly request: Request }
  | { readonly _tag: "refused"; readonly reason: string };

/** What `DecompressionStream` reads, as `Content-Encoding` names it. */
const DECODABLE: ReadonlySet<string> = new Set(["gzip", "x-gzip", "deflate"]);

/** The bodies the harnesses send: JSON, or text. */
const isText = (contentType: string | null) =>
  contentType === null || /^\s*(application\/([\w.+-]*\+)?json|text\/)/i.test(contentType);

const refused = (reason: string): ScrubbedRequest => ({ _tag: "refused", reason });

export function scrubModelRequest(
  request: Request,
  secrets: ReadonlyArray<SecretValue>,
): ScrubbedRequest {
  const scrubber = makeSecretScrubber(secrets);
  if (scrubber.empty) return { _tag: "scrubbed", request };
  if (request.headers.has("upgrade")) {
    return refused("The ModelGateway can't hide this folder's secrets over a WebSocket. Use HTTP.");
  }
  if (request.body === null) return { _tag: "scrubbed", request };
  const encoding = (request.headers.get("content-encoding") ?? "").trim().toLowerCase();
  if (encoding !== "" && encoding !== "identity" && !DECODABLE.has(encoding)) {
    return refused(
      `The ModelGateway can't hide this folder's secrets in a ${encoding}-encoded request. Send it uncompressed.`,
    );
  }
  if (!isText(request.headers.get("content-type"))) {
    return refused("The ModelGateway can only hide this folder's secrets in a JSON or text body.");
  }
  const plain =
    encoding === "" || encoding === "identity"
      ? request.body
      : request.body.pipeThrough(
          new DecompressionStream(encoding === "deflate" ? "deflate" : "gzip"),
        );
  const headers = new Headers(request.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  const init: RequestInit & { readonly duplex: "half" } = {
    method: request.method,
    headers,
    body: plain.pipeThrough(scrubber.bytes()),
    redirect: "manual",
    duplex: "half",
  };
  return { _tag: "scrubbed", request: new Request(request.url, init) };
}
