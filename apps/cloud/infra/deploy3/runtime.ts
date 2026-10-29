import * as Schema from "effect/Schema";
import {
  controlBody,
  controlDigest,
  decodeControlEvent,
  type Deploy3ControlRegistration,
} from "./controlRegistry.ts";
import { deploy3RegistryApi } from "./registryGitHub.ts";
import { cleanupRegisteredDeploy3 } from "./registryCleanup.ts";
import { decodeDeploy3Receipt, deploy3Expiry, type Deploy3UploadReceipt } from "./expiry.ts";

export interface Deploy3RuntimeEnvironment {
  readonly DEPLOY3_ACCOUNT_ID?: string;
  readonly DEPLOY3_CLEANUP_TOKEN?: string;
  readonly DEPLOY3_RECEIPT?: Deploy3UploadReceipt | string;
  readonly DEPLOY3_CONTROL?: string;
  readonly DEPLOY3_CONTROL_WRITER_IDS?: string;
}

const decodeUnknownJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

export function parseTrustedWriterIds(value: string) {
  const ids = value.split(",").map((part) => Number(part.trim()));
  if (
    !ids.length ||
    ids.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
    new Set(ids).size !== ids.length
  ) {
    throw new Error("Deploy3 trusted registry writers are not configured");
  }
  return ids;
}

export function decodeDeploy3Registration(value: string): Deploy3ControlRegistration {
  const event = decodeControlEvent(decodeUnknownJson(value));
  if (event.kind !== "registered") throw new Error("Deploy3 binding is not a registration");
  return event;
}

export function validateDeploy3RegistrationReceipt(
  registration: Deploy3ControlRegistration,
  receipt: Deploy3UploadReceipt,
) {
  const expiry = deploy3Expiry(receipt);
  if (
    receipt.workerName !== registration.workerName ||
    receipt.workerId !== registration.workerId ||
    receipt.receivedAtUtc !== registration.deployedAtUtc ||
    expiry.originalDeadlineUtc !== registration.deadlineUtc
  ) {
    throw new Error("Deploy3 runtime and control identities differ");
  }
  return expiry;
}

export function requireDeploy3Armed(env: Deploy3RuntimeEnvironment) {
  if (
    !env.DEPLOY3_CONTROL ||
    !env.DEPLOY3_RECEIPT ||
    !env.DEPLOY3_ACCOUNT_ID ||
    !env.DEPLOY3_CLEANUP_TOKEN
  ) {
    throw new Error("Deploy3 deadline registration is not armed");
  }
  const registration = decodeDeploy3Registration(env.DEPLOY3_CONTROL);
  const receipt = decodeDeploy3Receipt(env.DEPLOY3_RECEIPT);
  const expiry = validateDeploy3RegistrationReceipt(registration, receipt);
  parseTrustedWriterIds(env.DEPLOY3_CONTROL_WRITER_IDS ?? "");
  return {
    registration,
    receipt,
    expiry,
    accountId: env.DEPLOY3_ACCOUNT_ID,
    cleanupToken: env.DEPLOY3_CLEANUP_TOKEN,
  };
}

/** The bound original deadline still runs when GitHub is unavailable. Extensions also update this binding. */
export async function runDeploy3Deadline(input: {
  readonly env: Deploy3RuntimeEnvironment;
  readonly nowMs: number;
  readonly fetchImpl?: typeof fetch;
}) {
  const { env } = input;
  const { registration, expiry, accountId, cleanupToken } = requireDeploy3Armed(env);
  if (input.nowMs < expiry.deadlineMs) return { status: "not-due" };
  const network = input.fetchImpl ? { fetchImpl: input.fetchImpl } : {};
  const registry = deploy3RegistryApi({
    ...network,
    trustedWriterIds: parseTrustedWriterIds(env.DEPLOY3_CONTROL_WRITER_IDS ?? ""),
    // Public controls need no durable GitHub secret in the Worker. The hourly CI job posts after self-deletion.
    token: async () => "",
  });
  let state;
  try {
    state = (await registry.read()).controls.find(
      (row) => row.registration.runId === registration.runId,
    );
    if (!state || state.registration.workerId !== registration.workerId)
      throw new Error("Registry identity differs");
  } catch {
    // Keep every owner held when the public registry is unavailable, then delete at the bound deadline.
    state = {
      registration,
      registrationSha256: await controlDigest(controlBody(registration)),
      deadlineUtc: expiry.deadlineUtc,
      cleanupTokenExpiresOn: expiry.tokenExpiresOn,
      ownersNotReleased: registration.owners.map((row) => row.owner),
    };
  }

  return cleanupRegisteredDeploy3({
    ...network,
    state,
    registry,
    accountId,
    cloudflareToken: cleanupToken,
    nowMs: input.nowMs,
    tokenVerificationMode: "self",
  });
}
