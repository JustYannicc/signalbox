import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { AUTOMATIONS_CLOUD_ONLY_MESSAGE } from "../signalbox/automationAvailability.ts";

const hookIdOf = (url: string) => {
  let pathname: string;
  try {
    pathname = new URL(url, "http://localhost").pathname;
  } catch {
    return undefined;
  }
  const match = /^\/api\/hooks\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return undefined;
  }
};

const isLegacyAutomationHook = (url: string) => {
  const hookId = hookIdOf(url);
  return hookId?.startsWith("automation_") === true || hookId?.startsWith("callback_") === true;
};

/** Old run links must stop at the server; treating them as scheduled tasks hides the migration. */
export const automationWebhookMiddleware = HttpRouter.middleware((httpEffect) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    isLegacyAutomationHook(request.url)
      ? Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            {
              error: "automations_cloud_only",
              message: AUTOMATIONS_CLOUD_ONLY_MESSAGE,
            },
            { status: 410, headers: { "x-t3-hook-outcome": "disabled" } },
          ),
        )
      : httpEffect,
  ),
);
