/**
 * One Durable Object per person, standing in for the cloud's `UserObject`.
 * It only routes HTTP onto the host (`host.ts`) and forwards the alarm.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { DEPLOY } from "./deploy.ts";
import { makeHostForObject } from "./host.ts";

/** Changes every time this isolate starts, so a status read shows a restart. */
const BOOT = crypto.randomUUID();

export default class AutomationHost extends Cloudflare.DurableObject<AutomationHost>()(
  "AutomationHost",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;

    // @effect-diagnostics-next-line returnEffectInGen:off
    return Effect.gen(function* () {
      const host = yield* makeHostForObject(state.raw as unknown as DurableObjectState, {
        deploy: DEPLOY,
        boot: BOOT,
      });

      const route = Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        host.setOrigin(`https://${request.headers.host ?? "localhost"}`);
        const path = request.url.split("?")[0]!;
        const body =
          request.method === "GET"
            ? {}
            : ((yield* request.json.pipe(Effect.orElseSucceed(() => ({})))) as Record<
                string,
                unknown
              >);

        if (request.method === "GET" && path === "/") return yield* host.status;
        if (request.method === "POST" && path === "/runs") {
          return {
            runId: yield* host.start(body as unknown as { automation: string; input: unknown }),
          };
        }
        let match = /^\/asks\/(\d+)\/answer$/.exec(path);
        if (request.method === "POST" && match) {
          return yield* host.answer(
            Number(match[1]),
            body as { choice?: string; values?: Record<string, unknown> },
          );
        }
        if (request.method === "POST" && path === "/events") {
          const { event, ...fields } = body as { event: string };
          return yield* host.emit(event, fields);
        }
        match = /^\/threads\/([^/]+)\/turn$/.exec(path);
        if (request.method === "POST" && match) {
          const { text, pullRequest } = body as {
            text: string;
            pullRequest?: { number: number; url: string };
          };
          return yield* host.finishTurn(decodeURIComponent(match[1]!), text, pullRequest ?? null);
        }
        match = /^\/hooks\/([^/]+)$/.exec(path);
        if (match) return yield* host.hookCalled(match[1]!, request.method, body);
        return { error: `No route for ${request.method} ${path}` };
      });

      return {
        fetch: route.pipe(
          Effect.flatMap((result) =>
            HttpServerResponse.json(result, { status: "error" in result ? 404 : 200 }),
          ),
          // Validation errors (a bad answer, an unknown thread) come back as 400s.
          Effect.catchCause((cause) =>
            HttpServerResponse.json({ error: String(cause) }, { status: 400 }).pipe(Effect.orDie),
          ),
        ),
        alarm: () => host.alarm,
      };
    });
  }),
) {}
