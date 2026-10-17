import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Platform from "../../platform.ts";
import * as PreviewState from "../PreviewState.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const dependencies = Layer.mergeAll(database, Platform.layerCrypto);

const service = { port: 5173, command: "pnpm dev --host 0.0.0.0", cwd: "." };

describe("thread preview state", () => {
  it.effect("keeps the signing key and declared server when the thread object wakes again", () =>
    Effect.gen(function* () {
      const first = yield* Layer.build(PreviewState.layer);
      const previews = yield* PreviewState.PreviewState.pipe(Effect.provide(first));
      const before = yield* previews.configuration;
      expect(before.services).toEqual([]);
      expect(before.key.length).toBeGreaterThanOrEqual(32);
      yield* previews.saveServices([service]);
      const after = yield* previews.configuration;
      expect(after).toEqual({ key: before.key, services: [service] });
      const second = yield* Layer.build(PreviewState.layer);
      const reopened = yield* PreviewState.PreviewState.pipe(Effect.provide(second));
      expect(yield* reopened.configuration).toEqual(after);
      yield* reopened.saveServices([]);
      expect(yield* reopened.configuration).toEqual({ key: before.key, services: [] });
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
  );
});
