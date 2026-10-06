import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type * as AccountHub from "./AccountHub.ts";
import type { AccountHubAccount } from "./accountHubManagement.ts";
import { reauthMethods, startReauth } from "./hubReauth.ts";

const dead: AccountHubAccount = {
  name: "codex-lb-old.json",
  type: "codex",
  email: "me@example.com",
  disabled: false,
  signedOut: true,
  workspaceId: "workspace-team",
};

/** A hub whose account list is `before` until the login finishes, then `after`. */
function fakeHub(after: ReadonlyArray<AccountHubAccount>) {
  let finished = false;
  const removed: string[] = [];
  const hub = {
    ensureRunning: Effect.void,
    accounts: Effect.sync(() => (finished ? after : [dead])),
    removeCredential: (name: string) => Effect.sync(() => void removed.push(name)),
    startOAuthLogin: () =>
      Effect.succeed({
        url: "https://auth.example.com",
        complete: () => Effect.void,
        await: Effect.sync(() => {
          finished = true;
        }),
        cancel: Effect.void,
      }),
  } as unknown as AccountHub.AccountHub["Service"];
  return { hub, removed };
}

const signInAgain = (hub: AccountHub.AccountHub["Service"]) =>
  startReauth(hub, dead.name, { localCallback: false }).pipe(
    Effect.flatMap((login) => login.await),
  );

describe("signing a dead hub account in again", () => {
  it.effect("offers one method per dead account the hub can log in again", () =>
    Effect.gen(function* () {
      const { hub } = fakeHub([]);
      const methods = yield* reauthMethods(hub, ["codex"]);
      expect(methods.map((method) => [method.id, method.name])).toEqual([
        ["reauth:codex-lb-old.json", "Sign in to me@example.com again"],
      ]);
      expect(yield* reauthMethods(hub, ["claude"])).toEqual([]);
    }),
  );

  it.effect("is done when the hub rewrote the same file", () =>
    Effect.gen(function* () {
      const { hub, removed } = fakeHub([{ ...dead, signedOut: false }]);
      yield* signInAgain(hub);
      expect(removed).toEqual([]);
    }),
  );

  it.effect("removes the dead file when the hub saved the same account under a new name", () =>
    Effect.gen(function* () {
      const { hub, removed } = fakeHub([
        dead,
        {
          ...dead,
          name: "codex-1a2b3c4d-Me@Example.com-pro.json",
          email: "Me@Example.com",
          signedOut: false,
        },
      ]);
      yield* signInAgain(hub);
      expect(removed).toEqual(["codex-lb-old.json"]);
    }),
  );

  it.effect("keeps the dead account when the same email signed in to another workspace", () =>
    Effect.gen(function* () {
      const { hub, removed } = fakeHub([
        dead,
        {
          ...dead,
          name: "codex-9f8e7d6c-me@example.com-plus.json",
          signedOut: false,
          workspaceId: "workspace-personal",
        },
      ]);
      const error = yield* Effect.flip(signInAgain(hub));
      expect(error.detail).toContain("another workspace of me@example.com");
      expect(removed).toEqual([]);
    }),
  );

  it.effect("says so when someone else signed in, and fixes nothing", () =>
    Effect.gen(function* () {
      const { hub, removed } = fakeHub([
        dead,
        { ...dead, name: "codex-other.json", email: "other@example.com", signedOut: false },
      ]);
      const error = yield* Effect.flip(signInAgain(hub));
      expect(error.detail).toContain("You signed in as other@example.com, not me@example.com");
      expect(removed).toEqual([]);
    }),
  );
});
