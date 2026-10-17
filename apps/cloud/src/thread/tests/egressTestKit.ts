import { serveEgress } from "../Egress.ts";

/** Replaces only external dispatch. Tests still use the real inspection, approval and redaction. */
export const serveWithFakeNetwork = (
  request: Request,
  input: Parameters<typeof serveEgress>[1] & {
    readonly send: (request: Request) => Promise<Response>;
  },
) =>
  serveEgress(request, {
    ...input,
    dispatch:
      input.dispatch ??
      (async (outgoing, revision) => {
        if ((await input.thread.secrets()).revision !== revision) return { _tag: "stale" };
        return { _tag: "sent", response: await input.send(outgoing) };
      }),
  });
