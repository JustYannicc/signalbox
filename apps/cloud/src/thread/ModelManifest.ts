import {
  MODEL_MANIFEST_URL,
  ModelManifestCatalogs,
  manifestUpdatedAtMs,
} from "@t3tools/shared/modelManifest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

// The self-hosted server's bundled copy: the same data, from the same release.
import bundledManifestJson from "../../../server/src/provider/model-manifest.json" with { type: "json" };

/**
 * The model manifest the self-hosted server uses
 * (`apps/server/src/provider/ModelManifest.ts`), which names the models a
 * pool serves and gives them their options. Fetched from upstream and kept in
 * memory for an hour; until a fetch succeeds, and whenever one fails, the
 * copy bundled with this release. A fetched copy edited before the bundle's
 * never replaces it.
 */

const TTL_MS = 60 * 60 * 1000;
/** After a failed fetch, so an outage doesn't cost a request on every read. */
const RETRY_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

export const BUNDLED_MODEL_CATALOGS: ModelManifestCatalogs =
  Schema.decodeUnknownSync(ModelManifestCatalogs)(bundledManifestJson);

const decodeManifest = Schema.decodeUnknownEffect(ModelManifestCatalogs);

export class ModelManifest extends Context.Service<
  ModelManifest,
  {
    /** The manifest in memory. Never waits on the network; a stale one starts a fetch for later reads. */
    readonly current: Effect.Effect<ModelManifestCatalogs>;
  }
>()("@signalbox/cloud/thread/ModelManifest") {}

interface State {
  readonly manifest: ModelManifestCatalogs;
  readonly attemptedAt: number | null;
  readonly fetchedAt: number | null;
}

const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const scope = yield* Effect.scope;
  const state = yield* Ref.make<State>({
    manifest: BUNDLED_MODEL_CATALOGS,
    attemptedAt: null,
    fetchedAt: null,
  });

  const within = (since: number | null, window: number, now: number) =>
    since !== null && now >= since && now - since < window;

  // `current` claims the attempt (`attemptedAt`) before forking this, so one runs at a time.
  const refresh = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const fetched = yield* http.get(MODEL_MANIFEST_URL).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.flatMap(decodeManifest),
      Effect.timeout(FETCH_TIMEOUT_MS),
      Effect.catchCause((cause) =>
        Effect.as(Effect.logWarning("model manifest fetch failed", { cause }), null),
      ),
    );
    if (fetched === null) return;
    yield* Ref.update(state, (current) =>
      manifestUpdatedAtMs(fetched) < manifestUpdatedAtMs(current.manifest)
        ? { ...current, fetchedAt: now }
        : { ...current, manifest: fetched, fetchedAt: now },
    );
  });

  const current = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const [known, stale] = yield* Ref.modify(state, (known) => {
      const stale =
        !within(known.fetchedAt, TTL_MS, now) && !within(known.attemptedAt, RETRY_MS, now);
      return [[known, stale] as const, stale ? { ...known, attemptedAt: now } : known];
    });
    if (stale) yield* Effect.forkIn(refresh, scope);
    return known.manifest;
  });

  return ModelManifest.of({ current });
});

export const layer = Layer.effect(ModelManifest, make);

/** The bundled copy only, never fetched; for tests. */
export const layerBundled = Layer.succeed(
  ModelManifest,
  ModelManifest.of({ current: Effect.succeed(BUNDLED_MODEL_CATALOGS) }),
);
