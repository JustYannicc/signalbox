import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { createLogger } from "evlog";

export type ClientKind = "web" | "desktop" | "mobile" | "unknown";

export const clientKindOf = (value: string | null): ClientKind =>
  value === "web" || value === "desktop" || value === "mobile" ? value : "unknown";

export interface ClientConnectionRecord {
  readonly key: string;
  readonly userId: string;
  // Older sockets can outlive deployment of this record.
  readonly clientKind?: ClientKind;
  readonly openedAt?: number;
}

type SessionEvent =
  | { readonly action: "opened" | "restored" }
  | {
      readonly action: "closed";
      readonly cause: "peer" | "error" | "expired" | "revoked" | "setup";
      readonly code: number;
    }
  | { readonly action: "rpc"; readonly method: string };

const emit = (fields: Record<string, unknown>) =>
  Effect.gen(function* () {
    const wide = createLogger({ service: "signalbox-cloud", ...fields }).emit({ _forceKeep: true });
    // Automation logging silences evlog's console; keep this metadata-only record in Workers logs.
    if (wide) yield* Effect.logInfo("client.session", wide);
  });

export const logClientSession = (connection: ClientConnectionRecord, event: SessionEvent) =>
  Effect.gen(function* () {
    const at = yield* Clock.currentTimeMillis;
    yield* emit({
      action: "client.session",
      person: { id: connection.userId },
      client: {
        connectionId: connection.key,
        kind: connection.clientKind ?? "unknown",
        openedAt: connection.openedAt ?? null,
        at,
        ...event,
      },
    });
  });

export const logClientSessionSnapshot = (userId: string, connections: number) =>
  Effect.gen(function* () {
    const at = yield* Clock.currentTimeMillis;
    yield* emit({ action: "client.sessions", person: { id: userId }, client: { at, connections } });
  });
