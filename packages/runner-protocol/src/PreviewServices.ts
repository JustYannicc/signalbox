import { PortSchema, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** A non-empty path inside the thread's drive checkout. */
export const PreviewServiceCwd = Schema.String.check(
  Schema.isPattern(/^(?!$)(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$)).*$/),
);

/** A dev server an agent explicitly asked the Runner to keep available. */
export const PreviewService = Schema.Struct({
  port: PortSchema,
  command: TrimmedNonEmptyString,
  cwd: PreviewServiceCwd,
});
export type PreviewService = typeof PreviewService.Type;
