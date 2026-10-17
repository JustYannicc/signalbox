import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import {
  COMPATIBILITY_DATE,
  SIGNALBOX_ZONE_ID,
  type CloudStage,
  previewWorkerRoutes,
} from "./stage.ts";

export const traceExportUrl = (target: CloudStage, workerUrl: string | null | undefined) => {
  const origin = target.production
    ? (workerUrl ?? `https://traces-${target.cloudDomain}`)
    : `https://${target.cloudDomain}`;
  return `${origin}/v1/traces`;
};

/** Native spans can contain URLs and storage keys. Only the filtering Worker may send them to Sentry. */
export const nativeTraceExport = (
  target: CloudStage,
  telemetry: {
    readonly SENTRY_DSN: Redacted.Redacted<string>;
    readonly SIGNALBOX_STAGE: string;
    readonly APP_VERSION: string;
  },
) =>
  Effect.gen(function* () {
    const dsn = Redacted.value(telemetry.SENTRY_DSN).trim();
    if (dsn === "") return null;
    // This admits the same write-only ingestion as Sentry's public DSN, not access to project data.
    const dsnUrl = new URL(dsn);
    const token = dsnUrl.username;
    const segments = dsnUrl.pathname.split("/").filter(Boolean);
    const project = segments.pop();
    if (project === undefined || token === "") throw new Error("SENTRY_DSN isn't a DSN.");
    if (!target.production) {
      // Existing preview state owns this shared destination. Keep it disabled rather than orphaning it.
      const base = segments.map((segment) => `/${segment}`).join("");
      yield* Cloudflare.Workers.ObservabilityDestination("SentryTraces", {
        name: "signalbox-preview-sentry-traces",
        enabled: false,
        url: `${dsnUrl.protocol}//${dsnUrl.host}${base}/api/${project}/integration/otlp/v1/traces`,
        headers: { "x-sentry-auth": `sentry sentry_key=${token}` },
        logpushDataset: "opentelemetry-traces",
        skipPreflightCheck: true,
      }).pipe(Alchemy.RemovalPolicy.retain());
    }
    const domain = `traces-${target.cloudDomain}`;
    const previewRoutes = previewWorkerRoutes(target);
    const worker = yield* Cloudflare.Worker("TraceExport", {
      name: `${target.cloudWorker}-traces`,
      main: `${import.meta.dirname}/../src/observability/nativeTracesWorker.ts`,
      compatibility: { date: COMPATIBILITY_DATE, flags: ["nodejs_compat"] },
      workersDev: false,
      // Null retires the old preview domain; trace exports use the app's routed path.
      domain: target.production ? { name: domain, zoneId: SIGNALBOX_ZONE_ID } : null,
      routes: previewRoutes.traceExport,
      // Instrumenting the receiver would export its requests back into itself.
      observability: { enabled: false },
      env: {
        SENTRY_DSN: telemetry.SENTRY_DSN,
        SIGNALBOX_STAGE: telemetry.SIGNALBOX_STAGE,
        APP_VERSION: telemetry.APP_VERSION,
        TRACE_EXPORT_TOKEN: token,
      },
    });
    const destination = yield* Cloudflare.Workers.ObservabilityDestination("FilteredTraces", {
      name: `${target.cloudWorker}-sentry-traces`,
      // Bind the destination's provisioning to the receiver's deployment.
      url: worker.url.pipe(Output.map((url) => traceExportUrl(target, url))),
      headers: { authorization: `Bearer ${token}` },
      logpushDataset: "opentelemetry-traces",
      skipPreflightCheck: true,
    });
    return {
      worker,
      token,
      traces: {
        enabled: true,
        destinations: [destination.name],
        headSamplingRate: target.production ? 0.1 : 1,
        // The unfiltered payload must not also be retained in Workers Logs.
        persist: false,
      },
    };
  });
