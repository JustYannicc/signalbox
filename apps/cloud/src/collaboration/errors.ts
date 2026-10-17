import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export class CollaborationError extends Schema.TaggedError<CollaborationError>()(
  "CollaborationError",
  {
    code: OrchestratorMcpFailure.fields.code,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}
