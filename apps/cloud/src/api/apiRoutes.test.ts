import { TEST_DEVICE_CODE, workosStubLayer } from "@signalbox/account/WorkOSTesting";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CloudTokens from "../auth/CloudTokens.ts";
import { signLocalKey, verifyLocalKey } from "../localKeys/LocalKeys.ts";
import { CLOUD_TEST_ENV, layerConfig, makeMemoryCloud } from "../testing.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import { handleApiRequest } from "./apiRoutes.ts";

const userId = "user_1";
const user = { id: userId, email: "a@b.c" };

/** `handleApiRequest` against an in-memory cloud and a WorkOS that approved `approved` devices. */
const setup = (
  options: {
    readonly approved?: boolean;
    readonly signedUp?: boolean;
    readonly multipleOrganizations?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const cloud = makeMemoryCloud();
    const config = layerConfig(
      options.multipleOrganizations
        ? { ...CLOUD_TEST_ENV, T3CODE_WORKOS_API_KEY: "sk_test" }
        : undefined,
    );
    if (options.signedUp !== false) {
      yield* cloud.userDirectory.forUser(userId).recordSignIn(user);
    }
    const layer = Layer.mergeAll(
      CloudTokens.layer.pipe(Layer.provide(config)),
      config,
      Layer.succeed(UserDirectory.UserDirectory, cloud.userDirectory),
      workosStubLayer(
        options.approved === false
          ? {}
          : {
              [TEST_DEVICE_CODE]: options.multipleOrganizations
                ? { select: { user, organizationId: "org_personal" } }
                : user,
            },
        [],
        options.multipleOrganizations
          ? {
              [userId]: [
                { id: "org_personal", name: "Personal" },
                { id: "org_work", name: "Work" },
              ],
            }
          : {},
      ),
    );
    const request = (path: string, init?: RequestInit) =>
      handleApiRequest(new Request(`https://cloud.test/api/v1/${path}`, init)).pipe(
        Effect.flatMap((response) =>
          Effect.promise(async () => ({ status: response.status, body: await response.json() })),
        ),
        Effect.provide(layer),
      );
    const post = (path: string, body: unknown, key?: string) =>
      request(path, {
        method: "POST",
        body: JSON.stringify(body),
        headers: key === undefined ? {} : { authorization: `Bearer ${key}` },
      });
    return { cloud, request, post, layer };
  });

const login = (post: Effect.Success<ReturnType<typeof setup>>["post"]) =>
  Effect.gen(function* () {
    const started = yield* post("login", {});
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ userCode: "ABCD-EFGH", deviceCode: TEST_DEVICE_CODE });
    return yield* post("login/token", { deviceCode: TEST_DEVICE_CODE, label: "laptop" });
  });

describe("public API routes", () => {
  it.effect("finishes device-code organization selection on the server", () =>
    Effect.gen(function* () {
      const { post } = yield* setup({ multipleOrganizations: true });
      expect((yield* login(post)).status).toBe(200);
    }),
  );
  it.effect("lists operations with whether this cloud serves them", () =>
    Effect.gen(function* () {
      const { request } = yield* setup();
      const listed = yield* request("operations");
      const byName = new Map(
        (listed.body as { operations: Array<{ name: string; cloud: object }> }).operations.map(
          (operation) => [operation.name, operation],
        ),
      );
      expect(byName.get("folders.create")?.cloud).toEqual({ served: true });
      expect(byName.get("automations.list")?.cloud).toEqual({ served: true });
      expect(byName.get("settings.get")?.cloud).toEqual({ served: false, issue: "#440" });
      const detail = yield* request("operations/folders.create");
      expect(detail.body).toMatchObject({ input: { type: "object" } });
    }),
  );

  it.effect("signs a CLI in through WorkOS's device flow and answers with a personal key", () =>
    Effect.gen(function* () {
      const { post, cloud, layer } = yield* setup();
      const answer = yield* login(post);
      expect(answer.status).toBe(200);
      const key = (answer.body as { key: string }).key;
      expect(key.startsWith("sbk_")).toBe(true);

      const created = yield* post("folders.create", { name: "From the CLI", parentId: null }, key);
      expect(created.status).toBe(200);
      const handle = cloud.userDirectory.forUser(userId);
      expect((yield* handle.localKeys()).keys).toMatchObject([
        { label: "CLI · laptop", model: false },
      ]);
      // An API key is never also a pool key.
      const verified = yield* verifyLocalKey(key).pipe(Effect.provide(layer));
      expect((yield* handle.authorizeLocalModel(verified!.secret))._tag).toBe("denied");
    }),
  );

  it.effect("keeps a CLI waiting until the person approves it", () =>
    Effect.gen(function* () {
      const { post } = yield* setup({ approved: false });
      const answer = yield* login(post);
      expect(answer).toEqual({ status: 400, body: { error: "authorization_pending" } });
    }),
  );

  it.effect("signs in nobody who never used Signalbox", () =>
    Effect.gen(function* () {
      const { post } = yield* setup({ signedUp: false });
      expect((yield* login(post)).status).toBe(403);
    }),
  );

  it.effect("stops a key at its next call once it's revoked", () =>
    Effect.gen(function* () {
      const { post, cloud } = yield* setup();
      const key = ((yield* login(post)).body as { key: string }).key;
      expect((yield* post("folders.list", {}, key)).status).toBe(200);
      const handle = cloud.userDirectory.forUser(userId);
      const [made] = (yield* handle.localKeys()).keys;
      yield* handle.revokeLocalKey(made!.id);
      expect((yield* post("folders.list", {}, key)).status).toBe(401);
    }),
  );

  it.effect("never lets a harness key call the API", () =>
    Effect.gen(function* () {
      const { post, cloud, layer } = yield* setup();
      const created = yield* cloud.userDirectory.forUser(userId).createLocalKey("Computer");
      if (created._tag !== "created") throw new Error("no key");
      const key = yield* signLocalKey(userId, created.secret).pipe(Effect.provide(layer));
      expect((yield* post("folders.list", {}, key)).status).toBe(401);
    }),
  );

  it.effect("makes scoped script keys that can't do more than they were given", () =>
    Effect.gen(function* () {
      const { post } = yield* setup();
      const cliKey = ((yield* login(post)).body as { key: string }).key;
      const made = yield* post(
        "keys.create",
        { label: "nightly report", scopes: ["orchestration:read"], model: false },
        cliKey,
      );
      expect(made.status).toBe(200);
      const scriptKey = (made.body as { key: string }).key;
      expect((yield* post("folders.list", {}, scriptKey)).status).toBe(200);
      expect(
        (yield* post("folders.create", { name: "No", parentId: null }, scriptKey)).status,
      ).toBe(403);
      // A read-only key can't mint a wider one, or any: that needs settings:write.
      const wider = yield* post(
        "keys.create",
        { label: "escalate", scopes: ["orchestration:operate"], model: false },
        scriptKey,
      );
      expect(wider.status).toBe(403);
      const listed = yield* post("keys.list", {}, scriptKey);
      expect(
        (listed.body as { keys: Array<{ label: string }> }).keys.map((key) => key.label),
      ).toEqual(["CLI · laptop", "nightly report"]);
    }),
  );

  it.effect("refuses calls without a key this cloud made", () =>
    Effect.gen(function* () {
      const { post } = yield* setup();
      expect((yield* post("folders.list", {})).status).toBe(401);
      expect((yield* post("folders.list", {}, "sbk_forged.key")).status).toBe(401);
    }),
  );
});
