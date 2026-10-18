import { describe, expect, it } from "@effect/vitest";
import { FolderId } from "@t3tools/contracts/signalboxFolders";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { SyncFailure } from "@signalbox/sync/definition";
import { catalogHomeKey } from "./catalogHome.ts";
import { makeCatalogHomeBinding } from "./catalogBinding.ts";
import { CatalogPersonalRoot, CatalogPolicyActor } from "./catalogPolicy.ts";

const decodeHome = Schema.decodeUnknownSync(CatalogPersonalRoot);
const ownerHome = decodeHome({ owner: { _tag: "person", id: "owner" }, level: { _tag: "top" } });
const actor = Schema.decodeUnknownSync(CatalogPolicyActor)({ userId: "owner" });
const target = { folderId: FolderId.make("child"), incarnation: 4 };
const request = {
  home: ownerHome,
  kind: "change" as const,
  operation: "setGrant",
  input: { target, personId: "reader", role: "Viewer" },
};
const denied = <A>(effect: Effect.Effect<A, SyncFailure>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => expect(error).toEqual(new SyncFailure({ reason: "denied" }))),
  );

describe("Catalog home binding", () => {
  it.effect("mints permits only for its canonical home and rejects crossed fences", () =>
    Effect.gen(function* () {
      const home = decodeHome({
        owner: { _tag: "person", id: "p".repeat(256) },
        level: { _tag: "top" },
      });
      const scope = catalogHomeKey(home);
      expect(scope.length).toBeGreaterThan(256);

      const installed: Array<{ readonly scope: string; readonly epoch: number }> = [];
      const { binding, ingress } = makeCatalogHomeBinding({
        home,
        resolvePolicy: () => Effect.succeed({ epoch: 3 }),
        isLocalEpochCurrent: (permitScope, epoch) =>
          permitScope === scope && epoch >= (installed.at(-1)?.epoch ?? 0),
        installFence: (fence) => Effect.sync(() => installed.push(fence)).pipe(Effect.asVoid),
      });
      const permit = yield* binding.authorization.authorize(actor, {
        ...request,
        home,
      });

      expect(permit).toEqual({
        scope,
        localEpoch: 3,
        actorId: "owner",
        target,
      });
      expect(binding.authorization.isCurrent(permit)).toBe(true);
      expect(binding.authorization.isCurrent({ ...permit })).toBe(false);

      const otherHome = decodeHome({
        owner: { _tag: "person", id: "other" },
        level: { _tag: "top" },
      });
      yield* denied(binding.authorization.authorize(actor, { ...request, home: otherHome }));
      yield* denied(binding.completion.install({ scope: catalogHomeKey(otherHome), epoch: 4 }));
      expect(installed).toEqual([]);

      yield* binding.authorizeIngress(ingress);
      yield* denied(binding.authorizeIngress(Object.freeze({})));
    }),
  );

  it.effect(
    "keeps self-revocation admission through staged writes and invalidates it on fence install",
    () =>
      Effect.gen(function* () {
        const scope = catalogHomeKey(ownerHome);
        let localEpoch = 0;
        let installedEpoch = 0;
        let allowed = true;
        const { binding } = makeCatalogHomeBinding({
          home: ownerHome,
          resolvePolicy: () =>
            allowed
              ? Effect.succeed({ epoch: localEpoch })
              : Effect.fail(new SyncFailure({ reason: "denied" })),
          isLocalEpochCurrent: (permitScope, epoch) =>
            permitScope === scope && epoch >= installedEpoch,
          installFence: (fence) =>
            Effect.gen(function* () {
              if (fence.epoch < installedEpoch)
                return yield* Effect.fail(new SyncFailure({ reason: "invalid_state" }));
              installedEpoch = fence.epoch;
            }),
        });
        const permit = yield* binding.authorization.authorize(actor, request);

        // These stand in for policy writes staged in the same Lunora transaction. The installed
        // native fence still reflects the transaction's starting state until the outbox runs.
        localEpoch = 1;
        allowed = false;
        expect(binding.authorization.isCurrent(permit)).toBe(true);
        yield* denied(binding.authorization.authorize(actor, request));

        yield* binding.completion.install({ scope, epoch: 1 });
        expect(binding.authorization.isCurrent(permit)).toBe(false);
        yield* binding.completion.install({ scope, epoch: 2 });
        yield* binding.completion.install({ scope, epoch: 1 }).pipe(
          Effect.flip,
          Effect.map((error) =>
            expect(error).toEqual(new SyncFailure({ reason: "invalid_state" })),
          ),
        );
        expect(installedEpoch).toBe(2);
      }),
  );

  it("rejects homes outside the personal-root authority", () => {
    expect(() =>
      makeCatalogHomeBinding({
        home: {
          owner: { _tag: "organization", id: "org_one" },
          level: { _tag: "top" },
        } as typeof CatalogPersonalRoot.Type,
        resolvePolicy: () => Effect.succeed({ epoch: 0 }),
        isLocalEpochCurrent: () => true,
        installFence: () => Effect.void,
      }),
    ).toThrow();
  });
});
