import { FetchClientRequest } from "./FetchClientRequest.ts";
import type { LocalRequestOptions, NodeStyleHttpServer } from "./HttpClientTypes.ts";
import { addRequestMarker, attachRequestCancellation } from "./HttpRequestCancellation.ts";
import { connectionRefused, networkError } from "./errors.ts";

export class LocalClientRequest extends FetchClientRequest {
  constructor(options: LocalRequestOptions, fallbackAgent: unknown) {
    super({
      parsed: options.parsed,
      fallbackAgent,
      dispatch(request) {
        const { parsed, binding, registry, handlerFor, env, ctx } = options;
        if (!binding || registry.get(binding.port) !== binding)
          throw connectionRefused(parsed.host, parsed.port);
        const server = binding.server as NodeStyleHttpServer;
        const handler = handlerFor(server);
        if (typeof handler.fetch !== "function")
          throw networkError(
            "ERR_HTTP_SERVER_HANDLER_UNAVAILABLE",
            "Workerd HTTP handler has no fetch method",
          );
        const marker = addRequestMarker(request.headers);
        const removeCancellation = attachRequestCancellation(server, request, marker);
        try {
          return Promise.resolve(handler.fetch(request, env, ctx)).finally(removeCancellation);
        } catch (error) {
          removeCancellation();
          throw error;
        }
      },
    });
  }
}
