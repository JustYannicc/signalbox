import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { COMPATIBILITY_DATE, SIGNALBOX_ZONE_ID, type CloudStage } from "./stage.ts";

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
    if (!target.production) {
      // Existing preview state owns this shared destination. Keep it disabled rather than orphaning it.
      const segments = dsnUrl.pathname.split("/").filter(Boolean);
      const project = segments.pop();
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
    const worker = yield* Cloudflare.Worker("TraceExport", {
      name: `${target.cloudWorker}-traces`,
      main: `${import.meta.dirname}/../src/observability/nativeTracesWorker.ts`,
      compatibility: { date: COMPATIBILITY_DATE, flags: ["nodejs_compat"] },
      workersDev: false,
      domain: { name: domain, zoneId: SIGNALBOX_ZONE_ID },
      // Instrumenting the receiver would export its requests back into itself.
      observability: { enabled: false },
      env: { ...telemetry, TRACE_EXPORT_TOKEN: token },
    });
    const destination = yield* Cloudflare.Workers.ObservabilityDestination("FilteredTraces", {
      name: `${target.cloudWorker}-sentry-traces`,
      // Bind the destination's provisioning to the receiver's deployment.
      url: worker.url.pipe(Output.map((url) => `${url ?? `https://${domain}`}/v1/traces`)),
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
