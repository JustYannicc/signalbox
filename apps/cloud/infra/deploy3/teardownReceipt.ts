import type { Deploy3CleanupResult } from "./cloudflare.ts";
import { parseDeploy3Name } from "./deadline.ts";

export type Deploy3Owner = "1070" | "1255";
export type TokenExpiryStatus = "expiry-configured" | "expired-verified" | "unverified";

export interface Deploy3PublicTeardownReceipt {
  readonly runId: string;
  readonly deadlineUtc: string;
  readonly resourcesDeleted: readonly string[];
  readonly ownersNotReleased: readonly Deploy3Owner[];
  readonly absenceVerified: boolean;
  readonly tokenExpiry: TokenExpiryStatus;
  readonly tokenExpiresOn: string | null;
  readonly evidence: "evidence not exported";
}

/** This is the entire public payload. Never serialize API responses, errors or run artifacts. */
export function deploy3PublicReceipt(input: {
  readonly cleanup: Deploy3CleanupResult;
  readonly ownersNotReleased: readonly Deploy3Owner[];
  readonly tokenExpiry: TokenExpiryStatus;
  readonly tokenExpiresOn: string | null;
  readonly registeredResources?: {
    readonly namespaceIds: readonly string[];
    readonly tailIds: readonly string[];
  };
}): Deploy3PublicTeardownReceipt {
  const parsed = parseDeploy3Name(input.cleanup.workerName);
  if (!parsed || !input.cleanup.deadlineUtc)
    throw new Error("Teardown receipt has no exact deployment identity");
  if (input.ownersNotReleased.some((owner) => owner !== "1070" && owner !== "1255")) {
    throw new Error("Teardown receipt has an unknown owner");
  }
  const resourcesDeleted: string[] = [];
  for (const check of input.cleanup.checks) {
    if (check.status !== "passed") continue;
    if (check.name === "delete-worker") {
      resourcesDeleted.push(`Worker ${input.cleanup.workerName}`, "Worker-managed static assets");
    } else if (/^delete-tail:[A-Za-z0-9_-]{1,200}$/.test(check.name)) {
      resourcesDeleted.push(`Tail ${check.name.slice("delete-tail:".length)}`);
    } else if (check.name === "verify-namespace-absence") {
      resourcesDeleted.push("Worker-owned Durable Object namespaces absent");
    }
  }
  if (
    input.cleanup.cleanClaim &&
    input.registeredResources &&
    input.cleanup.checks.some((row) => row.name === "already-absent" && row.status === "passed")
  ) {
    resourcesDeleted.push(
      `Worker ${input.cleanup.workerName} absent`,
      "Worker-managed static assets absent",
    );
    for (const id of input.registeredResources.namespaceIds) {
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(id))
        throw new Error("Invalid registered namespace receipt identity");
      resourcesDeleted.push(`Durable Object namespace ${id} absent`);
    }
    for (const id of input.registeredResources.tailIds) {
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(id))
        throw new Error("Invalid registered Tail receipt identity");
      resourcesDeleted.push(`Tail ${id} absent`);
    }
  }
  return {
    runId: parsed.runId,
    deadlineUtc: input.cleanup.deadlineUtc,
    resourcesDeleted,
    ownersNotReleased: [...new Set(input.ownersNotReleased)].sort(),
    absenceVerified: input.cleanup.cleanClaim,
    tokenExpiry: input.tokenExpiry,
    tokenExpiresOn: input.tokenExpiresOn,
    evidence: "evidence not exported",
  };
}

export function formatDeploy3PublicReceipt(receipt: Deploy3PublicTeardownReceipt) {
  return [
    `Deploy #3 teardown, run ${receipt.runId}, deadline ${receipt.deadlineUtc}.`,
    `Resources: ${receipt.resourcesDeleted.join(", ") || "none verified deleted"}.`,
    `Absence verified: ${receipt.absenceVerified ? "yes" : "no"}.`,
    `Owners not released: ${receipt.ownersNotReleased.map((owner) => `#${owner}`).join(", ") || "none"}.`,
    `Token expiry: ${receipt.tokenExpiry}${receipt.tokenExpiresOn ? `, ${receipt.tokenExpiresOn}` : ""}.`,
    "evidence not exported",
  ].join("\n");
}
