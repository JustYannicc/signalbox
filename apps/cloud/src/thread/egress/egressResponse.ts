// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect has no adapter for Workers' native Brotli duplex.
import * as NodeStream from "node:stream";
import * as NodeZlib from "node:zlib";

import { makeSecretScrubber, type SecretValue } from "@signalbox/runner-protocol/SecretScrubber";
import { scanSecretBytes } from "./secretByteScan.ts";

const UNKNOWN_TYPE_SNIFF_BYTES = 64 * 1024;
const TEXT_CONTENT_TYPE =
  /^\s*(text\/|application\/([\w.+-]*\+)?(json|xml|javascript|x-www-form-urlencoded))/i;
const BINARY_APPLICATION_TYPES = new Set([
  "application/gzip",
  "application/pdf",
  "application/vnd.rar",
  "application/wasm",
  "application/x-7z-compressed",
  "application/x-bzip",
  "application/x-bzip2",
  "application/x-gzip",
  "application/x-iso9660-image",
  "application/x-rar-compressed",
  "application/x-tar",
  "application/x-zip-compressed",
  "application/zip",
  "application/octet-stream",
]);
const CONTENT_DECODERS: Readonly<Record<string, string>> = {
  br: "brotli",
  deflate: "deflate",
  gzip: "gzip",
  "x-gzip": "gzip",
};

const makeContentDecoder = (encoding: string) => {
  if (encoding !== "br") {
    return new DecompressionStream(CONTENT_DECODERS[encoding]! as CompressionFormat);
  }
  // Workers' DecompressionStream lacks Brotli. nodejs_compat emits byte streams,
  // but Node and Workers declare incompatible BYOB reader types for the same API.
  return NodeStream.Duplex.toWeb(
    NodeZlib.createBrotliDecompress(),
  ) as unknown as ReadableWritablePair<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
};
const REPRESENTATION_HEADERS = [
  "accept-ranges",
  "content-digest",
  "content-encoding",
  "content-length",
  "content-md5",
  "content-range",
  "digest",
  "etag",
  "repr-digest",
] as const;

const refuse = () =>
  new Response("Signalbox refused a response it could not inspect safely.\n", {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8", "x-signalbox-refused": "secret" },
  });

const bodyKind = (contentType: string | null): "binary" | "text" | "unknown" => {
  if (contentType === null) return "unknown";
  const mime = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (TEXT_CONTENT_TYPE.test(mime)) return "text";
  if (
    /^(image|audio|video|font)\//.test(mime) ||
    BINARY_APPLICATION_TYPES.has(mime) ||
    mime.startsWith("application/x-git-") ||
    mime.startsWith("application/vnd.")
  ) {
    return "binary";
  }
  return "unknown";
};

const hasBinaryControls = (text: string) => {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
    if (code >= 0x7f && code <= 0x9f) return true;
  }
  return false;
};

const looksLikeSmallText = (chunks: ReadonlyArray<Uint8Array>) => {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return !hasBinaryControls(text);
  } catch {
    return false;
  }
};

const transformLazily = (
  source: ReadableStream<Uint8Array<ArrayBuffer>>,
  transform: (source: ReadableStream<Uint8Array<ArrayBuffer>>) => ReadableStream<Uint8Array>,
) => {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          reader ??= transform(source).getReader();
          const item = await reader.read();
          if (item.done) controller.close();
          else controller.enqueue(item.value);
        } catch (cause) {
          controller.error(cause);
        }
      },
      cancel(reason) {
        return reader === null ? source.cancel(reason) : reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
};

const sniffUnknownBody = (
  body: ReadableStream<Uint8Array>,
  scrubber: ReturnType<typeof makeSecretScrubber>,
  secrets: ReadonlyArray<SecretValue>,
) => {
  const sourceReader = body.getReader();
  let transformedReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (transformedReader === null) {
          const chunks: Array<Uint8Array> = [];
          let sniffedBytes = 0;
          let sourceDone = false;
          let overflow: Uint8Array | null = null;

          try {
            while (sniffedBytes < UNKNOWN_TYPE_SNIFF_BYTES) {
              const item = await sourceReader.read();
              if (item.done) {
                sourceDone = true;
                break;
              }
              if (item.value.length === 0) continue;
              const remaining = UNKNOWN_TYPE_SNIFF_BYTES - sniffedBytes;
              if (item.value.length > remaining) {
                chunks.push(item.value.subarray(0, remaining));
                overflow = item.value.subarray(remaining);
                sniffedBytes = UNKNOWN_TYPE_SNIFF_BYTES;
                break;
              }
              chunks.push(item.value);
              sniffedBytes += item.value.length;
            }

            const isSmallText =
              sourceDone && sniffedBytes < UNKNOWN_TYPE_SNIFF_BYTES && looksLikeSmallText(chunks);
            const prefixAndSource = new ReadableStream<Uint8Array>({
              start(controller) {
                for (const chunk of chunks) controller.enqueue(chunk);
                if (overflow !== null && overflow.length > 0) controller.enqueue(overflow);
                if (sourceDone) controller.close();
              },
              async pull(controller) {
                const item = await sourceReader.read();
                if (item.done) controller.close();
                else controller.enqueue(item.value);
              },
              cancel(reason) {
                return sourceReader.cancel(reason);
              },
            });
            transformedReader = prefixAndSource
              .pipeThrough(isSmallText ? scrubber.bytes() : scanSecretBytes(secrets))
              .getReader();
          } catch (cause) {
            controller.error(cause);
            return;
          }
        }

        try {
          const item = await transformedReader.read();
          if (item.done) controller.close();
          else controller.enqueue(item.value);
        } catch (cause) {
          controller.error(cause);
        }
      },
      cancel(reason) {
        return transformedReader === null
          ? sourceReader.cancel(reason)
          : transformedReader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
};

/** A remote echo must not put resolved values back in files, logs or harness context. */
export async function redactEgressResponse(
  response: Response,
  secrets: ReadonlyArray<SecretValue>,
): Promise<Response> {
  const scrubber = makeSecretScrubber(secrets);
  const headers = new Headers();
  for (const [name, value] of response.headers) headers.append(name, scrubber.text(value));
  if (response.body === null) return new Response(null, { status: response.status, headers });

  const encodings = (response.headers.get("content-encoding") ?? "")
    .split(",")
    .map((encoding) => encoding.trim().toLowerCase())
    .filter((encoding) => encoding !== "" && encoding !== "identity");
  try {
    for (const encoding of encodings.toReversed()) {
      const format = CONTENT_DECODERS[encoding];
      if (format === undefined) throw new Error("unsupported content encoding");
    }
  } catch {
    await response.body.cancel().catch(() => undefined);
    return refuse();
  }

  const kind = bodyKind(response.headers.get("content-type"));
  const redactedBody = transformLazily(response.body, (original) => {
    let body = original;
    for (const encoding of encodings.toReversed()) {
      body = body.pipeThrough(makeContentDecoder(encoding));
    }
    if (kind === "text") return body.pipeThrough(scrubber.bytes());
    if (kind === "binary") return body.pipeThrough(scanSecretBytes(secrets));
    return sniffUnknownBody(body, scrubber, secrets);
  });
  for (const name of REPRESENTATION_HEADERS) headers.delete(name);
  return new Response(redactedBody, { status: response.status, headers });
}
