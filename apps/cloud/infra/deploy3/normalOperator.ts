import { readLocalEvidenceText } from "./localEvidenceFiles.ts";
import * as Schema from "effect/Schema";
import { finalizeDeploy3OwnerTeardown } from "./ownerTeardownLifecycle.ts";
import { cleanupDeploy3Worker } from "./cloudflare.ts";
import { releaseDeploy3Owner, requireAllDeploy3OwnersReleased } from "./controlLifecycle.ts";
import { controlDigest } from "./controlRegistry.ts";
import { verifyDeploy3LocalExport } from "./normalEvidence.ts";
import type { Deploy3RegistryApi } from "./registryGitHub.ts";
import type { Deploy3Owner } from "./teardownReceipt.ts";

const ExplicitRelease = Schema.Struct({
  runId: Schema.String,
  registrationSha256: Schema.String,
  owner: Schema.Literals(["1070", "1255"]),
  release: Schema.Literal(true),
  verifiedLocalExportSha256: Schema.String,
  sourceMessageId: Schema.String,
  fullText: Schema.String,
});

const decodeExplicitReleaseJson = Schema.decodeSync(Schema.fromJsonString(ExplicitRelease));

export async function releaseDeploy3FromLocalEvidence(input: {
  readonly api: Deploy3RegistryApi;
  readonly runId: string;
  readonly owner: Deploy3Owner;
  readonly directory: string;
  readonly explicitReleaseFile: string;
}) {
  return releaseDeploy3Owner({
    ...input,
    async verifyLocalExportAndExplicitRelease() {
      const state = (await input.api.read()).controls.find(
        (row) => row.registration.runId === input.runId,
      );
      if (!state) throw new Error("Normal release has no registered deployment");
      const verified = await verifyDeploy3LocalExport({
        directory: input.directory,
        registration: state.registration,
      });
      const raw = await readLocalEvidenceText(input.explicitReleaseFile);
      const release = decodeExplicitReleaseJson(raw);
      if (
        release.runId !== input.runId ||
        release.owner !== input.owner ||
        release.registrationSha256 !== state.registrationSha256 ||
        release.verifiedLocalExportSha256 !== verified.verifiedLocalExportSha256 ||
        !release.sourceMessageId.startsWith("message:") ||
        release.fullText.trim().length === 0
      ) {
        throw new Error("Explicit owner release does not match the verified local export");
      }
      return { ...verified, explicitReleaseSha256: await controlDigest(raw) };
    },
  });
}

export async function cleanupReleasedDeploy3(input: {
  readonly api: Deploy3RegistryApi;
  readonly runId: string;
  readonly accountId: string;
  readonly cloudflareToken: string;
  readonly nowMs: number;
  readonly fetchImpl?: typeof fetch;
}) {
  const state = (await input.api.read()).controls.find(
    (row) => row.registration.runId === input.runId,
  );
  if (!state) throw new Error("Normal teardown has no registered deployment");
  requireAllDeploy3OwnersReleased(state);
  const cleanup = await cleanupDeploy3Worker({
    accountId: input.accountId,
    token: input.cloudflareToken,
    nowMs: input.nowMs,
    workerName: state.registration.workerName,
    expectedTag: state.registration.workerId,
    expectedNamespaceIds: state.registration.namespaceIds,
    registeredDeadlineUtc: state.deadlineUtc,
    releasedRegistrationSha256: state.registrationSha256,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  const finalization = cleanup.cleanClaim
    ? await finalizeDeploy3OwnerTeardown(input)
    : { status: "unconfirmed" as const };
  return { ...cleanup, registryFinalization: finalization.status };
}
