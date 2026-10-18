/** Runtime evidence only. The deployed manifest does not identify a surviving container. */
export interface CliProxyApiRelease {
  readonly source: "management-headers" | "unknown";
  readonly version: string | null;
  readonly commit: string | null;
  readonly buildDate: string | null;
}

export const unknownRelease: CliProxyApiRelease = {
  source: "unknown",
  version: null,
  commit: null,
  buildDate: null,
};

export const isManagementRequest = (request: Request, baseUrl?: string) => {
  const path = new URL(request.url).pathname;
  const basePath = baseUrl === undefined ? "" : new URL(baseUrl).pathname.replace(/\/$/u, "");
  return (
    path.startsWith(basePath) && /^\/v(?:0|8)\/management\//u.test(path.slice(basePath.length))
  );
};

// Upstream v8.0.32 management Middleware sets these before authenticating:
// https://github.com/router-for-me/CLIProxyAPI/blob/911f49cbd49f4fe2516979754a7488a3fd14fe64/internal/api/handlers/management/handler.go
// Model replies have no such contract. Only bounded release-shaped values may reach events.
export const releaseFromHeaders = (headers: Headers): CliProxyApiRelease => {
  const version = headers.get("x-cpa-version");
  if (
    version === null ||
    version.length > 64 ||
    !/^v?\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/u.test(version)
  ) {
    return unknownRelease;
  }
  const commit = headers.get("x-cpa-commit");
  const buildDate = headers.get("x-cpa-build-date");
  return {
    source: "management-headers",
    version: version.replace(/^v/u, ""),
    commit: commit !== null && /^[a-f\d]{7,40}$/iu.test(commit) ? commit : null,
    buildDate:
      buildDate !== null && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(buildDate)
        ? buildDate
        : null,
  };
};

/** One managed container lifetime, never persisted across object eviction or backing changes. */
export const makeReleaseObserver = (changed: (release: CliProxyApiRelease) => void = () => {}) => {
  let release = unknownRelease;
  let generation = 0;
  return {
    current: () => release,
    reset: () => {
      generation += 1;
      release = unknownRelease;
    },
    observe: (request: Request, send: () => Promise<Response>) => {
      if (!isManagementRequest(request)) return send();
      const sentGeneration = generation;
      return send().then((response) => {
        if (sentGeneration === generation) {
          const next = releaseFromHeaders(response.headers);
          if (
            next.version !== release.version ||
            next.commit !== release.commit ||
            next.buildDate !== release.buildDate
          ) {
            release = next;
            changed(release);
          }
        }
        return response;
      });
    },
  };
};
