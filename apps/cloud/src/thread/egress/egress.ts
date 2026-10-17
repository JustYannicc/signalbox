// @effect-diagnostics globalFetch:off - the machine's requests pass through the Workers runtime's own fetch, streams untouched, outside Effect.
import { listedNames } from "@signalbox/runner-protocol/SecretPlaceholders";

import type { SecretValues } from "../runner/secretValues.ts";
import type { EgressDispatchAnswer } from "./egressDispatch.ts";
import { redactEgressResponse } from "./egressResponse.ts";
import { readEgressRequest } from "./egressRequest.ts";
import { bridgeWebSocket, isWebSocketUpgrade } from "./webSocketBridge.ts";
import type { SendAnswer, SendRequest } from "./ThreadSends.ts";

/**
 * Every HTTP and HTTPS request a thread's light machine makes (#592),
 * intercepted outside the container (`CloudflareMachineBackend.ts`): it goes
 * on as it is, unless it carries one of the thread's secrets. Then it goes,
 * placeholders filled, only to a host the person allowed (`ThreadSends.ts`);
 * anything else is refused with a reason the agent reads, never sent with the
 * placeholder or the value in it.
 *
 * Signalbox's own hosts are left alone: the Runner talks to them, and the
 * harness's model requests go through the ModelGateway, which turns every
 * value back into its placeholder for the model (#591).
 */

/** How long a send waits on the person's answer before it's refused for now. */
export const ASK_WAIT_MS = 50_000;

/** The header refusals carry, so a program's own logs say who refused. */
export const REFUSED_HEADER = "x-signalbox-refused";

export interface EgressThread {
  /** The values the thread's machine registered; empty when none. */
  readonly secrets: () => Promise<SecretValues>;
  readonly authorize: (input: SendRequest) => Promise<SendAnswer>;
}

const refused = (message: string) =>
  new Response(`${message}\n`, {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8", [REFUSED_HEADER]: "secret" },
  });

export async function serveEgress(
  request: Request,
  input: {
    readonly thread: EgressThread;
    /** Signalbox's own hosts, which the machine reaches as it is. */
    readonly ownHosts: ReadonlySet<string>;
    readonly send?: (request: Request) => Promise<Response>;
    /** Production dispatch runs in the thread object under the registration lock. */
    readonly dispatch?: (request: Request, revision: number) => Promise<EgressDispatchAnswer>;
    /** A narrowly validated platform upload capability, when one is bound. */
    readonly platformUpload?: (request: Request) => Promise<Response | null>;
  },
): Promise<Response> {
  const send =
    input.send ??
    ((outgoing: Request) =>
      isWebSocketUpgrade(outgoing)
        ? bridgeWebSocket(outgoing)
        : fetch(outgoing, { encodeResponseBody: "manual" }));
  if (input.ownHosts.has(new URL(request.url).host)) return send(request);
  if (input.platformUpload !== undefined) {
    try {
      const response = await input.platformUpload(request);
      if (response !== null) return response;
    } catch {
      return refused("Signalbox refused this platform upload safely.");
    }
  }
  let secrets = await input.thread.secrets();
  if (secrets.current.length === 0 && secrets.values.length === 0) return send(request);
  if (isWebSocketUpgrade(request) || request.method === "TRACE") {
    return refused(
      "Signalbox didn't send this request: secrets require a redactable HTTPS request and response.",
    );
  }
  let pending = request;
  // Dispatch rejects a stale revision; the non-atomic test fallback re-reads after approval.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const read = await readEgressRequest(pending, secrets.current, secrets.values).catch(
      () => null,
    );
    if (read === null)
      return refused("Signalbox didn't send this request: it could not be inspected safely.");
    if (read.refusal !== null)
      return refused(`Signalbox didn't send this request: ${read.refusal}`);
    if (read.unknown.size > 0) {
      return refused(
        `Signalbox didn't send this request: this thread has no secret called ${listedNames(read.unknown)}.`,
      );
    }

    if (read.secrets.size > 0 && !read.https) {
      return refused(
        `Signalbox didn't send this request: it carries ${listedNames(read.secrets)} over plain HTTP. Use https://.`,
      );
    }
    if (read.secrets.size > 0) {
      const answer = await input.thread.authorize({
        host: read.host,
        names: [...read.secrets].toSorted(),
        waitMs: ASK_WAIT_MS,
      });
      if (answer._tag !== "allowed")
        return refused(`Signalbox didn't send this request: ${answer.message}`);
    }
    if (input.dispatch === undefined) {
      const current = await input.thread.secrets();
      if (secrets.revision !== current.revision) {
        secrets = current;
        pending = read.original();
        continue;
      }
    }
    if (read.secrets.size > 0 && input.dispatch === undefined) {
      return refused("Signalbox didn't send this request: atomic secret dispatch is unavailable.");
    }
    // Production checks and starts under the registration lock; fallback checked immediately above.
    try {
      const dispatched =
        input.dispatch === undefined
          ? { _tag: "sent" as const, response: await send(read.request()) }
          : await input.dispatch(read.request(), secrets.revision);
      if (dispatched._tag === "stale") {
        secrets = await input.thread.secrets();
        pending = read.original();
        continue;
      }
      const response = dispatched.response;
      return await redactEgressResponse(response, secrets.values);
    } catch {
      // Fetch and header errors can quote a filled URL or value. Never propagate them.
      return refused("Signalbox could not send or redact this request safely.");
    }
  }
  return refused(
    "Signalbox didn't send this request: its secrets changed during approval. Retry with the current registration.",
  );
}
