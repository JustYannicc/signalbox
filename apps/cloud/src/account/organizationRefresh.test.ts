import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";

import { CLOUD_TEST_ENV, layerAccounts } from "../testing.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import * as CloudAccounts from "./CloudAccounts.ts";

/**
 * `refreshContexts` against a WorkOS the test controls: what it reads, and
 * how it writes through the user object's refresh ordering.
 */

const USER = "user_ada";
const LIST_PATH = "/user_management/organization_memberships";
const PERSONAL_PATH = `/organizations/external_id/${encodeURIComponent(`personal:${USER}`)}`;

interface WorkOSView {
  readonly organizations: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /** The personal organization's id, null when WorkOS has none, or a failing status. */
  readonly personal: string | null | number;
}

const respond = (pathname: string, view: WorkOSView): Response => {
  if (pathname === LIST_PATH) {
    return Response.json({
      data: view.organizations.map((organization) => ({
        organization_id: organization.id,
        organization_name: organization.name,
      })),
      list_metadata: { after: null },
    });
  }
  if (pathname !== PERSONAL_PATH) return Response.json({}, { status: 500 });
  if (view.personal === null) return Response.json({}, { status: 404 });
  if (typeof view.personal === "number") return Response.json({}, { status: view.personal });
  return Response.json({ id: view.personal, external_id: `personal:${USER}` });
};

/** A WorkOS answering from `view`, as it stood when each request arrived. */
const makeWorkOS = (log: Array<string>) => {
  let view: WorkOSView = { organizations: [], personal: null };
  let held:
    | { readonly gate: Deferred.Deferred<void>; readonly arrived: Deferred.Deferred<void> }
    | undefined;
  let heldRequests = 0;
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const { pathname } = new URL(request.url);
      log.push(`GET ${pathname}`);
      const answer = respond(pathname, view);
      const hold = held;
      if (hold) {
        if (++heldRequests === 2) yield* Deferred.succeed(hold.arrived, undefined);
        yield* Deferred.await(hold.gate);
      }
      return HttpClientResponse.fromWeb(request, answer);
    }),
  );
  return {
    client,
    set: (next: WorkOSView) => {
      view = next;
    },
    /**
     * Holds back the answers to the next refresh's two requests. `arrived`
     * waits until both are in and stops holding, so later refreshes go through.
     */
    hold: Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const arrived = yield* Deferred.make<void>();
      held = { gate, arrived };
      heldRequests = 0;
      return {
        arrived: Deferred.await(arrived).pipe(
          Effect.andThen(
            Effect.sync(() => {
              held = undefined;
            }),
          ),
        ),
        release: Deferred.succeed(gate, undefined),
      };
    }),
  };
};

/** Records the user object's refresh calls in the same log as WorkOS's requests. */
const spyOn = (users: UserDirectory.UserDirectory["Service"], log: Array<string>) =>
  UserDirectory.UserDirectory.of({
    ...users,
    forUser: (userId) => {
      const user = users.forUser(userId);
      return {
        ...user,
        reserveOrganizationRefresh: () =>
          user
            .reserveOrganizationRefresh()
            .pipe(Effect.tap((sequence) => Effect.sync(() => log.push(`reserve ${sequence}`)))),
        completeOrganizationRefresh: (sequence, organizations) =>
          user
            .completeOrganizationRefresh(sequence, organizations)
            .pipe(
              Effect.tap((applied) =>
                Effect.sync(() =>
                  log.push(`complete ${sequence} ${applied ? "applied" : "refused"}`),
                ),
              ),
            ),
      };
    },
  });

const setup = Effect.gen(function* () {
  const log: Array<string> = [];
  const workos = makeWorkOS(log);
  const users = yield* UserDirectory.UserDirectory;
  const accounts = yield* CloudAccounts.CloudAccounts.use((service) =>
    Effect.succeed(service),
  ).pipe(
    Effect.provide(
      Layer.fresh(CloudAccounts.layer).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HttpClient.HttpClient, workos.client),
            Layer.succeed(UserDirectory.UserDirectory, spyOn(users, log)),
          ),
        ),
      ),
    ),
  );
  return {
    log,
    workos,
    refresh: accounts.refreshContexts(USER),
    contexts: Effect.map(users.forUser(USER).contextIds(), (ids) => [...ids]),
  };
});

const withKey = layerAccounts({}, { ...CLOUD_TEST_ENV, T3CODE_WORKOS_API_KEY: "sk_test" });

describe("refreshContexts", () => {
  it.effect("reserves before asking WorkOS, then writes through the reservation", () =>
    Effect.gen(function* () {
      const { log, workos, refresh, contexts } = yield* setup;
      workos.set({
        organizations: [
          { id: "org_acme", name: "Acme" },
          { id: "org_globex", name: "Globex" },
        ],
        personal: null,
      });
      yield* refresh;
      // No personal organization in WorkOS yet: every company is still a context.
      expect(yield* contexts).toEqual(["personal", "org_acme", "org_globex"]);
      expect(log[0]).toBe("reserve 1");
      expect(log.slice(1, 3).toSorted()).toEqual([`GET ${PERSONAL_PATH}`, `GET ${LIST_PATH}`]);
      expect(log.slice(3)).toEqual(["complete 1 applied"]);
    }).pipe(Effect.provide(withKey)),
  );

  it.effect("hides exactly the personal organization, not a company with its name", () =>
    Effect.gen(function* () {
      const { workos, refresh, contexts } = yield* setup;
      workos.set({
        organizations: [
          { id: "org_ada_personal", name: "Ada" },
          { id: "org_ada_company", name: "Ada" },
        ],
        personal: "org_ada_personal",
      });
      yield* refresh;
      expect(yield* contexts).toEqual(["personal", "org_ada_company"]);
    }).pipe(Effect.provide(withKey)),
  );

  it.effect("a failed personal lookup writes nothing", () =>
    Effect.gen(function* () {
      const { log, workos, refresh, contexts } = yield* setup;
      workos.set({ organizations: [{ id: "org_acme", name: "Acme" }], personal: null });
      yield* refresh;

      workos.set({ organizations: [{ id: "org_globex", name: "Globex" }], personal: 500 });
      const error = yield* refresh.pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "WorkOSPersonalOrganizationError", status: 500 });
      expect(yield* contexts).toEqual(["personal", "org_acme"]);
      expect(log.filter((entry) => entry.startsWith("complete"))).toEqual(["complete 1 applied"]);
    }).pipe(Effect.provide(withKey)),
  );

  it.effect("of two overlapping refreshes, the newer one wins even if it finishes first", () =>
    Effect.gen(function* () {
      const { log, workos, refresh, contexts } = yield* setup;
      workos.set({ organizations: [{ id: "org_acme", name: "Acme" }], personal: null });
      yield* refresh;

      const held = yield* workos.hold;
      workos.set({ organizations: [{ id: "org_globex", name: "Globex" }], personal: null });
      const older = yield* Effect.forkChild(refresh);
      yield* held.arrived;
      workos.set({ organizations: [{ id: "org_initech", name: "Initech" }], personal: null });
      yield* refresh;
      expect(yield* contexts).toEqual(["personal", "org_initech"]);

      yield* held.release;
      yield* Fiber.join(older);
      expect(yield* contexts).toEqual(["personal", "org_initech"]);
      expect(log.filter((entry) => entry.startsWith("complete"))).toEqual([
        "complete 1 applied",
        "complete 3 applied",
        "complete 2 refused",
      ]);
    }).pipe(Effect.provide(withKey)),
  );

  it.effect("a newer refresh that fails still retires the older one", () =>
    Effect.gen(function* () {
      const { log, workos, refresh, contexts } = yield* setup;
      workos.set({ organizations: [{ id: "org_acme", name: "Acme" }], personal: null });
      yield* refresh;

      const held = yield* workos.hold;
      workos.set({ organizations: [{ id: "org_globex", name: "Globex" }], personal: null });
      const older = yield* Effect.forkChild(refresh);
      yield* held.arrived;
      workos.set({ organizations: [{ id: "org_initech", name: "Initech" }], personal: 500 });
      expect((yield* refresh.pipe(Effect.flip))._tag).toBe("WorkOSPersonalOrganizationError");

      yield* held.release;
      yield* Fiber.join(older);
      // Neither WorkOS read lands: the contexts stay what the last applied refresh wrote.
      expect(yield* contexts).toEqual(["personal", "org_acme"]);
      expect(log.filter((entry) => entry.startsWith("complete"))).toEqual([
        "complete 1 applied",
        "complete 2 refused",
      ]);
    }).pipe(Effect.provide(withKey)),
  );
});
