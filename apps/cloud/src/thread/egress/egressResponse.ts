import { makeSecretScrubber, type SecretValue } from "@signalbox/runner-protocol/SecretScrubber";

/** A remote echo must not put resolved values back in files, logs or harness context. */
export async function redactEgressResponse(
  response: Response,
  secrets: ReadonlyArray<SecretValue>,
): Promise<Response> {
  const scrubber = makeSecretScrubber(secrets);
  const headers = new Headers();
  for (const [name, value] of response.headers) headers.append(name, scrubber.text(value));
  if (response.body === null) return new Response(null, { status: response.status, headers });
  const type = response.headers.get("content-type");
  const encoding = (response.headers.get("content-encoding") ?? "").trim().toLowerCase();
  const decodable = encoding === "gzip" || encoding === "x-gzip" || encoding === "deflate";
  if (
    (type !== null &&
      !/^\s*(text\/|application\/([\w.+-]*\+)?(json|xml|javascript|x-www-form-urlencoded))/i.test(
        type,
      )) ||
    (encoding !== "" && encoding !== "identity" && !decodable) ||
    response.status === 101
  ) {
    await response.body.cancel();
    return new Response(
      "Signalbox refused a secret-bearing response it cannot redact. Use an uncompressed UTF-8 text response.\n",
      {
        status: 403,
        headers: { "content-type": "text/plain; charset=utf-8", "x-signalbox-refused": "secret" },
      },
    );
  }
  const body = decodable
    ? response.body.pipeThrough(
        new DecompressionStream(encoding === "deflate" ? "deflate" : "gzip"),
      )
    : response.body;
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("etag");
  headers.delete("content-md5");
  return new Response(body.pipeThrough(scrubber.bytes()), { status: response.status, headers });
}
