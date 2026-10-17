#!/usr/bin/env node
// Read-only, sanitized inventory of a Boat account's static resources.
//
//   BOAT_API_KEY=... node boat-inventory.mjs [--include-environments] [--json]
//
// Only GET requests. Prints ids, names, flags, counts and scope metadata.
// Never prints variable values, secret-file contents, key secrets, webhook
// signing secrets or credential values (Boat never returns the last three
// on GET anyway; env values and file contents ARE returned and are dropped
// here before anything is printed).
//
// GET /environments is opt-in: Boat documents that it "creates a default
// environment named `base` on first access if none exists", so on an
// account that never touched environments it is NOT side-effect free.
//
// Exit codes: 0 ok, 1 transport/unexpected, 2 missing key, 3 auth (401),
// 4 some section forbidden/unavailable (reported, other sections still run).

const BASE = (process.env.BOAT_API_BASE_URL ?? "https://boat.dev/api/v1").replace(/\/$/, "");
const KEY = process.env.BOAT_API_KEY?.trim();
const args = new Set(process.argv.slice(2));
const includeEnvironments = args.has("--include-environments");
const asJson = args.has("--json");

if (!KEY) {
  console.error("BOAT_API_KEY is not set.");
  process.exit(2);
}

const get = async (path) => {
  const res = await fetch(`${BASE}${path}`, {
    method: "GET",
    headers: { authorization: `Bearer ${KEY}`, accept: "application/json" },
    redirect: "error",
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    // ErrorEnvelope: { ok:false, status, code, message, requestId }
    return {
      ok: false,
      status: res.status,
      code: body?.code ?? body?.error?.code ?? "non_json",
      message: body?.message ?? body?.error?.message ?? text.slice(0, 200),
      requestId: body?.requestId,
    };
  }
  return { ok: true, status: res.status, body };
};

// Names of `KEY=value` lines, never values.
const envVarNames = (contents) =>
  typeof contents === "string"
    ? contents
        .split(/\r?\n/)
        .map((l) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1])
        .filter(Boolean)
        .sort()
    : [];

const sections = {
  me: ["/me", (b) => ({ login: b.login ?? b.user?.login ?? b.githubLogin ?? null })],
  limits: [
    "/limits",
    (b) => ({
      accessTier: b.accessTier ?? null,
      billingStatus: b.billingStatus ?? null,
      canStart: b.canStart,
      blockedReason: b.blockedReason ?? b.startBlockedReason ?? null,
      activeSandboxes: b.activeSandboxes,
      maxActiveSandboxes: b.maxActiveSandboxes,
      startLimits: b.startLimits ?? null,
      creditBalanceHours: b.creditBalanceHours ?? null,
      blockedTypes: b.blockedTypes ?? b.typeAvailability ?? undefined,
    }),
  ],
  namedSnapshots: [
    "/named-snapshots",
    (b) =>
      (b.snapshots ?? []).map((s) => ({
        name: s.name,
        status: s.status,
        type: s.type,
        snapshotId: s.snapshotId,
        sourceSandboxId: s.sourceSandboxId,
        sizeBytes: s.sizeBytes,
        createdAt: s.createdAt,
        error: s.error ?? undefined,
      })),
  ],
  apiKeys: [
    "/api-keys",
    // A restricted caller gets `apiKeys: []` (documented), not an error.
    (b) => ({
      note:
        (b.apiKeys ?? []).length === 0
          ? "empty: either no keys or the caller is a restricted key (Boat hides the inventory from restricted keys)"
          : undefined,
      keys: (b.apiKeys ?? []).map((k) => ({
        id: k.id,
        name: k.name,
        lane: k.credentialLane,
        prefix: k.keyPrefix,
        lastFour: k.keyLastFour,
        sandboxId: k.sandboxId,
        expiresAt: k.expiresAt ?? k.scope?.expiresAt ?? null,
        expired: k.expired,
        actions: k.scope?.actions,
        sandboxes: k.scope?.sandboxes,
        environments: k.scope?.environments,
        lastUsedAt: k.lastUsedAt,
      })),
    }),
  ],
  webhooks: [
    "/webhooks",
    (b) =>
      (b.webhooks ?? []).map((w) => ({ id: w.id, name: w.name, url: w.url, events: w.events })),
  ],
  credentialProfiles: [
    "/credential-profiles",
    // Needs `account.admin`; 403 otherwise.
    (b) =>
      (b.profiles ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        isDefault: p.isDefault,
        owner: p.owner?.id,
        canManage: p.canManage,
        connected: p.connected,
        customApis: p.customApis,
      })),
  ],
};
if (includeEnvironments) {
  sections.environments = [
    "/environments",
    (b) =>
      (b.environments ?? []).map((e) => ({
        id: e.id,
        name: e.name,
        isDefault: e.isDefault,
        latestVersionNumber: e.latestVersionNumber,
        safeForThirdParties: e.safeForThirdParties,
        passGithub: e.passGithub,
        passSecrets: e.passSecrets,
        passSandboxCredentials: e.passSandboxCredentials,
        passAgentsCredentials: e.passAgentsCredentials,
        proxyAiCredentials: e.proxyAiCredentials,
        credentialProfileId: e.credentialProfileId,
        varNames: envVarNames(e.envContents),
        secretFilePaths: (e.secretFiles ?? []).map((f) => f.path).sort(),
        repositories: (e.selectedRepositories ?? []).map((r) => r.fullName ?? r.databaseId),
      })),
  ];
}

const report = { baseUrl: BASE, at: new Date().toISOString(), sections: {} };
let exit = 0;
for (const [name, [path, shape]] of Object.entries(sections)) {
  try {
    const r = await get(path);
    if (r.ok) report.sections[name] = { status: r.status, data: shape(r.body ?? {}) };
    else {
      report.sections[name] = {
        status: r.status,
        error: { code: r.code, message: r.message, requestId: r.requestId },
      };
      if (r.status === 401) exit = 3;
      else if (exit === 0) exit = 4;
    }
  } catch (e) {
    report.sections[name] = { error: { code: "transport", message: String(e?.message ?? e) } };
    exit = 1;
  }
}
if (!includeEnvironments) {
  report.sections.environments = {
    skipped: "pass --include-environments (GET may create the default `base` environment)",
  };
}

if (asJson) console.log(JSON.stringify(report, null, 2));
else {
  for (const [name, s] of Object.entries(report.sections)) {
    console.log(`## ${name} ${s.status ?? ""}`);
    console.log(JSON.stringify(s.data ?? s.error ?? s.skipped, null, 2));
  }
}
process.exit(exit);
