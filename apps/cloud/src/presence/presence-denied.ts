import { TaggedError as defineTaggedFailure } from "effect/Schema";

export class PresenceDenied extends defineTaggedFailure<PresenceDenied>()("PresenceDenied", {}) {
  override message = "Presence is unavailable.";
}
