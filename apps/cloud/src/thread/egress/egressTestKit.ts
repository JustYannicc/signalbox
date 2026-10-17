import { serveEgress } from "./egress.ts";

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
      (async (outgoing) => ({ _tag: "sent", response: await input.send(outgoing) })),
  });
