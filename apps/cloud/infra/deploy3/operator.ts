import { decodeDeploy3BootstrapJson, requireDeploy3Bootstrap } from "./bootstrapRegistry.ts";
import { decodeDeploy3Receipt } from "./expiry.ts";
import { verifyDeploy3TokenExpiry } from "./tokenExpiry.ts";
import { verifyDeploy3Arming } from "./arming.ts";
import * as Schema from "effect/Schema";
import { extendDeploy3Control, registerDeploy3Control } from "./controlLifecycle.ts";
import { readLocalEvidenceText } from "./localEvidenceFiles.ts";
import { exportDeploy3Locally } from "./normalEvidence.ts";
import { cleanupReleasedDeploy3, releaseDeploy3FromLocalEvidence } from "./normalOperator.ts";
import { clockMillis } from "./platform.ts";
import { deploy3RegistryApi } from "./registryGitHub.ts";
import { decodeDeploy3Registration, parseTrustedWriterIds } from "./runtime.ts";

const decodeExportSource = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      origin: Schema.String,
      qualifierRunId: Schema.String,
      directory: Schema.String,
    }),
  ),
);
const decodeReleaseOwner = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ owner: Schema.Literals(["1070", "1255"]) })),
);

async function main() {
  const [command, runId, file, argument] = process.argv.slice(2);
  const api = deploy3RegistryApi({
    token: async () => process.env.GH_TOKEN ?? "",
    trustedWriterIds: parseTrustedWriterIds(process.env.DEPLOY3_CONTROL_WRITER_IDS ?? ""),
  });
  if (command === "bootstrap" && file) {
    const bootstrap = decodeDeploy3BootstrapJson(await readLocalEvidenceText(file));
    if (bootstrap.runId !== runId) throw new Error("Bootstrap run ID differs");
    const before = await api.read();
    if (before.bootstraps.some((row) => row.runId === runId))
      throw new Error("Bootstrap is already registered");
    await api.appendBootstrap(bootstrap);
    requireDeploy3Bootstrap((await api.read()).bootstraps, bootstrap);
    process.stdout.write("Expiring bootstrap credential durably registered before Worker upload\n");
    return;
  }
  if (command === "register" && file) {
    const registration = decodeDeploy3Registration(await readLocalEvidenceText(file));
    if (registration.runId !== runId) throw new Error("Registration run ID differs");
    const state = await registerDeploy3Control(api, registration);
    process.stdout.write(`Registered ${state.registration.runId} ${state.registrationSha256}\n`);
    return;
  }
  if (!runId || !/^[a-f0-9]{8}$/.test(runId))
    throw new Error("An exact deploy3 run ID is required");
  if (command === "export" && file) {
    const source = decodeExportSource(await readLocalEvidenceText(file));
    const state = (await api.read()).controls.find((row) => row.registration.runId === runId);
    if (!state) throw new Error("Export has no registered deployment");
    const exported = await exportDeploy3Locally({
      ...source,
      registration: state.registration,
    });
    process.stdout.write(`Local export verified ${exported.verifiedLocalExportSha256}\n`);
    return;
  }
  if (command === "release" && file && argument) {
    const release = decodeReleaseOwner(await readLocalEvidenceText(file));
    const state = await releaseDeploy3FromLocalEvidence({
      api,
      runId,
      owner: release.owner,
      directory: argument,
      explicitReleaseFile: file,
    });
    process.stdout.write(
      `Owner release recorded; ${state.ownersNotReleased.length} owner(s) still held\n`,
    );
    return;
  }
  if (command === "extend" && file) {
    const receipt = decodeDeploy3Receipt(await readLocalEvidenceText(file));
    const state = (await api.read()).controls.find((row) => row.registration.runId === runId);
    if (!state) throw new Error("Extension has no registered deployment");
    await extendDeploy3Control({
      api,
      runId,
      receipt,
      async verifyExtendedToken(expectedExpiresOn) {
        const verified = await verifyDeploy3TokenExpiry({
          accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
          authorityToken: process.env.DEPLOY3_CLEANUP_TOKEN ?? "",
          tokenId: state.registration.cleanupTokenId,
          expectedExpiresOn,
          nowMs: clockMillis(),
          mode: "self",
        });
        return verified.status === "expiry-configured";
      },
    });
    process.stdout.write(
      "Written extension registered; re-arm and verify the runtime binding before relying on it\n",
    );
    return;
  }
  if (command === "arm-check" && file) {
    const state = (await api.read()).controls.find((row) => row.registration.runId === runId);
    if (!state) throw new Error("Arming has no registered deployment");
    const result = await verifyDeploy3Arming({
      registration: state.registration,
      deadlineUtc: state.deadlineUtc,
      cleanupTokenExpiresOn: state.cleanupTokenExpiresOn,
      origin: file,
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
      operatorToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
      cleanupToken: process.env.DEPLOY3_CLEANUP_TOKEN ?? "",
      nowMs: clockMillis(),
    });
    process.stdout.write(`Deploy3 ${result.status}; nativeStarted=false\n`);
    return;
  }
  if (command === "cleanup") {
    const cleanup = await cleanupReleasedDeploy3({
      api,
      runId,
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
      cloudflareToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
      nowMs: clockMillis(),
    });
    process.stdout.write(`Normal cleanup ${cleanup.status}\n`);
    if (!cleanup.cleanClaim) process.exitCode = 1;
    return;
  }
  throw new Error(
    "Use bootstrap RUN FILE, register RUN FILE, export RUN SOURCE_FILE, release RUN RELEASE_FILE EXPORT_DIR, extend RUN RECEIPT_FILE, arm-check RUN ORIGIN, or cleanup RUN",
  );
}

if (import.meta.main)
  await main().catch(() => {
    process.stderr.write("Deploy3 operator action failed; deployment is not released\n");
    process.exitCode = 1;
  });
