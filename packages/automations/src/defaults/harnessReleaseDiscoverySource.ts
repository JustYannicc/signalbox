// Workflow code cannot import the Node-owned discovery module, so this ports its bounded selection rules.
import {
  HARNESS_RELEASE_BACKFILL_LIMITS,
  HARNESS_RELEASE_CODEX_MAX_PAGES,
} from "./harnessReleasePolicy.ts";
import { workflowFunctionSource } from "./workflowFunctionSource.ts";

type Provider = "claude-code" | "claude-agent-sdk" | "codex";
type Selection = "current" | "backfill";
type Candidate = {
  id: string;
  provider: Provider;
  version: string;
  upstreamIdentity: string;
  selection: Selection;
  provenance: Record<string, unknown>;
};

const NPM_PACKAGES = [
  {
    packageName: "@anthropic-ai/claude-code",
    provider: "claude-code",
    backfillLimit: HARNESS_RELEASE_BACKFILL_LIMITS["claude-code"],
  },
  {
    packageName: "@anthropic-ai/claude-agent-sdk",
    provider: "claude-agent-sdk",
    backfillLimit: HARNESS_RELEASE_BACKFILL_LIMITS["claude-agent-sdk"],
  },
] as const;
const CODEX_RELEASE_LIMIT = HARNESS_RELEASE_BACKFILL_LIMITS.codex + 1;
const CODEX_MAX_PAGES = HARNESS_RELEASE_CODEX_MAX_PAGES;
const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function responseJson(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if ("body" in value) return value.body;
  return value;
}

const SOURCE = [
  `const NPM_PACKAGES = ${JSON.stringify(NPM_PACKAGES)};`,
  `const CODEX_RELEASE_LIMIT = ${JSON.stringify(CODEX_RELEASE_LIMIT)};`,
  `const CODEX_MAX_PAGES = ${JSON.stringify(CODEX_MAX_PAGES)};`,
  `const RELEASE_VERSION = /^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$/u;`,
  workflowFunctionSource(isRecord),
  workflowFunctionSource(responseJson),
  workflowFunctionSource(compareText),
  workflowFunctionSource(compareVersions),
  workflowFunctionSource(compareCandidates),
  workflowFunctionSource(stableVersion),
  workflowFunctionSource(makeCandidate),
  workflowFunctionSource(parseNpm),
  workflowFunctionSource(parseCodexPage),
  workflowFunctionSource(selectCodex),
  workflowFunctionSource(nextLink),
  workflowFunctionSource(codexNextUrl),
  workflowFunctionSource(discoverCodex),
].join("\n");

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareVersions(left: string, right: string) {
  const a = left.split(".");
  const b = right.split(".");
  for (let index = 0; index < 3; index += 1) {
    const leftPart = a[index] ?? "";
    const rightPart = b[index] ?? "";
    if (leftPart === rightPart) continue;
    return leftPart.length === rightPart.length
      ? compareText(leftPart, rightPart)
      : leftPart.length - rightPart.length;
  }
  return 0;
}

function compareCandidates(left: Candidate, right: Candidate) {
  return (
    compareVersions(right.version, left.version) ||
    compareText(left.upstreamIdentity, right.upstreamIdentity)
  );
}

function stableVersion(value: unknown): value is string {
  return typeof value === "string" && RELEASE_VERSION.test(value);
}

function makeCandidate(
  provider: Provider,
  version: string,
  upstreamIdentity: string,
  selection: Selection,
  provenance: Record<string, unknown>,
): Candidate {
  return {
    id: `${provider}:${version}:${upstreamIdentity}`,
    provider,
    version,
    upstreamIdentity,
    selection,
    provenance,
  };
}

function parseNpm(packageInfo: unknown, source: (typeof NPM_PACKAGES)[number]): Candidate[] {
  if (
    !isRecord(packageInfo) ||
    packageInfo.name !== source.packageName ||
    !isRecord(packageInfo.versions) ||
    !isRecord(packageInfo["dist-tags"])
  )
    return [];
  const stable = Object.entries(packageInfo.versions)
    .flatMap(([version, metadata]) => {
      if (
        !stableVersion(version) ||
        !isRecord(metadata) ||
        metadata.name !== source.packageName ||
        metadata.version !== version
      )
        return [];
      const dist = isRecord(metadata.dist) ? metadata.dist : {};
      const integrity =
        typeof dist.integrity === "string" && dist.integrity.trim() ? dist.integrity : undefined;
      return [
        {
          version,
          candidate: makeCandidate(
            source.provider,
            version,
            `npm:${source.packageName}`,
            "backfill",
            { kind: "npm", packageName: source.packageName, ...(integrity ? { integrity } : {}) },
          ),
        },
      ];
    })
    .sort((left, right) => compareCandidates(left.candidate, right.candidate));
  const currentVersion = packageInfo["dist-tags"].latest;
  const current =
    typeof currentVersion === "string"
      ? stable.find((release) => release.version === currentVersion)
      : undefined;
  return [
    ...(current
      ? [
          {
            ...current.candidate,
            selection: "current" as const,
          },
        ]
      : []),
    ...stable
      .filter((release) => release.version !== current?.version)
      .slice(0, source.backfillLimit)
      .map((release) => release.candidate),
  ];
}

function parseCodexPage(value: unknown): Candidate[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((release): Candidate[] => {
      if (
        !isRecord(release) ||
        release.draft !== false ||
        release.prerelease !== false ||
        typeof release.tag_name !== "string"
      )
        return [];
      const tagName = release.tag_name;
      const version = /^rust-v(.+)$/u.exec(tagName)?.[1];
      if (!stableVersion(version)) return [];
      const nestedCommit =
        isRecord(release.commit) && typeof release.commit.sha === "string"
          ? release.commit.sha
          : undefined;
      const commitSha = typeof release.commit_sha === "string" ? release.commit_sha : nestedCommit;
      const targetCommitish =
        typeof release.target_commitish === "string" ? release.target_commitish : undefined;
      return [
        makeCandidate("codex", version, `github:openai/codex:${tagName}`, "backfill", {
          kind: "github",
          repository: "openai/codex",
          tagName,
          ...(targetCommitish ? { targetCommitish } : {}),
          ...(commitSha && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(commitSha)
            ? { commitSha }
            : {}),
        }),
      ];
    })
    .sort(compareCandidates);
}

function selectCodex(releases: ReadonlyArray<Candidate>): Candidate[] {
  const seenIds = new Set<string>();
  const seenVersions = new Set<string>();
  return releases
    .filter((release) => !seenIds.has(release.id) && !!seenIds.add(release.id))
    .sort(compareCandidates)
    .filter((release) => !seenVersions.has(release.version) && !!seenVersions.add(release.version))
    .slice(0, CODEX_RELEASE_LIMIT)
    .map((release, index) => ({
      ...release,
      selection: index === 0 ? "current" : "backfill",
    }));
}

function nextLink(header: string | null) {
  return /<([^>]+)>\s*;\s*rel="?next"?/u.exec(header ?? "")?.[1] ?? null;
}

function codexNextUrl(_current: string, candidate: string) {
  const endpoint = "https://api.github.com/repos/openai/codex/releases";
  if (candidate !== endpoint && !candidate.startsWith(`${endpoint}?`))
    throw new Error("Codex release discovery returned an unexpected pagination URL");
  return candidate;
}

async function discoverCodex(w: {
  http(label: string, url: string): Promise<unknown>;
}): Promise<Candidate[]> {
  const releases: Candidate[] = [];
  const seen = new Set<string>();
  const visited = new Set<string>();
  let next = "https://api.github.com/repos/openai/codex/releases?per_page=100&page=1";

  for (let page = 1; page <= CODEX_MAX_PAGES; page += 1) {
    if (visited.has(next)) throw new Error("Codex release discovery pagination loop");
    visited.add(next);
    const response = await w.http("Read Codex release page", next);
    if (isRecord(response) && response.ok === false)
      throw new Error(`Codex release discovery failed with HTTP ${String(response.status)}`);
    const body = responseJson(response);
    if (!Array.isArray(body)) throw new Error("Codex release discovery returned invalid data");
    for (const release of parseCodexPage(body)) {
      if (!seen.has(release.id)) {
        seen.add(release.id);
        releases.push(release);
      }
    }
    const headers = isRecord(response) && isRecord(response.headers) ? response.headers : {};
    const linkHeader = Object.entries(headers).find(([name]) => name.toLowerCase() === "link")?.[1];
    const link = nextLink(typeof linkHeader === "string" ? linkHeader : null);
    if (!link || selectCodex(releases).length >= CODEX_RELEASE_LIMIT) return selectCodex(releases);
    if (page === CODEX_MAX_PAGES)
      throw new Error(`Codex release discovery exceeded ${CODEX_MAX_PAGES} pages`);
    next = codexNextUrl(next, link);
  }
  return selectCodex(releases);
}

export const HARNESS_RELEASE_DISCOVERY_SOURCE = SOURCE;
