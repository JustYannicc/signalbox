// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect has no adapter for Workers' native Brotli duplex.
import * as NodeStream from "node:stream";
import * as NodeZlib from "node:zlib";

import { makeSecretScrubber, type SecretValue } from "@signalbox/runner-protocol/SecretScrubber";
import { egressRawTextSecrets, egressTextDecoder, scrubEgressText } from "./egress/egressText.ts";
import { scanSecretBytes } from "./egress/secretByteScan.ts";

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
const REPRESENTATION_HEADER_NAMES = new Set<string>(REPRESENTATION_HEADERS);

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

const looksLikeTextPrefix = (chunks: ReadonlyArray<Uint8Array>, complete: boolean) => {
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (const chunk of chunks) {
      if (hasBinaryControls(decoder.decode(chunk, { stream: true }))) return false;
    }
    // A code point may straddle the sniff limit; only EOF makes an unfinished one invalid.
    return !complete || !hasBinaryControls(decoder.decode());
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

            const isText = looksLikeTextPrefix(chunks, sourceDone);
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
              .pipeThrough(
                isText
                  ? scrubEgressText(scrubber, new TextDecoder("utf-8", { fatal: true }))
                  : scanSecretBytes(secrets),
              )
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
  const scrubber = makeSecretScrubber(secrets, { minLength: 1 });
  const headers = new Headers();
  let representationHeaderChanged = false;
  let contentTypeChanged = false;
  for (const [name, value] of response.headers) {
    const redacted = scrubber.text(value);
    const normalizedName = name.toLowerCase();
    if (redacted !== value) {
      if (REPRESENTATION_HEADER_NAMES.has(normalizedName) || normalizedName === "content-type") {
        representationHeaderChanged = true;
      }
      if (normalizedName === "content-type") contentTypeChanged = true;
    }
    headers.append(name, redacted);
  }
  if (response.body === null) {
    if (representationHeaderChanged) {
      for (const name of REPRESENTATION_HEADERS) headers.delete(name);
    }
    if (contentTypeChanged) headers.delete("content-type");
    return new Response(null, { status: response.status, headers });
  }

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

  const contentType = response.headers.get("content-type");
  const kind = bodyKind(contentType);
  let textDecoder: TextDecoder | null = null;
  if (kind === "text") {
    try {
      textDecoder = egressTextDecoder(contentType!);
    } catch {
      await response.body.cancel().catch(() => undefined);
      return refuse();
    }
  }
  const redactedBody = transformLazily(response.body, (original) => {
    let body = original;
    for (const encoding of encodings.toReversed()) {
      body = body.pipeThrough(makeContentDecoder(encoding));
    }
    if (textDecoder !== null) {
      const rawSecrets = egressRawTextSecrets(secrets, textDecoder);
      const inspected =
        rawSecrets.length > 0 ? body.pipeThrough(scanSecretBytes(rawSecrets)) : body;
      return inspected.pipeThrough(scrubEgressText(scrubber, textDecoder));
    }
    if (kind === "binary") return body.pipeThrough(scanSecretBytes(secrets));
    return sniffUnknownBody(body, scrubber, secrets);
  });
  const unchangedIdentityBinary = kind === "binary" && encodings.length === 0;
  if (!unchangedIdentityBinary || representationHeaderChanged) {
    for (const name of REPRESENTATION_HEADERS) headers.delete(name);
  }
  if (kind === "text") {
    const mime = contentTypeChanged ? "text/plain" : contentType!.split(";", 1)[0]!.trim();
    headers.set("content-type", `${mime}; charset=utf-8`);
  } else if (contentTypeChanged) headers.delete("content-type");
  return new Response(redactedBody, { status: response.status, headers });
}
