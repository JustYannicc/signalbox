// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off - Alchemy provider helpers expose framework-owned any requirements.
/**
 * Signalbox Cloud on Cloudflare, as one Alchemy stack: the app Worker with its
 * Durable Objects and web assets, the thread and pool containers, the drive
 * pack buckets, and the ModelGateway. Stages are `production` and
 * `pr-<number>` (`infra/stage.ts`); `.github/workflows/deploy-cloud.yml`
 * deploys both. `wrangler dev` still runs the cloud locally from
 * wrangler.jsonc. See docs/operations/cloud.md.
 *
 * Production holds everyone's data. Its resources were made by wrangler and
 * are adopted in place: the names, binding names and class names below are
 * what keeps every Durable Object's storage. Never rename them. Production
 * resources are retained, so no destroy or replace ever deletes them.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import {
  COMPATIBILITY_DATE,
  type CloudStage,
  cloudStage,
  DURABLE_OBJECT_BINDINGS as DO,
  PREVIEW_DRIVE_PACKS_BUCKET,
  PREVIEW_ZONE,
  SIGNALBOX_ZONE_ID,
} from "./infra/stage.ts";
import type {
  DriveObject,
  ModelGrants,
  PoolObject,
  PreviewLinkRegistry,
  ThreadObject,
  UserObject,
} from "./src/worker.ts";

const here = (path: string) => `${import.meta.dirname}/${path}`;

const compatibility = {
  date: COMPATIBILITY_DATE,
  // Alchemy otherwise adds `new_module_registry`; keep what wrangler ran.
  flags: ["nodejs_compat", "legacy_module_registry"],
};

const workerObservability = { enabled: true, logs: { enabled: true, invocationLogs: true } };

/** A Durable Object class's container, placed as wrangler placed it: tiers 1 and 2, EU only. */
const euContainer = <Shape>(
  id: string,
  props: {
    readonly name: string;
    readonly className: string;
    readonly context: string;
    readonly dockerfile: string;
    readonly instanceType: "lite" | "basic";
    readonly maxInstances: number;
  },
) =>
  Cloudflare.Container<Shape>(id, {
    ...props,
    // Alchemy types constraints as `tier` alone; the API takes these as wrangler sent them.
    constraints: {
      tiers: [1, 2],
      jurisdiction: "eu",
    } as Cloudflare.ContainerApplication.Constraints,
    observability: { logs: { enabled: true } },
  });

const optional = (name: string) => Config.String(name).pipe(Config.withDefault(""));
const optionalSecret = (name: string) =>
  Config.Redacted(name).pipe(Config.withDefault(Redacted.make("")));

const drivePacks = (id: string, name: string) =>
  Cloudflare.R2.Bucket(id, {
    name,
    jurisdiction: "eu",
    // The rule Cloudflare gives new buckets, as `signalbox-drives` has it. The
    // stack owns the whole list, so leaving it out would delete it.
    lifecycleRules: [
      {
        id: "Default Multipart Abort Rule",
        abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 7 * 24 * 60 * 60 } },
      },
    ],
  }).pipe(
    // Shared across stages and full of drives: no stage ever deletes one.
    Alchemy.RemovalPolicy.retain(),
  );

export default Alchemy.Stack(
  "SignalboxCloud",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const target = cloudStage(stage);
    const env = yield* workerEnv(target);
    return yield* deploy(target, env).pipe(
      // Production and open previews were made by wrangler. Names come only
      // from the stage, so a preview can never claim production's.
      Alchemy.AdoptPolicy.adopt(true),
      // Production is never deleted: a destroy or replace only drops it from state.
      Alchemy.RemovalPolicy.retain(target.production),
    );
  }),
);

/** Vars and secrets from CI's environment, next to the stage's own vars. */
function workerEnv(target: CloudStage) {
  return Effect.gen(function* () {
    const shared = {
      T3CODE_WORKOS_CLIENT_ID: yield* Config.String("T3CODE_WORKOS_CLIENT_ID"),
      MACHINE_BACKEND: yield* optional("MACHINE_BACKEND"),
      // Optional: the Executor local harness setup adds as an MCP server (`src/localKeys/`).
      EXECUTOR_MCP_URL: yield* optional("EXECUTOR_MCP_URL"),
      SESSION_SECRET: yield* Config.Redacted("SESSION_SECRET"),
      T3CODE_WORKOS_API_KEY: yield* Config.Redacted("T3CODE_WORKOS_API_KEY"),
      // Optional: Claude and Codex on boat VMs.
      BOAT_API_KEY: yield* optionalSecret("BOAT_API_KEY"),
      // Optional: pushes to phones (`src/push/`).
      APNS_TEAM_ID: yield* optionalSecret("APNS_TEAM_ID"),
      APNS_KEY_ID: yield* optionalSecret("APNS_KEY_ID"),
      APNS_PRIVATE_KEY: yield* optionalSecret("APNS_PRIVATE_KEY"),
      FCM_SERVICE_ACCOUNT: yield* optionalSecret("FCM_SERVICE_ACCOUNT"),
    };
    const stageEnv = target.production
      ? {
          // `cloud.*` usage analytics (#116): production only, so previews
          // never mix test turns into the cost data.
          SIGNALBOX_POSTHOG_KEY: yield* optional("SIGNALBOX_POSTHOG_KEY"),
          SIGNALBOX_POSTHOG_HOST: yield* optional("SIGNALBOX_POSTHOG_HOST"),
          PREVIEW_CLEANUP_TOKEN: yield* Config.Redacted("PREVIEW_CLEANUP_TOKEN"),
          // Optional: membership changes from WorkOS at once.
          T3CODE_WORKOS_WEBHOOK_SECRET: yield* optionalSecret("T3CODE_WORKOS_WEBHOOK_SECRET"),
        }
      : {
          // A preview's own Runner image (deploy-cloud.yml's `runner_image`); empty means `nightly`.
          RUNNER_IMAGE: yield* optional("RUNNER_IMAGE"),
        };

    return { ...target.vars, ...shared, ...stageEnv };
  });
}

function deploy(
  target: CloudStage,
  env: Readonly<Record<string, string | Redacted.Redacted<string>>>,
) {
  return Effect.gen(function* () {
    // The web app, built by CI before the deploy. Same origin as the API.
    const assets = {
      directory: here("../web/dist"),
      // Every request reaches the Worker first: preview origins share these
      // paths and must never get the app's files.
      runWorkerFirst: true,
      notFoundHandling: "single-page-application" as const,
    };

    const previewPacks = yield* drivePacks("PreviewDrivePacks", PREVIEW_DRIVE_PACKS_BUCKET);
    const packs = target.production
      ? yield* drivePacks("DrivePacks", target.drivePacksBucket)
      : previewPacks;

    // Every stage's dev-server previews resolve through one proxied wildcard,
    // shared like the buckets: each stage declares the same record and none
    // ever deletes it. `100::` is the discard prefix: the routes answer first.
    yield* Cloudflare.DNS.Record("PreviewWildcard", {
      zoneId: PREVIEW_ZONE.id,
      name: `*.${PREVIEW_ZONE.name}`,
      type: "AAAA",
      content: "100::",
      proxied: true,
      comment: "Signalbox dev-server previews (apps/cloud/alchemy.run.ts)",
    }).pipe(Alchemy.RemovalPolicy.retain());

    const cloud = yield* Cloudflare.Worker("Cloud", {
      name: target.cloudWorker,
      main: here("src/worker.ts"),
      compatibility,
      // One origin: sign-in callbacks, cookies and saved connections all key on it.
      workersDev: false,
      domain: { name: target.cloudDomain, zoneId: SIGNALBOX_ZONE_ID },
      // Threads' dev servers (`PREVIEW_DOMAIN`), on this stage's preview hosts only.
      routes: [{ pattern: `${target.previewHost}/*`, zoneId: PREVIEW_ZONE.id }],
      assets,
      observability: workerObservability,
      env: {
        ...env,
        // Binding and class names are the Durable Objects' identity.
        USERS: Cloudflare.DurableObject<UserObject>(DO.USERS),
        DRIVES: Cloudflare.DurableObject<DriveObject>(DO.DRIVES),
        PREVIEW_LINKS: Cloudflare.DurableObject<PreviewLinkRegistry>(DO.PREVIEW_LINKS),
        // A managed pool's CLIProxyAPI, pinned in containers/cliproxyapi/release.json.
        POOLS: euContainer<PoolObject>("PoolContainer", {
          ...target.poolContainer,
          className: DO.POOLS,
          context: here("containers/cliproxyapi"),
          dockerfile: here("containers/cliproxyapi/Dockerfile"),
          instanceType: "lite",
        }),
        // A thread's light machine: the Runner built from this commit, so the
        // two always speak the same protocol. `vp run runner:bundle` in
        // apps/server writes the build context first.
        THREADS: euContainer<ThreadObject>("ThreadContainer", {
          ...target.threadContainer,
          className: DO.THREADS,
          context: here("../server/dist/runner"),
          dockerfile: here("../server/src/signalbox/runner/image/Dockerfile"),
          instanceType: "basic",
        }),
        // Drives' git packs (`src/drive/`). Their refs live in the DRIVES objects.
        DRIVE_PACKS: packs,
        // Production cleans up the preview bucket; previews never use this one.
        PREVIEW_DRIVE_PACKS: previewPacks,
      },
    });

    // The origin machines' harnesses call as their provider's API. It holds
    // no keys: the cloud's `ModelGrants` entrypoint checks every token.
    const gateway = yield* Cloudflare.Worker("ModelGateway", {
      name: target.gatewayWorker,
      main: here("src/modelGateway/worker.ts"),
      compatibility,
      workersDev: false,
      domain: { name: target.gatewayDomain, zoneId: SIGNALBOX_ZONE_ID },
      observability: workerObservability,
      env: {
        GRANTS: Cloudflare.WorkerEntrypoint<ModelGrants>(cloud, "ModelGrants"),
      },
    });

    return {
      cloud: cloud.workerName,
      gateway: gateway.workerName,
      url: `https://${target.cloudDomain}`,
    };
  });
}
