import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

import { memoryKernel } from "../browser/memoryKernel.ts";
import { memoryKernelAuth, type Screen } from "../browser/memoryKernelAuth.ts";
import * as PersonBrowsers from "../browser/PersonBrowsers.ts";
import { layerMemoryStore } from "../testing.ts";
import * as UserStore from "../user/UserStore.ts";
import {
  type CredentialScope,
  ExecutorLoginError,
  type ExecutorLogins,
  type LoginKind,
} from "./ExecutorLogins.ts";
import * as LoginService from "./LoginService.ts";
import * as SignInGrants from "./SignInGrants.ts";

/**
 * The login service (#576) against Kernel's Managed Auth and Executor in
 * memory: one call signs the person's profile in from their 1Password, under
 * a standing grant, and the agent only ever gets a status.
 */

const OWNER = "user_owner";
const PASSWORD = "pw-canary-4e1b9d77c2";
const TOTP = "731205";
const person = { _tag: "person" } as const;

const field = (id: string, type: string) => ({ id, type, label: id });
const SITES: Readonly<Record<string, ReadonlyArray<Screen>>> = {
  "example.com": [
    {
      fields: [field("email", "identifier"), field("pass", "password")],
      expect: { email: "me@example.com", pass: PASSWORD },
    },
  ],
  "two-step.test": [
    { fields: [field("email", "identifier")], expect: { email: "me@example.com" } },
    { fields: [field("pass", "password")], expect: { pass: PASSWORD } },
  ],
  "totp.test": [
    {
      fields: [field("email", "identifier"), field("pass", "password")],
      expect: { email: "me@example.com", pass: PASSWORD },
    },
    {
      choices: [
        { id: "by-sms", type: "mfa_method", label: "Text me", mfa_type: "sms" },
        { id: "by-app", type: "mfa_method", label: "Use an app", mfa_type: "totp" },
      ],
      expect: "by-app",
    },
    { fields: [field("otp", "totp_code")], expect: { otp: TOTP } },
  ],
  "wrong.test": [
    { fields: [field("pass", "password")], expect: { pass: "not-what-1password-has" } },
  ],
  "emailed.test": [
    { fields: [{ id: "code", type: "code", label: "Code we emailed you" }], expect: {} },
  ],
};

/** Executor's login service for one person's linked 1Password: a login per site. */
const memoryExecutor = (sites: ReadonlyArray<string>) => {
  const resolves: Array<{ readonly kinds: ReadonlyArray<LoginKind>; readonly item: string }> = [];
  const owns = (requester: string, scope: CredentialScope) =>
    scope.kind === "folder"
      ? Effect.fail(new ExecutorLoginError({ reason: "no-folder-source", message: "none" }))
      : scope.person === requester
        ? Effect.void
        : Effect.fail(new ExecutorLoginError({ reason: "not-owner", message: "not theirs" }));
  const siteOf = (origin: string) => new URL(origin).hostname;
  const api: ExecutorLogins = {
    logins: ({ requester, scope, origin }) =>
      Effect.map(owns(requester, scope), () =>
        sites.includes(siteOf(origin))
          ? [{ item: `item-${siteOf(origin)}`, title: "Example", username: "me@example.com" }]
          : [],
      ),
    resolve: ({ requester, scope, kinds, item }) =>
      Effect.map(owns(requester, scope), () => {
        resolves.push({ kinds, item });
        return {
          item: { id: item, title: "Example" },
          ...(kinds.includes("username") ? { username: "me@example.com" } : {}),
          ...(kinds.includes("password") ? { password: Redacted.make(PASSWORD) } : {}),
          ...(kinds.includes("totp") ? { totp: Redacted.make(TOTP) } : {}),
        };
      }),
  };
  return { api, resolves };
};

const arms: Array<number> = [];

const setup = (options: { readonly sites?: ReadonlyArray<string> } = {}) => {
  const kernel = memoryKernelAuth(SITES);
  const browsers = memoryKernel();
  const executor = memoryExecutor(options.sites ?? Object.keys(SITES));
  const layer = LoginService.layer({
    kernel: kernel.api,
    executor: executor.api,
    pollInterval: Duration.zero,
  }).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        SignInGrants.layer,
        PersonBrowsers.layer(browsers.api),
        Layer.succeed(LoginService.LoginAlarm, {
          armBy: (at) => Effect.sync(() => void arms.push(at)),
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.effectDiscard(
        UserStore.UserStore.use((store) =>
          store.recordSignIn({ id: OWNER, email: "o@example.test" }),
        ),
      ),
    ),
    Layer.provideMerge(layerMemoryStore),
  );
  return { kernel, browsers, executor, layer };
};

const grant = (site: string) =>
  SignInGrants.SignInGrants.use((grants) => grants.grant({ source: person, site }));
const signIn = (site: string, requester = OWNER) =>
  LoginService.LoginService.use((logins) =>
    logins.signIn({ threadId: "thread-1", requester, site }),
  );

describe("signing an agent in (#576)", () => {
  it.effect("signs in from 1Password under a grant, on a connection that saves nothing", () => {
    const { kernel, browsers, executor, layer } = setup();
    return Effect.gen(function* () {
      yield* grant("example.com");
      // Another thread's session writes the profile back; this thread's and a third only read it.
      const open = (threadId: string) =>
        PersonBrowsers.PersonBrowsers.use((each) => each.open({ threadId, requester: OWNER }));
      yield* open("thread-0");
      yield* open("thread-1");
      yield* open("thread-2");

      expect(yield* signIn("https://example.com/login")).toEqual({
        _tag: "signed_in",
        site: "example.com",
        item: "Example",
        username: "me@example.com",
      });
      // The writer and the thread's own session ended first, so neither saves over the login.
      expect(browsers.deleted.toSorted()).toEqual(["browser-1", "browser-2"]);
      expect(kernel.connections()).toMatchObject([
        { domain: "example.com", save_credentials: false, status: "AUTHENTICATED" },
      ]);
      expect(executor.resolves).toEqual([
        { kinds: ["username", "password"], item: "item-example.com" },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("answers a two-step login one page at a time", () => {
    const { executor, layer } = setup();
    return Effect.gen(function* () {
      yield* grant("two-step.test");
      expect((yield* signIn("https://two-step.test"))._tag).toBe("signed_in");
      expect(executor.resolves.map((each) => each.kinds)).toEqual([["username"], ["password"]]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("takes the authenticator route over SMS and answers its code", () => {
    const { kernel, executor, layer } = setup();
    return Effect.gen(function* () {
      yield* grant("*");
      expect((yield* signIn("https://totp.test"))._tag).toBe("signed_in");
      expect(kernel.submissions.map(({ answer }) => answer)).toContainEqual({
        interaction_id: expect.any(String),
        selected_choice_id: "by-app",
      });
      expect(executor.resolves.map((each) => each.kinds)).toEqual([
        ["username", "password"],
        ["totp"],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("answers the new pause when Kernel refuses a stale interaction", () => {
    const { kernel, layer } = setup();
    return Effect.gen(function* () {
      yield* grant("example.com");
      kernel.staleNextSubmit();
      expect((yield* signIn("https://example.com"))._tag).toBe("signed_in");
    }).pipe(Effect.provide(layer));
  });

  it.effect("asks the person instead of signing in without a grant, or for someone else", () => {
    const { kernel, executor, layer } = setup();
    return Effect.gen(function* () {
      const asked = yield* signIn("https://example.com");
      expect(asked).toMatchObject({ _tag: "not_allowed", site: "example.com" });
      expect(asked._tag === "not_allowed" && asked.message).toContain("Settings → Sign-in");

      yield* grant("example.com");
      expect(yield* signIn("https://example.com", "user_someone_else")).toMatchObject({
        _tag: "not_allowed",
        site: "example.com",
      });
      expect(kernel.logins).toEqual([]);
      expect(executor.resolves).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("says there's no saved login before spending a browser on it", () => {
    const { kernel, layer } = setup({ sites: [] });
    return Effect.gen(function* () {
      yield* grant("*");
      expect(yield* signIn("https://example.com")).toMatchObject({
        _tag: "no_saved_login",
        site: "example.com",
      });
      expect(kernel.logins).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("stops with the reason when a login can't finish without the person", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* grant("*");
      expect(yield* signIn("https://wrong.test")).toEqual({
        _tag: "failed",
        site: "wrong.test",
        message:
          "Couldn't sign in to wrong.test: the site rejected the password saved in 1Password. Tell the person; don't retry.",
      });
      expect(yield* signIn("https://emailed.test")).toEqual({
        _tag: "failed",
        site: "emailed.test",
        message:
          "Couldn't sign in to emailed.test: the site asks for “Code we emailed you”, which 1Password can't answer yet. Tell the person; don't retry.",
      });
      expect((yield* signIn("http://localhost:5173"))._tag).toBe("failed");
    }).pipe(Effect.provide(layer));
  });

  it.effect("logs in again on its own once Kernel finds the session logged out", () => {
    const { kernel, executor, layer } = setup();
    return Effect.gen(function* () {
      const logins = yield* LoginService.LoginService;
      yield* grant("example.com");
      yield* signIn("https://example.com");
      const [connection] = kernel.connections();
      expect(arms.at(-1)).toBeGreaterThan(0);

      // Overnight the site's session ran out, and Kernel's health check saw it.
      kernel.expire(connection!.id);
      yield* TestClock.adjust(Duration.hours(2));
      yield* logins.sweep;
      expect(kernel.logins).toHaveLength(2);
      expect(executor.resolves).toHaveLength(2);
      expect(kernel.connections()[0]?.status).toBe("AUTHENTICATED");

      // Revoked, it stays logged out: the sweep asks no one and signs nothing in.
      const { grants } = yield* SignInGrants.SignInGrants.use((each) => each.grants);
      yield* SignInGrants.SignInGrants.use((each) => each.revoke(grants[0]!.id));
      kernel.expire(connection!.id);
      yield* TestClock.adjust(Duration.hours(2));
      yield* logins.sweep;
      expect(kernel.logins).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps every value out of answers, logs, spans and storage", () => {
    const { layer } = setup();
    const lines: Array<string> = [];
    const spans: Array<Tracer.NativeSpan> = [];
    const watch = Layer.mergeAll(
      Logger.layer([Logger.map(Logger.formatJson, (line) => void lines.push(line))], {
        mergeWithExisting: true,
      }),
      Layer.succeed(References.MinimumLogLevel, "All"),
      Layer.succeed(
        Tracer.Tracer,
        Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options);
            spans.push(span);
            return span;
          },
        }),
      ),
    );
    return Effect.gen(function* () {
      yield* grant("*");
      const answers = [yield* signIn("https://totp.test"), yield* signIn("https://wrong.test")];
      const sql = yield* SqlClient.SqlClient;
      const tables = yield* sql<{
        readonly name: string;
      }>`SELECT name FROM sqlite_master WHERE type = 'table'`;
      const stored: Array<unknown> = [];
      for (const { name } of tables) stored.push(yield* sql.unsafe(`SELECT * FROM "${name}"`));
      const everything = JSON.stringify({
        answers,
        stored,
        lines,
        spans: spans.map((span) => ({ name: span.name, attributes: [...span.attributes] })),
      });
      expect(spans.some((span) => span.name === "LoginService.signIn")).toBe(true);
      expect(everything).not.toContain(PASSWORD);
      expect(everything).not.toContain(TOTP);
    }).pipe(Effect.provide(Layer.merge(layer, watch)));
  });
});
