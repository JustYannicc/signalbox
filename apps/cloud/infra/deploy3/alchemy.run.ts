import { requireDeploy3Bootstrap } from "./bootstrapRegistry.ts";
import { encodeDeploy3ExtensionJson } from "./expiry.ts";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as NodeURL from "node:url";
import { controlBody, controlDigest } from "./controlRegistry.ts";
import { Deploy3Plan, validateDeploy3Plan } from "./deploymentPlan.ts";
import { clockMillis } from "./platform.ts";
import { deploy3RegistryApi } from "./registryGitHub.ts";
import {
  decodeDeploy3Registration,
  parseTrustedWriterIds,
  validateDeploy3RegistrationReceipt,
} from "./runtime.ts";
import { deploy3Workload } from "./stack.ts";
import { verifyDeploy3TokenExpiry } from "./tokenExpiry.ts";
import { uploadEvidenceLayer } from "./uploadEvidence.ts";
import { materializeDeploy3QualifierEnvironment } from "./qualifierEnvironment.ts";
import { validateDeploy3PlanAssets } from "./validatePlanAssets.ts";

const decodeDeploy3PlanJson = Schema.decodeEffect(Schema.fromJsonString(Deploy3Plan));

export default Alchemy.Stack(
  "Signalbox1070Deploy3",
  {
    providers: Cloudflare.providers().pipe(Layer.provideMerge(uploadEvidenceLayer)),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const fs = yield* FileSystem.FileSystem;
    const plan = validateDeploy3Plan(
      yield* decodeDeploy3PlanJson(
        yield* fs.readFileString(yield* Config.String("DEPLOY3_PLAN_FILE")).pipe(Effect.orDie),
      ).pipe(Effect.orDie),
      stage,
    );
    yield* Effect.promise(() => validateDeploy3PlanAssets(plan));
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    const operatorValue = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
    if (!plan.operatorTokenId)
      throw new Error("Deploy3 plan must bind the actual expiring operator token");
    const operator = yield* Effect.promise(() =>
      verifyDeploy3TokenExpiry({
        accountId,
        authorityToken: Redacted.value(operatorValue),
        tokenId: plan.operatorTokenId!,
        expectedExpiresOn: plan.identity.operatorTokenExpiresOn,
        nowMs: clockMillis(),
        mode: "self",
      }),
    );
    if (operator.status !== "expiry-configured")
      throw new Error("Deploy3 operator credential expiry was not verified");
    const writers = yield* Config.String("DEPLOY3_CONTROL_WRITER_IDS");
    const bootstrapRegistry = deploy3RegistryApi({
      token: async () => "",
      trustedWriterIds: parseTrustedWriterIds(writers),
    });
    const bootstrapSnapshot = yield* Effect.promise(() => bootstrapRegistry.read());
    requireDeploy3Bootstrap(bootstrapSnapshot.bootstraps, {
      runId: plan.runId,
      workerName: plan.identity.workerName,
      startedAtUtc: plan.startedAtUtc,
      operatorTokenId: plan.operatorTokenId,
      operatorTokenExpiresOn: plan.identity.operatorTokenExpiresOn,
      owners: plan.owners,
    });
    const cleanupValue = plan.registrationJson
      ? yield* Config.Redacted("DEPLOY3_CLEANUP_TOKEN")
      : undefined;
    if (plan.registrationJson && cleanupValue) {
      const registration = decodeDeploy3Registration(plan.registrationJson);
      const registry = deploy3RegistryApi({
        token: async () => "",
        trustedWriterIds: parseTrustedWriterIds(writers),
      });
      if (!plan.receipt) throw new Error("Arming needs an actual deployment receipt");
      const expiry = validateDeploy3RegistrationReceipt(registration, plan.receipt);
      const extensionDigest = plan.receipt.extension
        ? yield* Effect.promise(() =>
            controlDigest(encodeDeploy3ExtensionJson(plan.receipt!.extension!)),
          )
        : undefined;
      const snapshot = yield* Effect.promise(() => registry.read());
      if (
        !snapshot.controls.some(
          (row) =>
            controlBody(row.registration) === controlBody(registration) &&
            row.deadlineUtc === expiry.deadlineUtc &&
            row.cleanupTokenExpiresOn === expiry.tokenExpiresOn &&
            (extensionDigest === undefined || row.extensionAuthoritySha256 === extensionDigest),
        )
      ) {
        throw new Error("Deploy3 control must be durably registered before arming");
      }
      const verified = yield* Effect.promise(() =>
        verifyDeploy3TokenExpiry({
          accountId,
          authorityToken: Redacted.value(cleanupValue),
          tokenId: registration.cleanupTokenId,
          expectedExpiresOn: expiry.tokenExpiresOn,
          nowMs: clockMillis(),
          mode: "self",
        }),
      );
      if (verified.status !== "expiry-configured")
        throw new Error("Deploy3 cleanup credential expiry was not verified");
    }
    const bindings = materializeDeploy3QualifierEnvironment(plan.environment, {
      namespace: (resourceId, className) => Cloudflare.DurableObject(resourceId, { className }),
      loader: () => Cloudflare.WorkerLoader(),
    });
    const deployed = yield* deploy3Workload({
      runId: plan.runId,
      startedAtMs: plan.startedAtMs,
      ...(plan.receipt ? { receipt: plan.receipt } : {}),
      ...(plan.registrationJson && cleanupValue
        ? {
            registrationJson: plan.registrationJson,
            cleanupTokenValue: cleanupValue,
            trustedWriterIds: writers,
          }
        : {}),
      props: {
        source: {
          provider: NodeURL.fileURLToPath(new URL("../workerStartup/source.ts", import.meta.url)),
          devMode: "bundle",
          options: { main: plan.main, rules: [] },
        },
        assets: { directory: plan.assetsDirectory, runWorkerFirst: true },
        compatibility: { date: plan.compatibilityDate, flags: [...plan.compatibilityFlags] },
        workersDev: { enabled: true, previewsEnabled: false },
        env: bindings.env,
      },
    });
    yield* deployed.worker.bind("QualifierServices", {
      bindings: bindings.services.map((binding) =>
        binding.type === "service" ? { ...binding, service: plan.identity.workerName } : binding,
      ),
    });
    return {
      worker: deployed.worker.workerName,
      url: deployed.worker.url,
      protection: deployed.protection,
      deadlineUtc: deployed.deadlineUtc,
      cleanupTokenId: deployed.cleanupTokenId,
      cleanupTokenExpiresOn: deployed.cleanupTokenExpiresOn,
    };
  }),
);
