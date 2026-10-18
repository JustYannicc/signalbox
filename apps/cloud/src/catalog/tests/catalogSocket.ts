import * as Schema from "effect/Schema";
const Frame = Schema.Struct({
  type: Schema.String,
  id: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
  code: Schema.optional(Schema.String),
});
const decodeFrame = Schema.decodeUnknownSync(Frame);

/** Drives the native namespace protocol without exposing a public Catalog socket route. */
export const openCatalogSocket = async (
  origin: string,
  homeKey: string,
  userId: string,
  module: "personal" | "organization" = "personal",
) => {
  const url = new URL("/test/socket", origin);
  url.protocol = "ws:";
  url.searchParams.set("homeKey", homeKey);
  url.searchParams.set("userId", userId);
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("Catalog test socket failed to open.")),
      { once: true },
    );
  });
  const frames: Array<typeof Frame.Type> = [];
  const waiters = new Set<() => void>();
  const notify = () => {
    for (const waiter of waiters) waiter();
  };
  const onMessage = (event: MessageEvent) => {
    if (typeof event.data !== "string") throw new Error("Expected a JSON socket frame.");
    frames.push(decodeFrame(JSON.parse(event.data)));
    notify();
  };
  socket.addEventListener("message", onMessage);

  return {
    frames,
    waitFor: (id: string, type: "data" | "error") =>
      new Promise<typeof Frame.Type>((resolve) => {
        const check = () => {
          const frame = frames.find((candidate) => candidate.id === id && candidate.type === type);
          if (frame === undefined) return;
          waiters.delete(check);
          resolve(frame);
        };
        waiters.add(check);
        check();
      }),
    subscribe: (id: string) =>
      socket.send(
        JSON.stringify({
          type: "subscribe",
          id,
          query: {
            functionPath: `${module}:view_access`,
            args: { input: { defined: true, value: { folderId: null, incarnation: 1 } } },
          },
        }),
      ),
    close: () => {
      socket.removeEventListener("message", onMessage);
      socket.close(1000, "Test finished");
    },
  };
};
