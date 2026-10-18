#!/usr/bin/env node

const API = "https://api.cloudflare.com/client/v4";
const PAGE_SIZE = 1000;
const ALCHEMY_STACK_TAG = "alchemy:stack:SignalboxCloud";
const { cloudStage, SIGNALBOX_ZONE_ID } = require("../../apps/cloud/infra/stage.ts");

function parsePullRequestNumber(value) {
  if (!/^[1-9][0-9]*$/.test(String(value ?? ""))) {
    throw new Error("PR_NUMBER must be a positive integer.");
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("PR_NUMBER is outside the supported range.");
  return number;
}

function expectedPreviewBindings(value) {
  const number = parsePullRequestNumber(value);
  const stage = cloudStage(`pr-${number}`);
  return [
    {
      kind: "cloud",
      hostname: stage.cloudDomain,
      service: stage.cloudWorker,
      zone_id: SIGNALBOX_ZONE_ID,
    },
    {
      kind: "gateway",
      hostname: stage.gatewayDomain,
      service: stage.gatewayWorker,
      zone_id: SIGNALBOX_ZONE_ID,
    },
  ];
}

function cleanupPreviewBindings(value) {
  const number = parsePullRequestNumber(value);
  const stage = cloudStage(`pr-${number}`);
  return [
    ...expectedPreviewBindings(number),
    {
      kind: "traces",
      hostname: `traces-${stage.cloudDomain}`,
      service: `${stage.cloudWorker}-traces`,
      zone_id: SIGNALBOX_ZONE_ID,
    },
  ];
}

const isEnabled = (domain) =>
  domain.enabled === true && !["disabled", "inactive"].includes(domain.status);

function bindingMismatch(domains, binding, { required }) {
  const exact = domains.filter(
    (domain) =>
      domain.hostname === binding.hostname &&
      domain.service === binding.service &&
      domain.zone_id === binding.zone_id,
  );
  if (exact.length > 1 && required) return `${binding.kind} has duplicate Worker domain records.`;
  if (required && exact.some((domain) => !isEnabled(domain)))
    return `${binding.kind} Worker domain is disabled or missing enabled state.`;
  if (exact.length > 0) return null;

  const hostMatches = domains.filter((domain) => domain.hostname === binding.hostname);
  const serviceMatches = domains.filter((domain) => domain.service === binding.service);
  if (hostMatches.some((domain) => domain.service !== binding.service)) {
    return `${binding.kind} hostname is attached to the wrong Worker service.`;
  }
  if (hostMatches.some((domain) => domain.zone_id !== binding.zone_id)) {
    return `${binding.kind} hostname is attached in the wrong zone.`;
  }
  if (serviceMatches.some((domain) => domain.hostname !== binding.hostname)) {
    return `${binding.kind} Worker service has the wrong hostname.`;
  }
  if (serviceMatches.some((domain) => domain.zone_id !== binding.zone_id)) {
    return `${binding.kind} Worker service is attached in the wrong zone.`;
  }
  return required ? `${binding.kind} Worker domain is not attached.` : null;
}

function verifyPreviewBindings(domains, value) {
  const number = parsePullRequestNumber(value);
  return expectedPreviewBindings(number)
    .map((binding) => bindingMismatch(domains, binding, { required: true }))
    .filter(Boolean)
    .map((message) => `The #${number} preview ${message}`);
}

function previewDomainNumbers(domain) {
  const hostname = /(?:^|[-.])preview-([1-9][0-9]*)\.signalbox\.run$/.exec(domain.hostname ?? "");
  return new Set(hostname ? [Number(hostname[1])] : []);
}

function alchemyStageServices(scripts, value) {
  if (!Array.isArray(scripts)) {
    throw new Error("Cloudflare Workers Scripts API returned an invalid script list.");
  }

  const number = parsePullRequestNumber(value);
  const stageTag = `alchemy:stage:pr-${number}`;
  const services = new Set();
  const seen = new Set();
  for (const script of scripts) {
    if (typeof script?.id !== "string" || script.id.length === 0) {
      throw new Error("Cloudflare Workers Scripts API returned incomplete script metadata.");
    }
    if (seen.has(script.id)) {
      throw new Error("Cloudflare Workers Scripts API returned duplicate script metadata.");
    }
    seen.add(script.id);
    if (
      script.tags !== undefined &&
      (!Array.isArray(script.tags) || script.tags.some((tag) => typeof tag !== "string"))
    ) {
      throw new Error("Cloudflare Workers Scripts API returned invalid script tags.");
    }
    if (script.tags?.includes(ALCHEMY_STACK_TAG) && script.tags.includes(stageTag)) {
      services.add(script.id);
    }
  }
  return services;
}

function verifyOneDomainPreviewBindings(domains, scripts, value) {
  const number = parsePullRequestNumber(value);
  const stageServices = alchemyStageServices(scripts, number);
  const appBinding = expectedPreviewBindings(number)[0];
  const errors = [bindingMismatch(domains, appBinding, { required: true })].filter(Boolean);
  const stageDomains = domains.filter((domain) => {
    const hostnameNumbers = previewDomainNumbers(domain);
    return hostnameNumbers.has(number) || stageServices.has(domain.service);
  });
  if (stageDomains.length !== 1) {
    errors.push(`has ${stageDomains.length} Worker domain records; expected exactly one.`);
  }
  return errors.map((message) => `The #${number} preview ${message}`);
}

function matchingPreviewBindings(domains, value) {
  const number = parsePullRequestNumber(value);
  const bindings = cleanupPreviewBindings(number);
  const mismatches = bindings
    .map((binding) => bindingMismatch(domains, binding, { required: false }))
    .filter(Boolean);
  if (mismatches.length > 0) {
    throw new Error(
      `Cannot safely detach Worker domains for the #${number} preview: ${mismatches[0]}`,
    );
  }
  return domains.filter((domain) =>
    bindings.some(
      (binding) =>
        domain.hostname === binding.hostname &&
        domain.service === binding.service &&
        domain.zone_id === binding.zone_id,
    ),
  );
}

function managedPreviewNumber(domain) {
  const candidates = new Set([
    /-([1-9][0-9]*)\.signalbox\.run$/.exec(domain.hostname ?? "")?.[1],
    /-([1-9][0-9]*)$/.exec(domain.service ?? "")?.[1],
  ]);
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const number = Number(candidate);
    if (
      Number.isSafeInteger(number) &&
      cleanupPreviewBindings(number).some(
        (binding) => binding.hostname === domain.hostname && binding.service === domain.service,
      )
    ) {
      return number;
    }
  }
  return null;
}

async function requestJson(fetcher, url, token, init, resource) {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetcher(url, {
    ...init,
    headers,
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Cloudflare ${resource} API returned invalid JSON (HTTP ${response.status}).`);
  }
  if (!response.ok || payload?.success !== true) {
    throw new Error(`Cloudflare ${resource} API request failed (HTTP ${response.status}).`);
  }
  return payload;
}

async function listWorkerDomains(accountId, token, fetcher = fetch) {
  const domains = [];
  for (let page = 1; page <= 1000; page += 1) {
    const url = new URL(`${API}/accounts/${encodeURIComponent(accountId)}/workers/domains`);
    url.searchParams.set("per_page", String(PAGE_SIZE));
    url.searchParams.set("page", String(page));
    const payload = await requestJson(fetcher, url, token, undefined, "Workers Domains");
    if (!Array.isArray(payload.result)) {
      throw new Error("Cloudflare Workers Domains API returned an invalid domain list.");
    }
    domains.push(...payload.result);
    const rawTotalPages = payload.result_info?.total_pages;
    if (rawTotalPages === undefined && payload.result.length < PAGE_SIZE) return domains;
    const totalPages = Number(rawTotalPages);
    if (!Number.isSafeInteger(totalPages) || totalPages < 1) {
      throw new Error("Cloudflare Workers Domains API returned invalid pagination metadata.");
    }
    if (page >= totalPages) return domains;
  }
  throw new Error("Cloudflare Workers Domains API pagination exceeded the safety limit.");
}

async function listWorkerScripts(accountId, token, fetcher = fetch) {
  const url = `${API}/accounts/${encodeURIComponent(accountId)}/workers/scripts`;
  const payload = await requestJson(fetcher, url, token, undefined, "Workers Scripts");
  if (!Array.isArray(payload.result)) {
    throw new Error("Cloudflare Workers Scripts API returned an invalid script list.");
  }

  // The scripts endpoint is single-page and has no page parameters. Fail closed
  // if a response ever advertises pagination instead of treating it as complete.
  const info = payload.result_info;
  if (info !== undefined) {
    if (typeof info !== "object" || info === null || Array.isArray(info)) {
      throw new Error("Cloudflare Workers Scripts API returned incomplete script metadata.");
    }
    const totalPages = info.total_pages === undefined ? 1 : Number(info.total_pages);
    const page = info.page === undefined ? 1 : Number(info.page);
    const count = info.count === undefined ? payload.result.length : Number(info.count);
    const totalCount =
      info.total_count === undefined ? payload.result.length : Number(info.total_count);
    if (
      !Number.isSafeInteger(totalPages) ||
      totalPages !== 1 ||
      !Number.isSafeInteger(page) ||
      page !== 1 ||
      !Number.isSafeInteger(count) ||
      count !== payload.result.length ||
      !Number.isSafeInteger(totalCount) ||
      totalCount !== payload.result.length
    ) {
      throw new Error("Cloudflare Workers Scripts API returned incomplete script metadata.");
    }
  }
  return payload.result;
}

async function detachClosedPreviewDomains(accountId, token, prNumber, fetcher = fetch) {
  const number = parsePullRequestNumber(prNumber);
  const before = await listWorkerDomains(accountId, token, fetcher);
  const selected = matchingPreviewBindings(before, number);
  for (const domain of selected) {
    if (typeof domain.id !== "string" || domain.id.length === 0) {
      throw new Error(
        `Cannot safely detach a Worker domain for the #${number} preview: missing domain ID.`,
      );
    }
    const url = `${API}/accounts/${encodeURIComponent(accountId)}/workers/domains/${encodeURIComponent(domain.id)}`;
    await requestJson(fetcher, url, token, { method: "DELETE" }, "Workers Domains");
  }
  const remaining = matchingPreviewBindings(
    await listWorkerDomains(accountId, token, fetcher),
    number,
  );
  if (remaining.length > 0) {
    throw new Error(
      `Cloudflare still lists ${remaining.length} Worker domain record(s) for the #${number} preview.`,
    );
  }
  return selected.length;
}

function assertPreviewStage(stage, prNumber) {
  const number = parsePullRequestNumber(prNumber);
  if (stage !== `pr-${number}`)
    throw new Error("The Worker domain check only accepts the matching PR preview stage.");
  return number;
}

async function main() {
  const [command] = process.argv.slice(2);
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) throw new Error("Cloudflare account credentials are required.");

  if (command === "verify") {
    const number = assertPreviewStage(process.env.STAGE, process.env.PR_NUMBER);
    const domains = await listWorkerDomains(accountId, token);
    const errors = verifyPreviewBindings(domains, number);
    if (errors.length > 0) {
      throw new Error(
        `Cloudflare did not attach the expected Worker domain bindings for the #${number} preview: ${errors.join(" ")} DNS resolution is checked separately; retry after correcting the Worker domain attachment.`,
      );
    }
    console.log(`Cloudflare Worker domains are attached for the #${number} preview.`);
    return;
  }

  if (command === "verify-one-domain") {
    const number = assertPreviewStage(process.env.STAGE, process.env.PR_NUMBER);
    const domains = await listWorkerDomains(accountId, token);
    const scripts = await listWorkerScripts(accountId, token);
    const errors = verifyOneDomainPreviewBindings(domains, scripts, number);
    if (errors.length > 0) {
      throw new Error(
        `Cloudflare did not attach the expected single Worker domain for the #${number} preview: ${errors.join(" ")} DNS resolution is checked separately; retry after correcting the Worker domain attachment.`,
      );
    }
    console.log(`Cloudflare's single Worker domain is attached for the #${number} preview.`);
    return;
  }

  if (command === "delete") {
    const count = await detachClosedPreviewDomains(accountId, token, process.env.PR_NUMBER);
    console.log(
      count === 0
        ? `No stale Worker domains remain for the #${process.env.PR_NUMBER} preview.`
        : `Detached ${count} stale Worker domain record(s) for the #${process.env.PR_NUMBER} preview.`,
    );
    return;
  }

  if (command === "list-prs") {
    const domains = await listWorkerDomains(accountId, token);
    const numbers = new Set(domains.map(managedPreviewNumber).filter(Number.isSafeInteger));
    for (const number of [...numbers].sort((left, right) => left - right)) console.log(number);
    return;
  }

  throw new Error("Use one of: verify, verify-one-domain, delete, list-prs.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertPreviewStage,
  cleanupPreviewBindings,
  detachClosedPreviewDomains,
  expectedPreviewBindings,
  listWorkerDomains,
  managedPreviewNumber,
  matchingPreviewBindings,
  parsePullRequestNumber,
  listWorkerScripts,
  alchemyStageServices,
  previewDomainNumbers,
  verifyPreviewBindings,
  verifyOneDomainPreviewBindings,
};
