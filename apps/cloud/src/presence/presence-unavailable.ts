import { TaggedError as defineTaggedFailure } from "effect/Schema";

export class PresenceUnavailable extends defineTaggedFailure<PresenceUnavailable>()(
  "PresenceUnavailable",
  {},
) {
  override message = "Presence is unavailable.";
}
