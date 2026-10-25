// @effect-diagnostics globalFetch:off - observe native HTTP failures without an Effect runtime.
export const requestJson = async (
  url: URL,
  init: RequestInit,
  wrapResult = false,
  fetcher: typeof fetch = fetch,
) => {
  const started = performance.now();
  const redact = (message: string) => message.replaceAll(url.host, "[probe]");
  try {
    const response = await fetcher(url, init);
    const body = await response.text();
    if (!response.ok) {
      return {
        clientWallMs: performance.now() - started,
        response: { status: response.status, error: redact(body.slice(0, 1000)) },
      };
    }
    try {
      const value: unknown = JSON.parse(body);
      return {
        clientWallMs: performance.now() - started,
        response: wrapResult ? { status: response.status, result: value } : value,
      };
    } catch {
      return {
        clientWallMs: performance.now() - started,
        response: {
          status: response.status,
          error: `Invalid JSON response: ${redact(body.slice(0, 1000))}`,
          parseFailure: true,
        },
      };
    }
  } catch (error) {
    return {
      clientWallMs: performance.now() - started,
      response: { error: redact(String(error)), transportFailure: true },
    };
  }
};
