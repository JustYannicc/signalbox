import * as Schema from "effect/Schema";
import { resolveShard, type ShardNamespaceLike } from "lunorash/runtime";

import type { CatalogHomeNamespace } from "../catalogObjects.ts";

const Frame = Schema.Struct({
  type: Schema.String,
  id: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
  code: Schema.optional(Schema.String),
});
const decodeFrame = Schema.decodeUnknownSync(Frame);

/** Drives the native namespace protocol without exposing a public Catalog socket route. */
export const openCatalogSocket = async (
  namespace: CatalogHomeNamespace,
  homeKey: string,
  userId: string,
) => {
  const response = await resolveShard(namespace as unknown as ShardNamespaceLike, homeKey).fetch(
    new Request("https://catalog.internal/ws", {
      headers: {
        Upgrade: "websocket",
        "x-lunora-userid": userId,
        "x-lunora-identity": JSON.stringify({ catalogHomeKey: homeKey }),
      },
    }),
  );
  if (response.status !== 101 || response.webSocket === null) {
    throw new Error(`Catalog socket upgrade failed: ${response.status}`);
  }
  const socket = response.webSocket;
  if (socket === undefined) throw new Error("Catalog socket was not returned.");
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
  socket.accept();

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
            functionPath: "personal:view_access",
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
