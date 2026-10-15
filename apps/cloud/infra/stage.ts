/**
 * What each Alchemy stage of Signalbox Cloud deploys as (`alchemy.run.ts`).
 *
 * `production` is app.signalbox.run. `pr-<number>` is a pull request's
 * preview. Every name here is a live Cloudflare resource: production's were
 * made by wrangler and are adopted as they are, so changing one creates a new
 * resource instead of updating the old one. Durable Objects live in their
 * Worker's namespaces, so the Worker names carry everyone's data.
 */

/** Signalbox's zone, pinned so custom domains never need a zone lookup. */
export const SIGNALBOX_ZONE_ID = "e817cf0e17e849a0aab7a0bf92c0a053";

/**
 * Threads' dev servers (`src/thread/preview/`), on a registrable domain of
 * their own so preview pages are never same-site with the app and never get
 * signalbox.run's cookies. Universal SSL covers one level of subdomains, so
 * every stage's previews sit side by side, told apart after the label:
 * `<label>-app.` for production, `<label>-pr<number>.` for a pull request.
 * Each stage's route only matches its own, so no route depends on another
 * being more specific.
 */
export const PREVIEW_ZONE = {
  id: "fcbe785375d3014f110caab2e4a95bdd",
  name: "signalbox-preview.dev",
};

const previewHost = (tag: string) => `*-${tag}.${PREVIEW_ZONE.name}`;

/**
 * Same as wrangler.jsonc, so `wrangler dev` runs what deploys. From
 * 2026-10-01 pending I/O (`ctx.container.monitor()`, DO RPC, service binding
 * calls, `waitUntil`) keeps a Durable Object up with no client connected, so a
 * ThreadObject or PoolObject isn't evicted while its container still works.
 */
export const COMPATIBILITY_DATE = "2026-10-01";

/**
 * Durable Object bindings and the classes behind them. A binding is its
 * namespace's identity: renaming one deploys a new, empty namespace.
 */
export const DURABLE_OBJECT_BINDINGS = {
  USERS: "UserObject",
  THREADS: "ThreadObject",
  POOLS: "PoolObject",
  DRIVES: "DriveObject",
  PREVIEW_LINKS: "PreviewLinkRegistry",
} as const;

/**
 * The automation engine: one Workflow instance per run, hosted by the cloud
 * Worker's exported `AutomationWorkflow`, which loads each automation version
 * as a Dynamic Worker through the `LOADER` Worker Loader binding.
 */
export const AUTOMATION_BINDINGS = {
  workflow: "AUTOMATION_RUNS",
  workflowClass: "AutomationWorkflow",
  loader: "LOADER",
} as const;

export interface CloudStage {
  readonly production: boolean;
  readonly cloudWorker: string;
  readonly gatewayWorker: string;
  readonly cloudDomain: string;
  readonly gatewayDomain: string;
  /** Preview hosts in route pattern syntax, `*` standing for the label. Also `PREVIEW_DOMAIN`. */
  readonly previewHost: string;
  readonly poolContainer: { readonly name: string; readonly maxInstances: number };
  readonly threadContainer: { readonly name: string; readonly maxInstances: number };
  /** The bucket the Worker's `DRIVE_PACKS` reads and writes. */
  readonly drivePacksBucket: string;
  /** The automation runs' Workflow. Workflow names are account-global. */
  readonly automationWorkflow: string;
  /** Plain-text vars fixed by the stage. CI adds the rest. */
  readonly vars: Readonly<Record<string, string>>;
}

export const PRODUCTION_STAGE = "production";
export const PREVIEW_DRIVE_PACKS_BUCKET = "signalbox-drives-preview";

const PREVIEW_STAGE = /^pr-([1-9][0-9]*)$/;

/** The pull request number of a preview stage, or null for any other stage. */
export const previewStageNumber = (stage: string): number | null => {
  const match = PREVIEW_STAGE.exec(stage);
  return match?.[1] === undefined ? null : Number(match[1]);
};

const urls = (cloudDomain: string, gatewayDomain: string) => ({
  CLOUD_URL: `https://${cloudDomain}`,
  MODEL_GATEWAY_URL: `https://${gatewayDomain}`,
});

export const cloudStage = (stage: string): CloudStage => {
  if (stage === PRODUCTION_STAGE) {
    const previews = previewHost("app");
    return {
      production: true,
      cloudWorker: "signalbox-cloud",
      gatewayWorker: "signalbox-model-gateway",
      cloudDomain: "app.signalbox.run",
      gatewayDomain: "gateway.signalbox.run",
      previewHost: previews,
      // wrangler's default names: `<worker>-<class, lowercased>`. A cap is
      // only a brake on a runaway start loop: containers bill while they run,
      // and the account allows 1,500 vCPU / 6 TiB at once. Pools run one lite
      // container each (a company pool is one, however many people use it),
      // so 100 is 100 pools busy at once, 6.25 vCPU. Threads run one basic
      // container per working turn, so 200 is 50 vCPU. `check-container-capacity.ts`
      // opens an issue at 80%.
      poolContainer: { name: "signalbox-cloud-poolobject", maxInstances: 100 },
      threadContainer: { name: "signalbox-cloud-threadobject", maxInstances: 200 },
      drivePacksBucket: "signalbox-drives",
      automationWorkflow: "signalbox-cloud-automations",
      vars: {
        // Production identity. Never reuse it for another deployment.
        ENVIRONMENT_ID: "4bfb70e5-7954-458a-9b75-4834c0ab4e13",
        ENVIRONMENT_LABEL: "Signalbox Cloud",
        ...urls("app.signalbox.run", "gateway.signalbox.run"),
        PREVIEW_DOMAIN: previews,
        // Previews that may take a signed-in user's setup (`src/previewSetup/`).
        PREVIEW_SETUP_ORIGINS: "https://preview-*.signalbox.run",
      },
    };
  }
  const number = previewStageNumber(stage);
  if (number === null) {
    throw new Error(`Unknown Signalbox Cloud stage "${stage}": use "production" or "pr-<number>".`);
  }
  const cloudDomain = `preview-${number}.signalbox.run`;
  const gatewayDomain = `gateway-preview-${number}.signalbox.run`;
  const previews = previewHost(`pr${number}`);
  return {
    production: false,
    cloudWorker: `signalbox-cloud-pr-${number}`,
    gatewayWorker: `signalbox-model-gateway-pr-${number}`,
    cloudDomain,
    gatewayDomain,
    previewHost: previews,
    poolContainer: { name: `signalbox-cloud-pr-${number}-pools`, maxInstances: 2 },
    threadContainer: { name: `signalbox-cloud-pr-${number}-threads`, maxInstances: 2 },
    // Previews never touch production's packs; each keeps its own prefix.
    drivePacksBucket: PREVIEW_DRIVE_PACKS_BUCKET,
    automationWorkflow: `signalbox-cloud-pr-${number}-automations`,
    vars: {
      ENVIRONMENT_ID: `cloud-preview-${number}`,
      ENVIRONMENT_LABEL: `Signalbox Cloud (PR #${number})`,
      ...urls(cloudDomain, gatewayDomain),
      PREVIEW_DOMAIN: previews,
      DRIVE_PACKS_PREFIX: `pr-${number}/`,
      // Where a preview takes each user's setup from (`src/previewSetup/`).
      PREVIEW_SETUP_SOURCE: "https://app.signalbox.run",
      // The idle-chat test clock (`src/http/threadKindRoutes.ts`), never in production.
      THREAD_KIND_TEST_CLOCK: "1",
    },
  };
};
