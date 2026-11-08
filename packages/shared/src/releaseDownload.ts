export interface ReleaseDownloadOptions {
  readonly fetch?: typeof fetch | undefined;
  readonly token?: string | undefined;
  readonly failurePrefix: string;
}

class DownloadFailure extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean, options?: ErrorOptions) {
    super(message, options);
    this.retryable = retryable;
  }
}

/** Retries transport failures within one deadline, including the GitHub API fallback. */
export async function downloadRelease<T>(
  url: string,
  read: (response: Response) => Promise<T>,
  options: ReleaseDownloadOptions,
): Promise<T> {
  const fetchAsset = options.fetch ?? fetch;
  const deadline = Date.now() + 60_000;
  const failure = (suffix: string, retryable: boolean, cause?: unknown) =>
    new DownloadFailure(`${options.failurePrefix}:${suffix}`, retryable, { cause });

  async function request<R>(
    address: string,
    consume: (response: Response) => Promise<R>,
    until: number,
    headers?: HeadersInit,
    attempts = 4,
  ): Promise<R> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const remaining = until - Date.now();
      if (remaining <= 0) throw failure("TIMEOUT", true);
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          (async () => {
            let response: Response;
            try {
              response = await fetchAsset(address, {
                signal: controller.signal,
                ...(headers === undefined ? {} : { headers }),
              });
            } catch (cause) {
              throw failure("NETWORK", true, cause);
            }
            if (!response.ok) {
              void response.body?.cancel().catch(() => undefined);
              throw failure(
                String(response.status),
                response.status === 429 || (response.status >= 500 && response.status < 600),
              );
            }
            if (new URL(response.url || address).protocol !== "https:")
              throw failure("INSECURE_REDIRECT", false);
            try {
              return await consume(response);
            } catch (cause) {
              if (
                cause instanceof TypeError ||
                (cause instanceof DOMException && cause.name === "AbortError")
              )
                throw failure("NETWORK", true, cause);
              throw cause;
            }
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => {
                reject(failure("TIMEOUT", true));
                controller.abort();
              },
              Math.min(attempts === 1 ? 60_000 : 8_000, remaining),
            );
          }),
        ]);
      } catch (error) {
        clearTimeout(timer);
        if (!(error instanceof DownloadFailure) || !error.retryable || attempt === attempts - 1)
          throw error;
        const delay = 1_000 * 2 ** attempt;
        if (Date.now() + delay >= until) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
      } finally {
        clearTimeout(timer);
      }
    }
    throw failure("ATTEMPTS_EXHAUSTED", false);
  }

  const release =
    /^https:\/\/github\.com\/JustYannicc\/signalbox\/releases\/download\/([^/]+)\/([^/?#]+)$/.exec(
      url,
    );
  try {
    // Reserve the fourth asset download attempt for the independent API route.
    return await request(
      url,
      read,
      release ? Math.min(deadline, Date.now() + 25_000) : deadline,
      undefined,
      release ? 3 : 4,
    );
  } catch (error) {
    if (!(error instanceof DownloadFailure) || !release) throw error;
  }

  // Credentials only accompany validated API URLs, never public or third-party asset URLs.
  const headers = {
    Accept: "application/vnd.github+json",
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
  };
  const metadata: unknown = await request(
    `https://api.github.com/repos/JustYannicc/signalbox/releases/tags/${release[1]}`,
    (response) => response.json(),
    deadline,
    headers,
  );
  const name = decodeURIComponent(release[2]!);
  if (
    !metadata ||
    typeof metadata !== "object" ||
    !("assets" in metadata) ||
    !Array.isArray(metadata.assets)
  )
    throw failure("API_METADATA_INVALID", false);
  const asset: unknown = metadata.assets.find(
    (value: unknown) =>
      value !== null && typeof value === "object" && "name" in value && value.name === name,
  );
  if (
    !asset ||
    typeof asset !== "object" ||
    !("url" in asset) ||
    typeof asset.url !== "string" ||
    !/^https:\/\/api\.github\.com\/repos\/JustYannicc\/signalbox\/releases\/assets\/\d+$/.test(
      asset.url,
    )
  )
    throw failure(`API_ASSET_MISSING:${name}`, false);
  return request(asset.url, read, deadline, { ...headers, Accept: "application/octet-stream" }, 1);
}
