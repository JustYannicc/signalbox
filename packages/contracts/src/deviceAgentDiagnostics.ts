import * as Schema from "effect/Schema";

import { DeviceHostId, DeviceId } from "./device.ts";
import { ThreadId } from "./baseSchemas.ts";

export const DeviceAgentCommandFailure = Schema.Struct({
  sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  threadId: ThreadId,
  hostId: DeviceHostId,
  deviceId: DeviceId,
  command: Schema.String.check(Schema.isMaxLength(64)),
  message: Schema.String.check(Schema.isMaxLength(2048)),
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  hint: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
  diagnosticId: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  logPath: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  occurredAt: Schema.String,
});
export type DeviceAgentCommandFailure = typeof DeviceAgentCommandFailure.Type;
