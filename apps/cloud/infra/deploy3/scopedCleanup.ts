import { listDeploy3Tails } from "./cloudflareApi.ts";
import { createDeploy3CloudflareApi } from "./cloudflareTransport.ts";
import type { Deploy3CleanupResult } from "./cloudflare.ts";
import type { Deploy3ControlRegistration } from "./controlRegistry.ts";
import { decodeControlEvent } from "./controlRegistry.ts";
import { verifyDeploy3TokenExpiry } from "./tokenExpiry.ts";

/** A single-Worker credential never needs account-wide inventories to issue the deadline deletion. */
export async function cleanupDeploy3WithScopedToken(input: {
  readonly registration: Deploy3ControlRegistration;
  readonly deadlineUtc: string;
  readonly cleanupTokenExpiresOn: string;
  readonly accountId: string;
  readonly token: string;
  readonly nowMs: number;
  readonly fetchImpl?: typeof fetch;
}): Promise<Deploy3CleanupResult> {
  decodeControlEvent(input.registration);
  const { workerName } = input.registration;
  const checks: { name: string; status: "passed" | "failed" }[] = [];
  const failures: string[] = [];
  const result = (status: Deploy3CleanupResult["status"]): Deploy3CleanupResult => ({
    schema: "sb1070/deploy3-cloud-cleanup/v1",
    status,
    cleanClaim: false,
    workerName,
    runId: input.registration.runId,
    deadlineUtc: input.deadlineUtc,
    checks,
    failures,
    assets: "worker-script-managed",
    externalBindingsPreserved: [],
  });
  if (!Number.isSafeInteger(input.nowMs) || !Number.isSafeInteger(Date.parse(input.deadlineUtc))) {
    failures.push("invalid-deadline-clock");
    return result("refused");
  }
  if (input.nowMs < Date.parse(input.deadlineUtc)) return result("not-due");
  const expiry = await verifyDeploy3TokenExpiry({
    accountId: input.accountId,
    authorityToken: input.token,
    tokenId: input.registration.cleanupTokenId,
    expectedExpiresOn: input.cleanupTokenExpiresOn,
    nowMs: input.nowMs,
    mode: "self",
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  if (expiry.status !== "expiry-configured") {
    failures.push("scoped-token-identity-or-expiry-unverified");
    return result("refused");
  }
  // Cloudflare enforces this token's immutable Worker resource policy even if the name is reused.
  const api = createDeploy3CloudflareApi({
    accountId: input.accountId,
    token: input.token,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  let tails: readonly string[] = input.registration.tailIds;
  try {
    tails = [
      ...new Set([
        ...tails,
        ...(await listDeploy3Tails(api, workerName)).map((row) => String(row.id)),
      ]),
    ];
  } catch {
    failures.push("scoped-tail-inventory-unverified");
  }
  for (const tail of tails) {
    try {
      await api.request(
        `delete-tail-${tail}`,
        "DELETE",
        `/workers/scripts/${workerName}/tails/${encodeURIComponent(tail)}`,
        true,
      );
      checks.push({ name: `delete-tail:${tail}`, status: "passed" });
    } catch {
      checks.push({ name: `delete-tail:${tail}`, status: "failed" });
      failures.push("delete-tail");
    }
  }
  try {
    await api.request("delete-worker", "DELETE", `/workers/scripts/${workerName}`, true);
    checks.push({ name: "delete-worker", status: "passed" });
  } catch {
    checks.push({ name: "delete-worker", status: "failed" });
    failures.push("delete-worker");
  }
  // The independent CI token verifies account-wide namespace absence after this Worker can no longer execute.
  failures.push("backstop-absence-verification-required");
  return result("failed-or-uncertain");
}
