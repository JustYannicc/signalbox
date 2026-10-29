import * as Schema from "effect/Schema";
import { isoAt } from "./platform.ts";
import { createDeploy3Name, parseDeploy3Name } from "./deadline.ts";

export const DEPLOY3_LIFETIME_MS = 24 * 60 * 60 * 1_000;
export const DEPLOY3_TOKEN_GRACE_MS = 2 * 60 * 60 * 1_000;

// Observed through the account token permission catalog, not the legacy account-wide role.
export const INDIVIDUAL_WORKER_ADMIN = "1ef41180fdf74cf7b67415d2708167ac";

export const Deploy3WrittenExtensionSchema = Schema.Struct({
  coordinatorThreadId: Schema.String,
  sourceMessageId: Schema.String,
  fullText: Schema.String,
  deadlineUtc: Schema.String,
});
export const encodeDeploy3ExtensionJson = Schema.encodeSync(
  Schema.fromJsonString(Deploy3WrittenExtensionSchema),
);
export const Deploy3UploadReceiptSchema = Schema.Struct({
  workerName: Schema.String,
  workerId: Schema.String,
  receivedAtUtc: Schema.String,
  responseSha256: Schema.String,
  bundleSha256: Schema.String,
  extension: Schema.optionalKey(Deploy3WrittenExtensionSchema),
});
export type Deploy3UploadReceipt = typeof Deploy3UploadReceiptSchema.Type;

export const decodeDeploy3Receipt = (value: Deploy3UploadReceipt | string) =>
  typeof value === "string" ? decodeDeploy3UploadReceiptJson(value) : value;

const decodeDeploy3UploadReceiptJson = Schema.decodeSync(
  Schema.fromJsonString(Deploy3UploadReceiptSchema),
);

function utc(value: string): number {
  const time = Date.parse(value);
  if (!Number.isSafeInteger(time) || isoAt(time) !== value) {
    throw new Error("Deploy3 receipt needs a canonical UTC timestamp");
  }
  return time;
}

export function deploy3Expiry(receipt: Deploy3UploadReceipt) {
  const parsed = parseDeploy3Name(receipt.workerName);
  if (
    parsed?.role !== "workload" ||
    !/^[a-f0-9]{32}$/.test(receipt.workerId) ||
    !/^[a-f0-9]{64}$/.test(receipt.responseSha256) ||
    !/^[a-f0-9]{64}$/.test(receipt.bundleSha256)
  )
    throw new Error("Deploy3 upload receipt identity is invalid");
  const deployedAtMs = utc(receipt.receivedAtUtc);
  const originalDeadlineMs = deployedAtMs + DEPLOY3_LIFETIME_MS;
  // The initial name provides a backstop even if the operator dies before arming.
  if (parsed.deadlineMs > Math.ceil(originalDeadlineMs / 1_000) * 1_000) {
    throw new Error("Deploy3 name postpones the receipt-bound deadline");
  }
  let deadlineMs = originalDeadlineMs;
  if (receipt.extension) {
    const extension = receipt.extension;
    if (
      extension.coordinatorThreadId !== "mcp:ba538951-e7df-4b6b-b0d2-53a5dcd22bac" ||
      !extension.sourceMessageId.startsWith("message:") ||
      extension.fullText.trim().length === 0 ||
      utc(extension.deadlineUtc) <= originalDeadlineMs
    )
      throw new Error(
        "Deploy3 extension needs the coordinator's written authority and a later deadline",
      );
    deadlineMs = utc(extension.deadlineUtc);
  }
  return {
    deployedAtUtc: receipt.receivedAtUtc,
    originalDeadlineUtc: isoAt(originalDeadlineMs),
    deadlineMs,
    deadlineUtc: isoAt(deadlineMs),
    deadlineTag: `sb1070-d3-deadline-${Math.ceil(deadlineMs / 1_000)}`,
    tokenExpiresOn: isoAt(deadlineMs + DEPLOY3_TOKEN_GRACE_MS),
  };
}

export function deploy3CleanupToken(receipt: Deploy3UploadReceipt) {
  const expiry = deploy3Expiry(receipt);
  return {
    name: `${receipt.workerName}-deadline`,
    expiresOn: expiry.tokenExpiresOn,
    policies: [
      {
        effect: "allow" as const,
        permissionGroups: [{ id: INDIVIDUAL_WORKER_ADMIN }],
        resources: { [`com.cloudflare.edge.worker.script.${receipt.workerId}`]: "*" },
      },
    ],
  };
}

export function deploy3BootstrapIdentity(runId: string, startedAtMs: number) {
  return {
    workerName: createDeploy3Name({
      runId,
      deadlineMs: startedAtMs + DEPLOY3_LIFETIME_MS,
      role: "workload",
    }),
    // An interrupted bootstrap also leaves an automatically expiring operator token.
    operatorTokenExpiresOn: isoAt(startedAtMs + 45 * 60 * 1_000),
  };
}
