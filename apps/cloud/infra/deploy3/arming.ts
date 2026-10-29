import * as Schema from "effect/Schema";
import { createDeploy3CloudflareApi } from "./cloudflareTransport.ts";
import type { Deploy3ControlRegistration } from "./controlRegistry.ts";
import { boundedOperation } from "./platform.ts";
import { verifyDeploy3TokenExpiry } from "./tokenExpiry.ts";

const decodeReady = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      runId: Schema.String,
      workerId: Schema.String,
      deadlineUtc: Schema.String,
      cleanupTokenId: Schema.String,
      cleanupTokenExpiresOn: Schema.String,
      nativeStarted: Schema.Literal(false),
    }),
  ),
);
const decodeSchedules = Schema.decodeUnknownSync(
  Schema.Struct({
    schedules: Schema.Array(Schema.Struct({ cron: Schema.String })),
  }),
);
const decodeWorkers = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ id: Schema.String, tag: Schema.String })),
);

/** Read back the deployed bindings and Cron before any provider/qualifier route is allowed. */
export async function verifyDeploy3Arming(input: {
  readonly registration: Deploy3ControlRegistration;
  readonly deadlineUtc?: string;
  readonly cleanupTokenExpiresOn?: string;
  readonly origin: string;
  readonly accountId: string;
  readonly operatorToken: string;
  readonly cleanupToken: string;
  readonly nowMs: number;
  readonly fetchImpl?: typeof fetch;
}) {
  const { registration } = input;
  const deadlineUtc = input.deadlineUtc ?? registration.deadlineUtc;
  const cleanupTokenExpiresOn = input.cleanupTokenExpiresOn ?? registration.cleanupTokenExpiresOn;
  const origin = new URL(input.origin);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== input.origin ||
    !origin.hostname.startsWith(`${registration.workerName}.`)
  )
    throw new Error("Arming origin differs from the exact Worker");
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const ready = await boundedOperation(async (signal) => {
    const response = await fetchImpl(`${input.origin}/deployment-ready`, {
      signal,
      redirect: "error",
      cache: "no-store",
    });
    if (response.status !== 200) throw new Error("Deploy3 armed runtime is unavailable");
    return decodeReady(await response.text());
  }, 10_000);
  if (
    ready.runId !== registration.runId ||
    ready.workerId !== registration.workerId ||
    ready.deadlineUtc !== deadlineUtc ||
    ready.cleanupTokenId !== registration.cleanupTokenId ||
    ready.cleanupTokenExpiresOn !== cleanupTokenExpiresOn
  )
    throw new Error("Armed runtime identity differs");
  const api = createDeploy3CloudflareApi({
    accountId: input.accountId,
    token: input.operatorToken,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  const workers = decodeWorkers(
    (await api.request("arming-worker-identity", "GET", "/workers/scripts")).result,
  );
  if (
    workers.filter((row) => row.id === registration.workerName && row.tag === registration.workerId)
      .length !== 1
  ) {
    throw new Error("Armed Worker immutable identity was not verified");
  }
  const schedules = decodeSchedules(
    (
      await api.request(
        "arming-cron",
        "GET",
        `/workers/scripts/${registration.workerName}/schedules`,
      )
    ).result,
  );
  if (schedules.schedules.length !== 1 || schedules.schedules[0]?.cron !== "* * * * *") {
    throw new Error("Deploy3 minute Cron is not armed");
  }
  const expiry = await verifyDeploy3TokenExpiry({
    accountId: input.accountId,
    authorityToken: input.cleanupToken,
    tokenId: registration.cleanupTokenId,
    expectedExpiresOn: cleanupTokenExpiresOn,
    mode: "self",
    nowMs: input.nowMs,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  if (expiry.status !== "expiry-configured")
    throw new Error("Armed cleanup token expiry is unverified");
  return { status: "armed-verified", ...ready, tokenExpiry: expiry.status };
}
