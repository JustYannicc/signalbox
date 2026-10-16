import {
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthSettingsWriteScope,
  type AuthEnvironmentScope,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { SIGNALBOX_SIGN_IN_WS_METHODS, type SignInFill } from "@t3tools/contracts/signalboxSignIn";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Tracer from "effect/Tracer";

import { layerMemoryStore, makeMemoryCloud } from "../testing.ts";
import * as CloudRpc from "../user/rpc.ts";
import * as UserStore from "../user/UserStore.ts";
import * as DeviceSignIn from "./DeviceSignIn.ts";
import { ExecutorLoginError, type ExecutorLogins, type LoginKind } from "./ExecutorLogins.ts";
import * as SignInGrants from "./SignInGrants.ts";

/**
 * A person's own device signing their tab in (#586): the same grant and
 * credential rules as agents' sign-ins, and exactly the values one step of
 * the form asks for, to the device alone.
 */

const OWNER = "user_owner";
const PASSWORD = "pw-canary-91c0d3aa58";
const TOTP = "448120";
const person = { _tag: "person" } as const;
const threadId = ThreadId.make("thread-1");

/** Executor for one person's linked 1Password, with the logins it holds per site. */
const memoryExecutor = (logins: Readonly<Record<string, ReadonlyArray<string>>>) => {
  const resolves: Array<{ readonly kinds: ReadonlyArray<LoginKind>; readonly item: string }> = [];
  let linked = true;
  const siteOf = (origin: string) => new URL(origin).hostname;
  const owns = (requester: string, person: string) =>
    !linked
      ? Effect.fail(
          new ExecutorLoginError({ reason: "not-linked", message: "OnePasswordNotLinked" }),
        )
      : requester === person
        ? Effect.void
        : Effect.fail(new ExecutorLoginError({ reason: "not-owner", message: "not theirs" }));
  const api: ExecutorLogins = {
    logins: ({ requester, scope, origin }) =>
      scope.kind === "folder"
        ? Effect.fail(new ExecutorLoginError({ reason: "no-folder-source", message: "none" }))
        : Effect.map(owns(requester, scope.person), () =>
            (logins[siteOf(origin)] ?? []).map((item) => ({
              item,
              title: `Login ${item}`,
              username: `${item}@example.com`,
            })),
          ),
    resolve: ({ requester, scope, kinds, item }) =>
      scope.kind === "folder"
        ? Effect.fail(new ExecutorLoginError({ reason: "no-folder-source", message: "none" }))
        : Effect.map(owns(requester, scope.person), () => {
            resolves.push({ kinds, item });
            return {
              item: { id: item, title: `Login ${item}` },
              ...(kinds.includes("username") ? { username: `${item}@example.com` } : {}),
              ...(kinds.includes("password") ? { password: Redacted.make(PASSWORD) } : {}),
              ...(kinds.includes("totp") ? { totp: Redacted.make(TOTP) } : {}),
            };
          }),
  };
  return { api, resolves, unlink: () => void (linked = false) };
};

const SITES = { "example.com": ["main", "work"], "accounts.example.org": ["org"] };

const setup = (executor: ExecutorLogins | null) =>
  DeviceSignIn.layer({ executor }).pipe(
    Layer.provideMerge(SignInGrants.layer),
    Layer.provideMerge(
      Layer.effectDiscard(
        UserStore.UserStore.use((store) =>
          store.recordSignIn({ id: OWNER, email: "o@example.test" }),
        ),
      ),
    ),
    Layer.provideMerge(layerMemoryStore),
  );

const grant = (site: string) =>
  SignInGrants.SignInGrants.use((grants) => grants.grant({ source: person, site }));
const fill = (
  origin: string,
  kinds: readonly [LoginKind, ...Array<LoginKind>],
  options: { readonly item?: string; readonly requester?: string } = {},
) =>
  DeviceSignIn.DeviceSignIn.use((devices) =>
    devices.step({
      threadId,
      origin,
      kinds,
      requester: options.requester ?? OWNER,
      ...(options.item === undefined ? {} : { item: options.item }),
    }),
  );
const filled = (answer: SignInFill) => {
  if (answer._tag !== "filled") throw new Error(`expected a fill, got ${answer._tag}`);
  return {
    item: answer.item,
    username: answer.username,
    password: answer.password === undefined ? undefined : Redacted.value(answer.password),
    totp: answer.totp === undefined ? undefined : Redacted.value(answer.totp),
  };
};

describe("DeviceSignIn", () => {
  it.effect("fills nothing until a grant covers the site, and reads no 1Password before", () => {
    const executor = memoryExecutor(SITES);
    return Effect.gen(function* () {
      expect(yield* fill("https://example.com/login", ["username", "password"])).toEqual({
        _tag: "ask",
        site: "example.com",
      });
      expect(executor.resolves).toEqual([]);
      yield* grant("example.com");
      expect(filled(yield* fill("https://example.com/login", ["username", "password"]))).toEqual({
        item: "main",
        username: "main@example.com",
        password: PASSWORD,
        totp: undefined,
      });
    }).pipe(Effect.provide(setup(executor.api)));
  });

  it.effect("answers each step with exactly what it asks for, on the step before's login", () => {
    const executor = memoryExecutor(SITES);
    return Effect.gen(function* () {
      yield* grant("*");
      const first = filled(yield* fill("https://example.com", ["username"], { item: "work" }));
      expect(first).toEqual({
        item: "work",
        username: "work@example.com",
        password: undefined,
        totp: undefined,
      });
      const second = filled(yield* fill("https://example.com", ["password"], { item: first.item }));
      expect(second).toEqual({
        item: "work",
        username: undefined,
        password: PASSWORD,
        totp: undefined,
      });
      const code = filled(yield* fill("https://example.com", ["totp"], { item: first.item }));
      expect(code).toEqual({ item: "work", username: undefined, password: undefined, totp: TOTP });
      expect(executor.resolves.map((each) => each.kinds)).toEqual([
        ["username"],
        ["password"],
        ["totp"],
      ]);
      // An item 1Password no longer matches falls back to its best match.
      expect(filled(yield* fill("https://example.com", ["password"], { item: "gone" })).item).toBe(
        "main",
      );
    }).pipe(Effect.provide(setup(executor.api)));
  });

  it.effect("says why there's nothing to fill", () => {
    const executor = memoryExecutor(SITES);
    return Effect.gen(function* () {
      yield* grant("*");
      expect(yield* fill("https://nothing-saved.test", ["password"])).toEqual({
        _tag: "no-login",
        reason: "no-match",
      });
      expect(yield* fill("http://localhost:3000", ["password"])).toEqual({
        _tag: "no-login",
        reason: "not-a-site",
      });
      expect(yield* fill("file:///etc/passwd", ["password"])).toEqual({
        _tag: "no-login",
        reason: "not-a-site",
      });
      // Someone else's request never reaches this person's 1Password.
      expect(yield* fill("https://example.com", ["password"], { requester: "user_other" })).toEqual(
        { _tag: "not-owner" },
      );
      executor.unlink();
      expect(yield* fill("https://example.com", ["password"])).toEqual({
        _tag: "no-login",
        reason: "not-linked",
      });
      expect(executor.resolves).toEqual([]);
    }).pipe(Effect.provide(setup(executor.api)));
  });

  it.effect("says 1Password can't be read on a cloud without Executor", () =>
    Effect.gen(function* () {
      yield* grant("*");
      expect((yield* fill("https://example.com", ["password"]))._tag).toBe("unavailable");
    }).pipe(Effect.provide(setup(null))),
  );

  it.effect("keeps every value out of logs and spans", () => {
    const executor = memoryExecutor(SITES);
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
      const answer = yield* fill("https://example.com", ["password", "totp"]);
      yield* Effect.logInfo("the answer", { answer });
      const everything = JSON.stringify({
        answer,
        lines,
        spans: spans.map((span) => ({ name: span.name, attributes: [...span.attributes] })),
      });
      expect(spans.some((span) => span.name === "DeviceSignIn.fill")).toBe(true);
      expect(everything).not.toContain(PASSWORD);
      expect(everything).not.toContain(TOTP);
      expect(everything).not.toContain("example.com");
    }).pipe(Effect.provide(Layer.merge(setup(executor.api), watch)));
  });
});

describe("signalbox.signIn.fill", () => {
  const identity = { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" };
  const connect = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
    Effect.gen(function* () {
      const executor = memoryExecutor(SITES);
      const cloud = makeMemoryCloud({ executorLogins: executor.api });
      yield* cloud.userDirectory
        .forUser(OWNER)
        .recordSignIn({ id: OWNER, email: "o@example.test" });
      const rpc = yield* RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
        Effect.provide(
          Layer.mergeAll(
            CloudRpc.layerHandlers({ identity, userId: OWNER, sid: "test-session" }),
            CloudRpc.layerScopeAuthorization(scopes),
          ).pipe(Layer.provide(cloud.layerFor(OWNER))),
        ),
      );
      return { rpc };
    });

  it.effect("reaches the device that asked as redacted values, under its person's grants", () =>
    Effect.gen(function* () {
      const { rpc } = yield* connect([
        AuthOrchestrationReadScope,
        AuthPreviewOperateScope,
        AuthSettingsWriteScope,
      ]);
      const ask = { threadId, origin: "https://example.com/login", kinds: ["password"] } as const;
      expect(yield* rpc[SIGNALBOX_SIGN_IN_WS_METHODS.fill](ask)).toEqual({
        _tag: "ask",
        site: "example.com",
      });
      yield* rpc[SIGNALBOX_SIGN_IN_WS_METHODS.grant]({ source: person, site: "example.com" });
      const answer = yield* rpc[SIGNALBOX_SIGN_IN_WS_METHODS.fill](ask);
      expect(answer._tag === "filled" && Redacted.isRedacted(answer.password)).toBe(true);
      expect(filled(answer).password).toBe(PASSWORD);
      expect(String(answer)).not.toContain(PASSWORD);
    }),
  );

  it.effect("needs the preview operate scope", () =>
    Effect.gen(function* () {
      const { rpc } = yield* connect([AuthOrchestrationReadScope]);
      const exit = yield* rpc[SIGNALBOX_SIGN_IN_WS_METHODS.fill]({
        threadId,
        origin: "https://example.com",
        kinds: ["password"],
      }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});
