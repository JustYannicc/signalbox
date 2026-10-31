// @effect-diagnostics nodeBuiltinImport:off - Startup evidence is read and pinned by a standalone Node deployment adapter.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import type { BundleOutput } from "alchemy/Bundle/Bundle";
import { requireStartupBudget, WORKER_STARTUP_BUDGET_MS } from "./budget.ts";
import { sha256, startupPayload, type StartupCompatibility } from "./payload.ts";
import { profilerRuntime, StartupRuntime } from "./runtime.ts";
import { requireStartupInvocation } from "./invocation.ts";

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Evidence = Schema.Struct({
  schema: Schema.Literal("signalbox/worker-startup-profile/v2"),
  status: Schema.Literal("passed"),
  payloadSha256: Hash,
  budgetMs: Schema.Literal(WORKER_STARTUP_BUDGET_MS),
  profileFile: Schema.String,
  profileSha256: Hash,
  invocationSha256: Hash,
  runtime: StartupRuntime,
  invocation: Schema.Struct({
    wranglerExitCode: Schema.Literal(0),
    workerdStarts: Schema.Literal(1),
    workerdClosed: Schema.Literal(true),
    guardPassed: Schema.Literal(true),
  }),
});
export const decodeStartupEvidence = Schema.decodeUnknownSync(Evidence);

export function requireStartupEvidence(
  bundle: BundleOutput,
  compatibility: StartupCompatibility,
  rawEvidence: unknown,
  profileBytes: Uint8Array,
  expectedRuntime: typeof StartupRuntime.Type,
) {
  const evidence = decodeStartupEvidence(rawEvidence);
  if (evidence.payloadSha256 !== startupPayload(bundle, compatibility).sha256)
    throw new Error("WORKER_STARTUP_PROFILE_STALE_PAYLOAD");
  if (evidence.profileSha256 !== sha256(profileBytes))
    throw new Error("WORKER_STARTUP_PROFILE_CHANGED");
  for (const key of [
    "node",
    "nodeSha256",
    "wrangler",
    "wranglerSha256",
    "miniflare",
    "miniflareSha256",
    "workerd",
    "workerdSha256",
    "platform",
    "arch",
  ] as const)
    if (evidence.runtime[key] !== expectedRuntime[key])
      throw new Error("WORKER_STARTUP_PROFILE_STALE_RUNTIME");
  const summary = requireStartupBudget(JSON.parse(Buffer.from(profileBytes).toString("utf8")));
  return { evidence, summary };
}

export const startupEvidencePath = (main: string) => `${main}.startup-profile.json`;

export async function readStartupEvidence(
  main: string,
  bundle: BundleOutput,
  compatibility: StartupCompatibility,
) {
  const path = startupEvidencePath(main);
  const evidence = decodeStartupEvidence(JSON.parse(await NodeFSP.readFile(path, "utf8")));
  if (NodePath.basename(evidence.profileFile) !== evidence.profileFile)
    throw new Error("WORKER_STARTUP_PROFILE_FILE_MUST_BE_LOCAL");
  const profile = await NodeFSP.readFile(
    NodePath.join(NodePath.dirname(path), evidence.profileFile),
  );
  const runtime = await profilerRuntime();
  const matched = requireStartupEvidence(
    bundle,
    compatibility,
    evidence,
    profile,
    runtime.identity,
  );
  await requireStartupInvocation(
    main,
    evidence.payloadSha256,
    profile,
    evidence.invocationSha256,
    runtime,
  );
  return matched;
}
