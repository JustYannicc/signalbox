import * as Schema from "effect/Schema";
import { deploy3BootstrapIdentity, Deploy3UploadReceiptSchema } from "./expiry.ts";
import { isoAt } from "./platform.ts";
import { deploy3QualifierEnvironment } from "./qualifierEnvironment.ts";

export const Deploy3Plan = Schema.Struct({
  runId: Schema.String,
  owners: Schema.Array(Schema.Literals(["1070", "1255"])),
  startedAtUtc: Schema.String,
  main: Schema.String,
  assetsDirectory: Schema.String,
  compatibilityDate: Schema.String,
  compatibilityFlags: Schema.Array(Schema.String),
  vars: Schema.Record(Schema.String, Schema.String),
  receipt: Schema.optionalKey(Deploy3UploadReceiptSchema),
  registrationJson: Schema.optionalKey(Schema.String),
  operatorTokenId: Schema.optionalKey(Schema.String),
});

export function validateDeploy3Plan(plan: typeof Deploy3Plan.Type, stage: string) {
  if (
    !plan.owners.includes("1070") ||
    plan.owners.length > 2 ||
    new Set(plan.owners).size !== plan.owners.length
  )
    throw new Error("Deploy3 owners differ");
  if (stage !== plan.runId || !/^[a-f0-9]{8}$/.test(plan.runId))
    throw new Error("Deploy3 stage must equal its exact run ID");
  const startedAtMs = Date.parse(plan.startedAtUtc);
  if (
    !Number.isSafeInteger(startedAtMs) ||
    isoAt(startedAtMs) !== plan.startedAtUtc ||
    !plan.main.startsWith("/") ||
    !plan.assetsDirectory.startsWith("/") ||
    Object.keys(plan.vars).some((key) => key.startsWith("DEPLOY3_")) ||
    !/^[a-f0-9-]{36}$/.test(plan.vars.RUN_ID ?? "")
  )
    throw new Error("Invalid deploy3 plan");
  const identity = deploy3BootstrapIdentity(plan.runId, startedAtMs);
  if (plan.vars.WORKER_NAME !== identity.workerName)
    throw new Error("Deploy3 vars refer to another Worker");
  const environment = deploy3QualifierEnvironment(plan.vars);
  return { ...plan, startedAtMs, identity, environment };
}
