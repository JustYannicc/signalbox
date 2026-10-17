import {
  ENCODED_PLACEHOLDER,
  fillPlaceholders,
  makeSecretLookup,
  placeholderNames,
  secretsIn,
} from "@signalbox/runner-protocol/SecretPlaceholders";
import { secretForms, type SecretValue } from "@signalbox/runner-protocol/SecretScrubber";

/** Reads the entire request before any byte may leave the machine's egress broker. */
export const MAX_READ_BODY = 1024 * 1024;

const TEXT_BODY =
  /^\s*(application\/(([\w.+-]*\+)?json|x-www-form-urlencoded|(([\w.+-]*\+)?xml)|graphql|javascript)|text\/)/i;
// Git clone/fetch sends UTF-8 packet metadata; this does not admit binary Git push packs.
const GIT_FETCH_BODY = /^\s*application\/x-git-upload-pack-request\s*(?:;|$)/i;
const FORM_BODY = /^\s*application\/x-www-form-urlencoded/i;

const BASIC = /^\s*basic\s+([A-Za-z0-9+/=]+)\s*$/i;

export interface EgressRequest {
  /** The host it goes to, with its port when that isn't the scheme's default. */
  readonly host: string;
  /** An uninspectable request is never forwarded while the thread has secrets. */
  readonly refusal: string | null;
  /** Whether it goes out encrypted: secrets only ever do. */
  readonly https: boolean;
  /** Secrets it carries, by placeholder or by value. */
  readonly secrets: ReadonlySet<string>;
  /** Placeholders naming no secret the thread has. */
  readonly unknown: ReadonlySet<string>;
  /** The request to send, its placeholders filled. Call once. */
  readonly request: () => Request;
  /** Buffered, unresolved request for a fresh registration after approval. */
  readonly original: () => Request;
}

/** Placeholders a URL encoder wrote, back as they were written. */
const decodedPlaceholders = (text: string) =>
  text.replace(ENCODED_PLACEHOLDER, (_, name: string) => `{{secret:${name}}}`);

/** Both compressed Git metadata and its decoded form must fit the inspection limit. */
const readBytes = async (
  stream: ReadableStream<Uint8Array>,
): Promise<
  | { readonly _tag: "read"; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly _tag: "refused"; readonly reason: string }
> => {
  const reader = stream.getReader();
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return { _tag: "read", bytes };
      }
      size += value.byteLength;
      if (size > MAX_READ_BODY) {
        await reader.cancel();
        return {
          _tag: "refused",
          reason:
            "This thread has secrets, so an outbound body larger than 1 MiB cannot be sent unchecked.",
        };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
};

/** Git fetch may compress its UTF-8 negotiation. Binary pack uploads remain refused. */
const readBody = async (
  request: Request,
): Promise<
  | {
      readonly _tag: "read";
      readonly bytes: Uint8Array<ArrayBuffer>;
      readonly inspection: Uint8Array<ArrayBuffer>;
    }
  | { readonly _tag: "refused"; readonly reason: string }
> => {
  if (request.body === null) {
    const bytes = new Uint8Array();
    return { _tag: "read", bytes, inspection: bytes };
  }
  const encoding = (request.headers.get("content-encoding") ?? "").trim().toLowerCase();
  const compression =
    encoding === "gzip" || encoding === "x-gzip"
      ? "gzip"
      : encoding === "deflate"
        ? "deflate"
        : null;
  const length = Number(request.headers.get("content-length") ?? Number.NaN);
  const type = request.headers.get("content-type") ?? "text/plain";
  const git = GIT_FETCH_BODY.test(type);
  if (
    (encoding !== "" && encoding !== "identity" && (!git || compression === null)) ||
    length > MAX_READ_BODY ||
    (!TEXT_BODY.test(type) && !git)
  ) {
    await request.body.cancel();
    return {
      _tag: "refused",
      reason:
        "This thread has secrets, so outbound bodies must be inspectable UTF-8 text no larger than 1 MiB. Only Git fetch metadata may use HTTP compression.",
    };
  }
  const read = await readBytes(request.body);
  if (read._tag === "refused") return read;
  if (compression === null) return { ...read, inspection: read.bytes };
  try {
    const decoded = await readBytes(
      new Blob([read.bytes]).stream().pipeThrough(new DecompressionStream(compression)),
    );
    return decoded._tag === "refused" ? decoded : { ...read, inspection: decoded.bytes };
  } catch {
    return { _tag: "refused", reason: "This Git request could not be decompressed safely." };
  }
};

export async function readEgressRequest(
  request: Request,
  secretValues: ReadonlyArray<SecretValue>,
  redactions: ReadonlyArray<SecretValue> = secretValues,
): Promise<EgressRequest> {
  const { values } = makeSecretLookup(secretValues);
  const { scrubber } = makeSecretLookup(redactions);
  const urlValues = new Map([...values].map(([name, value]) => [name, encodeURIComponent(value)]));
  const secrets = new Set<string>();
  const unknown = new Set<string>();
  /** Notes what `text` carries and answers it filled with `filling`. */
  const fill = (text: string, filling: ReadonlyMap<string, string> = values) => {
    for (const name of secretsIn(text, scrubber)) {
      if (values.has(name)) secrets.add(name);
      else unknown.add(name);
    }
    return fillPlaceholders(text, filling).text;
  };

  const url = new URL(request.url);
  const filledUrl = fill(decodedPlaceholders(request.url), urlValues);
  const rawAuthority = request.url.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/)?.[1] ?? "";
  const destination = `${rawAuthority}\n${url.username}\n${url.password}\n${url.host}`;
  const destinationSecrets = new Set(secretsIn(destination, scrubber));
  // Hostnames are case-insensitive, so URL parsing lowercases encoded forms too.
  const foldedDestination = destination.toLowerCase();
  for (const { name, value } of redactions) {
    if (secretForms(value).some((form) => foldedDestination.includes(form.toLowerCase()))) {
      destinationSecrets.add(name);
    }
  }

  const headers = new Headers();
  for (const [name, value] of request.headers) {
    const basic = name === "authorization" ? BASIC.exec(value) : null;
    if (basic !== null) {
      let decoded: string | null = null;
      try {
        decoded = atob(basic[1]!);
      } catch {
        decoded = null;
      }
      if (decoded !== null && placeholderNames(decoded).size > 0) {
        headers.set(name, `Basic ${btoa(fill(decoded))}`);
        continue;
      }
    }
    headers.append(name, fill(value));
  }

  const read = await readBody(request);
  let refusal = read._tag === "refused" ? read.reason : null;
  let body: Uint8Array<ArrayBuffer> | string | null =
    read._tag === "read" && request.body !== null ? read.bytes : null;
  if (read._tag === "read") {
    let text: string | null = null;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(read.inspection);
    } catch {
      refusal = "This thread has secrets, so a body that is not UTF-8 cannot be sent unchecked.";
      text = null;
    }
    if (text !== null) {
      const form = FORM_BODY.test(headers.get("content-type") ?? "");
      const filled = form ? fill(decodedPlaceholders(text), urlValues) : fill(text);
      if (filled !== text) {
        body = filled;
        headers.delete("content-length");
        headers.delete("content-encoding");
      }
    }
  }

  return {
    host: url.host,
    refusal:
      destinationSecrets.size > 0
        ? "A secret cannot appear in the request destination."
        : new URL(filledUrl).origin !== url.origin
          ? "A secret cannot change the request destination."
          : refusal,
    https: url.protocol === "https:",
    secrets,
    unknown,
    original: () =>
      new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body:
          request.method === "GET" || request.method === "HEAD" || read._tag === "refused"
            ? null
            : read.bytes,
      }),
    request: () =>
      new Request(filledUrl, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? null : body,
        redirect: "manual",
      } as RequestInit),
  };
}
