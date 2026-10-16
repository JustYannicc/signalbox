import {
  ENCODED_PLACEHOLDER,
  fillPlaceholders,
  makeSecretLookup,
  placeholderNames,
  secretsIn,
} from "@signalbox/runner-protocol/SecretPlaceholders";
import type { SecretValue } from "@signalbox/runner-protocol/SecretScrubber";

/**
 * One request leaving a thread's machine, read for the secrets it carries
 * (#592): every placeholder (`{{secret:NAME}}`, percent-encoded too) and every
 * value in a form the scrubber knows, in its URL, its headers (a Basic
 * credential decoded) and a text body. `request()` is what to send:
 * placeholders filled with values, the rest as it came. Pure: nothing here
 * decides whether it may go.
 *
 * Bodies are read when they are text (JSON, form, plain, XML) and no larger
 * than `MAX_READ_BODY`; anything else goes through unread, as it streams. A
 * program can always transform a value it holds past recognition before
 * sending it, so the check is exact for placeholders and best effort for
 * values a program read.
 */

/** Text bodies read for secrets, as Executor's handles do; larger ones go unread. */
export const MAX_READ_BODY = 1024 * 1024;

const TEXT_BODY =
  /^\s*(application\/(([\w.+-]*\+)?json|x-www-form-urlencoded|(([\w.+-]*\+)?xml)|graphql|javascript)|text\/)/i;
const FORM_BODY = /^\s*application\/x-www-form-urlencoded/i;

const BASIC = /^\s*basic\s+([A-Za-z0-9+/=]+)\s*$/i;

export interface EgressRequest {
  /** The host it goes to, with its port when that isn't the scheme's default. */
  readonly host: string;
  /** Whether it goes out encrypted: secrets only ever do. */
  readonly https: boolean;
  /** Secrets it carries, by placeholder or by value. */
  readonly secrets: ReadonlySet<string>;
  /** Placeholders naming no secret the thread has. */
  readonly unknown: ReadonlySet<string>;
  /** The request to send, its placeholders filled. Call once. */
  readonly request: () => Request;
}

/** Placeholders a URL encoder wrote, back as they were written. */
const decodedPlaceholders = (text: string) =>
  text.replace(ENCODED_PLACEHOLDER, (_, name: string) => `{{secret:${name}}}`);

/**
 * The body's bytes when it's text small enough to read, else a stream of all
 * of it, what was read put back in front: a body without a length is read
 * only up to the limit.
 */
const readBody = async (
  request: Request,
): Promise<
  | { readonly _tag: "read"; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly _tag: "unread"; readonly body: ReadableStream<Uint8Array> | null }
> => {
  if (request.body === null) return { _tag: "unread", body: null };
  const encoding = (request.headers.get("content-encoding") ?? "").trim().toLowerCase();
  const length = Number(request.headers.get("content-length") ?? Number.NaN);
  if (
    (encoding !== "" && encoding !== "identity") ||
    length > MAX_READ_BODY ||
    !TEXT_BODY.test(request.headers.get("content-type") ?? "text/plain")
  ) {
    return { _tag: "unread", body: request.body };
  }
  const reader = request.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  while (size <= MAX_READ_BODY) {
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
    chunks.push(value);
    size += value.byteLength;
  }
  // Too big to read: what was read, then the rest as it streams.
  const rest = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return { _tag: "unread", body: rest };
};

export async function readEgressRequest(
  request: Request,
  secretValues: ReadonlyArray<SecretValue>,
): Promise<EgressRequest> {
  const { scrubber, values } = makeSecretLookup(secretValues);
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
  let body: ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer> | string | null =
    read._tag === "unread" ? read.body : read.bytes;
  if (read._tag === "read") {
    let text: string | null = null;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
    } catch {
      text = null;
    }
    if (text !== null) {
      const form = FORM_BODY.test(headers.get("content-type") ?? "");
      const filled = form ? fill(decodedPlaceholders(text), urlValues) : fill(text);
      if (filled !== text) {
        body = filled;
        headers.delete("content-length");
      }
    }
  }

  return {
    host: url.host,
    https: url.protocol === "https:",
    secrets,
    unknown,
    request: () =>
      new Request(filledUrl, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? null : body,
        redirect: "manual",
        // A body that still streams goes on as it arrives.
        ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
      } as RequestInit),
  };
}
