/**
 * Sentry envelope encoding for the feedback button: newline-separated item
 * headers and payloads. JSON items are newline-terminated; binary attachments
 * carry an explicit byte `length`, so their payloads may contain anything.
 * https://develop.sentry.dev/sdk/data-model/envelopes/
 */

export interface EnvelopeAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly data: Uint8Array;
}

export function buildFeedbackEnvelope(input: {
  readonly header: Record<string, unknown>;
  readonly event: Record<string, unknown>;
  readonly attachments: readonly EnvelopeAttachment[];
}): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [
    encoder.encode(
      `${JSON.stringify(input.header)}\n${JSON.stringify({ type: "feedback" })}\n${JSON.stringify(input.event)}\n`,
    ),
  ];
  for (const attachment of input.attachments) {
    const itemHeader = {
      type: "attachment",
      length: attachment.data.byteLength,
      filename: attachment.filename,
      content_type: attachment.contentType,
    };
    parts.push(encoder.encode(`${JSON.stringify(itemHeader)}\n`), attachment.data);
    parts.push(encoder.encode("\n"));
  }

  const envelope = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    envelope.set(part, offset);
    offset += part.byteLength;
  }
  return envelope;
}
