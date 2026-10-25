import type { Computer } from "../computer/Computer.ts";

export function createCodexFetch(input: {
  readonly computer: Pick<Computer, "port">;
  readonly signal: AbortSignal;
  readonly modelOrigins: ReadonlyArray<string>;
  readonly modelTransport: (request: Request) => Promise<Response>;
  readonly fetch: (request: Request) => Promise<Response>;
}) {
  const modelOrigins = new Set(
    input.modelOrigins.map((value) => {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol) || url.origin !== value)
        throw new TypeError("Codex model routes must be explicit HTTP origins");
      return url.origin;
    }),
  );
  return async (original: Request) => {
    input.signal.throwIfAborted();
    const request = new Request(original, {
      signal: AbortSignal.any([original.signal, input.signal]),
    });
    const url = new URL(request.url);
    if (modelOrigins.has(url.origin)) return input.modelTransport(request);
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
      const target = await input.computer.port(port, request.signal);
      request.signal.throwIfAborted();
      return target.fetch(request);
    }
    return input.fetch(request);
  };
}
