import {
  getProviderAttachmentLimitError,
  isProviderSendTurnSupportedImageMimeType,
  type PersistChatAttachmentsInput,
  PersistChatAttachmentsError,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";

/** Validate the whole batch before writing any bytes. */
export const decodeLegacyImages = (input: PersistChatAttachmentsInput) =>
  Effect.gen(function* () {
    const limit = getProviderAttachmentLimitError(input.attachments);
    if (limit !== undefined) return yield* new PersistChatAttachmentsError({ message: limit });
    return yield* Effect.forEach(input.attachments, (attachment) =>
      Effect.gen(function* () {
        const invalid = () =>
          new PersistChatAttachmentsError({ message: "Invalid image payload." });
        const mimeType = attachment.mimeType.toLowerCase();
        if (
          !isProviderSendTurnSupportedImageMimeType(mimeType) ||
          !Number.isInteger(attachment.sizeBytes) ||
          attachment.sizeBytes < 1 ||
          attachment.sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
        )
          return yield* invalid();
        const comma = attachment.dataUrl.indexOf(",");
        // Only the short header is matched. A regex over megabytes can exhaust V8's stack.
        const header = attachment.dataUrl.slice(0, comma);
        if (comma < 0 || header.toLowerCase() !== `data:${mimeType};base64`) {
          return yield* invalid();
        }
        const payload = attachment.dataUrl.slice(comma + 1);
        if (payload.length > 4 * Math.ceil(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / 3)) {
          return yield* invalid();
        }
        const bytes = yield* Effect.fromResult(Base64.decode(payload)).pipe(
          Effect.mapError(invalid),
        );
        if (bytes.byteLength !== attachment.sizeBytes || Base64.encode(bytes) !== payload) {
          return yield* invalid();
        }
        return { attachment: { ...attachment, mimeType }, bytes };
      }),
    );
  });
