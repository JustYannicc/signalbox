// @effect-diagnostics globalFetch:off - the machine's requests pass through the Workers runtime's own fetch, streams untouched, outside Effect.
import { listedNames } from "@signalbox/runner-protocol/SecretPlaceholders";
import type { SecretValue } from "@signalbox/runner-protocol/SecretScrubber";

import { readEgressRequest } from "./egressRequest.ts";
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
  readonly secrets: () => Promise<ReadonlyArray<SecretValue>>;
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
  },
): Promise<Response> {
  const send = input.send ?? ((outgoing: Request) => fetch(outgoing));
  if (input.ownHosts.has(new URL(request.url).host)) return send(request);
  const secrets = await input.thread.secrets();
  if (secrets.length === 0) return send(request);
  const read = await readEgressRequest(request, secrets);
  if (read.unknown.size > 0) {
    return refused(
      `Signalbox didn't send this request: this thread has no secret called ${listedNames(read.unknown)}.`,
    );
  }
  if (read.secrets.size === 0) return send(read.request());
  // A secret never crosses the internet in the clear.
  if (!read.https) {
    return refused(
      `Signalbox didn't send this request: it carries ${listedNames(read.secrets)} over plain HTTP. Use https://.`,
    );
  }
  const answer = await input.thread.authorize({
    host: read.host,
    names: [...read.secrets].toSorted(),
    waitMs: ASK_WAIT_MS,
  });
  return answer._tag === "allowed"
    ? send(read.request())
    : refused(`Signalbox didn't send this request: ${answer.message}`);
}
