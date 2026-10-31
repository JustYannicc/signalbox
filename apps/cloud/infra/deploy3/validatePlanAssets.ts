// @effect-diagnostics nodeBuiltinImport:off - The deployment adapter validates pinned local assets before any resource mutation.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { sha256 } from "../workerStartup/payload.ts";
import { validateQualifierFacetEnvironments } from "./qualification/validateFacetEnvironments.ts";
import { decodeConfiguration } from "./qualification/fixture/configuration.schema.ts";
import type { validateDeploy3Plan } from "./deploymentPlan.ts";

export async function validateDeploy3PlanAssets(plan: ReturnType<typeof validateDeploy3Plan>) {
  const bytes = await NodeFSP.readFile(
    NodePath.join(plan.assetsDirectory, "qualifier/config.json"),
  );
  if (sha256(bytes) !== plan.environment.CONFIG_SHA256)
    throw new Error("DEPLOY3_PLAN_CONFIGURATION_HASH_MISMATCH");
  return validateQualifierFacetEnvironments(
    plan.environment,
    decodeConfiguration(JSON.parse(bytes.toString("utf8"))),
  );
}
