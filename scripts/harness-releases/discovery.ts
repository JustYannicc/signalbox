export const CLAUDE_RELEASE_BACKFILL_LIMIT = 50;
export const CODEX_RELEASE_BACKFILL_LIMIT = 10;

const CODEX_URL = "https://api.github.com/repos/openai/codex/releases";
const CODEX_MAX_PAGES = 10;
const CODEX_LIMIT = CODEX_RELEASE_BACKFILL_LIMIT + 1;
const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const NPM_SOURCES = [
  { packageName: "@anthropic-ai/claude-code", provider: "claude-code", backfillLimit: 50 },
  { packageName: "@anthropic-ai/claude-agent-sdk", provider: "claude-agent-sdk", backfillLimit: 0 },
] as const;

export type NpmPackageName = (typeof NPM_SOURCES)[number]["packageName"];
export type HarnessProvider = (typeof NPM_SOURCES)[number]["provider"] | "codex";
export type ReleaseSelection = "current" | "backfill";
export type ReleaseProvenance =
  | { readonly kind: "npm"; readonly packageName: NpmPackageName; readonly integrity?: string }
  | {
      readonly kind: "github";
      readonly repository: "openai/codex";
      readonly tagName: string;
      readonly targetCommitish?: string;
      readonly commitSha?: string;
    };

export interface ParsedHarnessRelease {
  readonly id: string;
  readonly provider: HarnessProvider;
  readonly version: string;
  readonly upstreamIdentity: string;
  readonly publishedAt?: string;
  readonly provenance: ReleaseProvenance;
}

export interface HarnessRelease extends ParsedHarnessRelease {
  readonly selection: ReleaseSelection;
}

export interface ParsedNpmPackageMetadata {
  readonly packageName: NpmPackageName;
  readonly current: ParsedHarnessRelease | null;
  readonly stableReleases: ReadonlyArray<ParsedHarnessRelease>;
}

export interface ReleaseDiscoveryResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export type ReleaseDiscoveryHttp = (url: string) => Promise<ReleaseDiscoveryResponse>;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

export function isStrictStableVersion(value: unknown): value is string {
  return typeof value === "string" && RELEASE_VERSION.test(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".");
  const b = right.split(".");
  return [0, 1, 2].reduce((result, index) => {
    if (result) return result;
    const leftPart = a[index] ?? "";
    const rightPart = b[index] ?? "";
    return leftPart.length === rightPart.length
      ? compareText(leftPart, rightPart)
      : leftPart.length - rightPart.length;
  }, 0);
}

function compareReleases(left: ParsedHarnessRelease, right: ParsedHarnessRelease): number {
  return (
    compareVersions(right.version, left.version) ||
    compareText(left.upstreamIdentity, right.upstreamIdentity)
  );
}

function makeRelease(
  provider: HarnessProvider,
  version: string,
  upstreamIdentity: string,
  provenance: ReleaseProvenance,
  publishedAt?: string,
): ParsedHarnessRelease {
  return {
    id: `${provider}:${version}:${upstreamIdentity}`,
    provider,
    version,
    upstreamIdentity,
    ...(publishedAt ? { publishedAt } : {}),
    provenance,
  };
}

export function parseNpmPackageMetadata(
  packageName: NpmPackageName,
  value: unknown,
): ParsedNpmPackageMetadata {
  const source = NPM_SOURCES.find((item) => item.packageName === packageName);
  if (
    !source ||
    !record(value) ||
    value.name !== packageName ||
    !record(value.versions) ||
    !record(value["dist-tags"])
  ) {
    return { packageName, current: null, stableReleases: [] };
  }

  const times = record(value.time) ? value.time : {};
  const stableReleases = Object.entries(value.versions)
    .flatMap(([version, metadata]) => {
      if (
        !isStrictStableVersion(version) ||
        !record(metadata) ||
        metadata.name !== packageName ||
        metadata.version !== version
      ) {
        return [];
      }
      const dist = record(metadata.dist) ? metadata.dist : {};
      const integrity = text(dist.integrity);
      return [
        makeRelease(
          source.provider,
          version,
          `npm:${packageName}`,
          { kind: "npm", packageName, ...(integrity ? { integrity } : {}) },
          text(times[version]),
        ),
      ];
    })
    .sort(compareReleases);

  const latest = value["dist-tags"].latest;
  const current =
    typeof latest === "string"
      ? (stableReleases.find((release) => release.version === latest) ?? null)
      : null;
  return { packageName, current, stableReleases };
}

export function selectNpmReleases(
  metadata: ParsedNpmPackageMetadata,
): ReadonlyArray<HarnessRelease> {
  const limit =
    NPM_SOURCES.find((item) => item.packageName === metadata.packageName)?.backfillLimit ?? 0;
  const current = metadata.current;
  const history = metadata.stableReleases
    .filter((release) => release.version !== current?.version)
    .sort(compareReleases)
    .slice(0, limit)
    .map((release) => ({ ...release, selection: "backfill" as const }));
  return [...(current ? [{ ...current, selection: "current" as const }] : []), ...history];
}

function uniqueById(releases: ReadonlyArray<ParsedHarnessRelease>): ParsedHarnessRelease[] {
  const seen = new Set<string>();
  return releases.filter((release) => !seen.has(release.id) && !!seen.add(release.id));
}

function commitSha(value: Record<string, unknown>): string | undefined {
  const commit = record(value.commit) ? text(value.commit.sha) : undefined;
  const sha = text(value.commit_sha) ?? commit;
  return sha && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(sha) ? sha : undefined;
}

export function parseCodexReleasePage(value: unknown): ReadonlyArray<ParsedHarnessRelease> {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item): ParsedHarnessRelease[] => {
      if (
        !record(item) ||
        item.draft !== false ||
        item.prerelease !== false ||
        typeof item.tag_name !== "string"
      ) {
        return [];
      }
      const tagName = item.tag_name;
      const version = /^rust-v(.+)$/u.exec(tagName)?.[1];
      if (!isStrictStableVersion(version)) return [];
      const targetCommitish = text(item.target_commitish);
      const sha = commitSha(item);
      return [
        makeRelease(
          "codex",
          version,
          `github:openai/codex:${tagName}`,
          {
            kind: "github",
            repository: "openai/codex",
            tagName,
            ...(targetCommitish ? { targetCommitish } : {}),
            ...(sha ? { commitSha: sha } : {}),
          },
          text(item.published_at),
        ),
      ];
    })
    .sort(compareReleases);
}

export function selectCodexReleases(
  stableReleases: ReadonlyArray<ParsedHarnessRelease>,
): ReadonlyArray<HarnessRelease> {
  const versions = new Set<string>();
  return uniqueById(stableReleases)
    .sort(compareReleases)
    .filter((release) => !versions.has(release.version) && !!versions.add(release.version))
    .slice(0, CODEX_LIMIT)
    .map((release, index) => ({ ...release, selection: index === 0 ? "current" : "backfill" }));
}

function nextLink(header: string | null): string | null {
  return /<([^>]+)>\s*;\s*rel="?next"?/u.exec(header ?? "")?.[1] ?? null;
}

function codexNextUrl(current: string, candidate: string): string {
  const next = new URL(candidate, current);
  if (
    next.origin !== "https://api.github.com" ||
    next.pathname !== "/repos/openai/codex/releases"
  ) {
    throw new Error("Codex release discovery returned an unexpected pagination URL");
  }
  return next.toString();
}

async function requestJson(http: ReleaseDiscoveryHttp, url: string) {
  const response = await http(url);
  if (!response.ok)
    throw new Error(`Release discovery failed with HTTP ${response.status}: ${url}`);
  return { body: await response.json(), headers: response.headers };
}

async function discoverCodexReleases(
  http: ReleaseDiscoveryHttp,
): Promise<ReadonlyArray<ParsedHarnessRelease>> {
  const releases: ParsedHarnessRelease[] = [];
  const seen = new Set<string>();
  const visited = new Set<string>();
  const url = new URL(CODEX_URL);
  url.searchParams.set("per_page", "100");
  url.searchParams.set("page", "1");
  let next = url.toString();

  for (let page = 1; page <= CODEX_MAX_PAGES; page += 1) {
    if (visited.has(next)) throw new Error("Codex release discovery pagination loop");
    visited.add(next);
    const response = await requestJson(http, next);
    for (const release of parseCodexReleasePage(response.body)) {
      if (!seen.has(release.id)) {
        seen.add(release.id);
        releases.push(release);
      }
    }
    const link = nextLink(response.headers.get("link"));
    if (!link || selectCodexReleases(releases).length >= CODEX_LIMIT) return releases;
    if (page === CODEX_MAX_PAGES)
      throw new Error(`Codex release discovery exceeded ${CODEX_MAX_PAGES} pages`);
    next = codexNextUrl(next, link);
  }
  return releases;
}

function currentFirst(groups: ReadonlyArray<ReadonlyArray<HarnessRelease>>): HarnessRelease[] {
  const releases = groups.flat();
  return [
    ...releases.filter((release) => release.selection === "current"),
    ...releases.filter((release) => release.selection === "backfill"),
  ];
}

export async function discoverHarnessReleases(
  http: ReleaseDiscoveryHttp,
): Promise<ReadonlyArray<HarnessRelease>> {
  const npmGroups: HarnessRelease[][] = [];
  for (const { packageName } of NPM_SOURCES) {
    const response = await requestJson(http, `https://registry.npmjs.org/${packageName}`);
    const metadata = parseNpmPackageMetadata(packageName, response.body);
    if (!metadata.current)
      throw new Error(`No stable current release in npm metadata for ${packageName}`);
    npmGroups.push([...selectNpmReleases(metadata)]);
  }

  const codex = selectCodexReleases(await discoverCodexReleases(http));
  if (codex.length === 0)
    throw new Error("No stable Codex releases found in official release metadata");
  return currentFirst([...npmGroups, codex]);
}
