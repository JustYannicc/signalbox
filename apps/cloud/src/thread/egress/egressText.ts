import type { SecretScrubber } from "@signalbox/runner-protocol/SecretScrubber";

/** Resolves the declared charset before any response bytes can be delivered. */
export const egressTextDecoder = (contentType: string) => {
  const parameters = contentType.split(";").slice(1);
  const charsets = parameters.filter((parameter) => /^\s*charset\b/i.test(parameter));
  if (charsets.length > 1) throw new Error("ambiguous text charset");
  let label = "utf-8";
  if (charsets.length === 1) {
    const parameter = /^\s*charset\s*=\s*(?:"([^"]*)"|([^"\s]+))\s*$/i.exec(charsets[0]!);
    if (parameter === null) throw new Error("invalid text charset");
    label = parameter[1] ?? parameter[2]!;
  }
  return new TextDecoder(label, { fatal: true });
};

/** Decodes incrementally, scrubs all nonempty values, and emits UTF-8 only. */
export const scrubEgressText = (scrubber: SecretScrubber, decoder: TextDecoder) => {
  const encoder = new TextEncoder();
  const scrubbing = scrubber.stream();
  const decode = (bytes?: Uint8Array) => {
    try {
      return bytes === undefined ? decoder.decode() : decoder.decode(bytes, { stream: true });
    } catch {
      throw new Error("Signalbox refused text it could not decode safely.");
    }
  };
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const output = scrubbing.feed(decode(chunk));
      if (output !== "") controller.enqueue(encoder.encode(output));
    },
    flush(controller) {
      const output = scrubbing.feed(decode()) + scrubbing.flush();
      if (output !== "") controller.enqueue(encoder.encode(output));
    },
  });
};
