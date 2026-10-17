import { PERSONAL_POOL_ID, POOL_LINK_PATH } from "@t3tools/contracts/accountHub";
import { describe, expect, it } from "@effect/vitest";
import * as AccountFlow from "@signalbox/account/AccountFlow";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as CloudTokens from "../auth/CloudTokens.ts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { OnePasswordEnvironmentId } from "@t3tools/contracts/signalboxFolders";
import { makeRepo } from "../drive/driveTesting.ts";
import { makeFakeGitHub } from "../github/githubTesting.ts";
import * as PoolDirectory from "../pool/PoolDirectory.ts";
import { decodeLinkToken } from "../pool/poolLink.ts";
import { CLOUD_TEST_ENV, layerConfig, makeMemoryCloud } from "../testing.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import * as UserPools from "../user/UserPools.ts";
import * as UserFolders from "../user/UserFolders.ts";
import * as PreviewSetup from "./PreviewSetup.ts";
import {
  PreviewSetup as PreviewSetupSchema,
  type PreviewSetup as Setup,
} from "./previewSetupWire.ts";

const decodeWireSetup = Schema.decodeUnknownSync(PreviewSetupSchema);

const userId = "user_1";
const actor = { userId };
const PROD = "https://app.signalbox.run";
const PREVIEW = "https://preview-7.signalbox.run";
const OTHER_PREVIEW = "https://preview-8.signalbox.run";
const LINK_URL = `${PROD}${POOL_LINK_PATH}`;

/**
 * Production and one preview, each a cloud of its own with its own session
 * secret, sharing WorkOS (users and Pipes) as they do deployed. The preview's
 * pools reach production's pool links; its `redeem` reaches production's.
 */
const setup = Effect.gen(function* () {
  const upstream = makeRepo();
  yield* Effect.addFinalizer(() => Effect.sync(upstream.cleanup));
  upstream.write("README.md", "hello\n");
  upstream.commit("first");
  const github = makeFakeGitHub({
    bare: upstream.dir,
    repository: "owner/repo",
    defaultBranch: "main",
  });
  const prod = makeMemoryCloud({ github: github.layer });
  /** A request on one of production's pool links, as its Worker routes it. */
  const prodLinks = (request: Request) => {
    const token = request.headers.get("authorization")?.replace(/^Bearer /u, "") ?? "";
    const decoded = decodeLinkToken(token);
    if (decoded === null) return Promise.resolve(new Response(null, { status: 401 }));
    return prod.pools.objectFor(decoded.objectName).api.linkFetch(decoded.secret, request);
  };
  const preview = makeMemoryCloud({ github: github.layer, poolFetch: prodLinks });

  const worker = (
    env: Readonly<Record<string, string>>,
    users: UserDirectory.UserDirectory["Service"],
    source: Layer.Layer<PreviewSetup.PreviewSetupSource>,
  ) =>
    Layer.build(
      PreviewSetup.layer.pipe(
        Layer.provideMerge(source),
        Layer.provideMerge(CloudTokens.layer),
        Layer.provideMerge(layerConfig(env)),
        Layer.provideMerge(Layer.succeed(UserDirectory.UserDirectory, users)),
      ),
    ).pipe(Effect.map((context) => Context.get(context, PreviewSetup.PreviewSetup)));

  const prodWorker = yield* worker(
    { ...CLOUD_TEST_ENV, PREVIEW_SETUP_ORIGINS: "https://preview-*.signalbox.run" },
    prod.userDirectory,
    Layer.succeed(PreviewSetup.PreviewSetupSource, {
      redeem: () => Effect.die("Production takes no setup"),
    }),
  );
  /** Every setup production handed over, in order. */
  const handed: Array<Setup> = [];
  const previewWorker = yield* worker(
    {
      ...CLOUD_TEST_ENV,
      SESSION_SECRET: "preview-7-session-secret-0123456789abcdef",
      PREVIEW_SETUP_SOURCE: PROD,
    },
    preview.userDirectory,
    Layer.succeed(PreviewSetup.PreviewSetupSource, {
      redeem: (request) =>
        prodWorker.redeem(request).pipe(
          Effect.tap((setup) => Effect.sync(() => handed.push(setup))),
          Effect.map((setup) => decodeWireSetup(JSON.parse(JSON.stringify(setup)) as unknown)),
        ),
    }),
  );

  for (const cloud of [prod, preview]) {
    yield* cloud.userDirectory.forUser(userId).recordSignIn({ id: userId, email: "a@b.c" });
  }

  /**
   * Signing in to the preview as `previewUser`, with `prodUser` signed in on
   * production: the browser's trip, answering where sign-in lands.
   */
  const handOff = (options: { readonly prodUser?: string | null } = {}) =>
    Effect.gen(function* () {
      const startAt = new URL(
        yield* previewWorker.start({ userId, origin: PREVIEW, returnTo: "/settings" }),
      );
      expect(startAt.origin).toBe(PROD);
      const back = yield* prodWorker.authorize({
        userId: options.prodUser === undefined ? userId : options.prodUser,
        origin: startAt.searchParams.get("origin")!,
        challenge: startAt.searchParams.get("challenge")!,
        state: startAt.searchParams.get("state")!,
      });
      const backAt = new URL(back!);
      expect(backAt.origin).toBe(PREVIEW);
      return yield* previewWorker.callback({
        userId,
        origin: backAt.origin,
        state: backAt.searchParams.get("state")!,
        code: backAt.searchParams.get("code"),
      });
    });

  /** Runs `effect` inside a cloud's user object. */
  const inside = <A, E>(
    cloud: ReturnType<typeof makeMemoryCloud>,
    effect: Effect.Effect<
      A,
      E,
      UserPools.UserPools | UserFolders.UserFolders | SqlClient.SqlClient
    >,
  ) => Effect.provide(effect, cloud.userObject(userId));
  const poolsOf = (cloud: ReturnType<typeof makeMemoryCloud>) =>
    inside(
      cloud,
      UserPools.UserPools.use((pools) => pools.list(actor)),
    );

  /** Signs an account into one of production's pools, the way Settings does. */
  const signInOnProd = (poolId: string) =>
    Effect.gen(function* () {
      const pool = prod.pools.directory.forPool(PoolDirectory.poolObjectName(userId, poolId));
      const login = yield* pool.startLogin(actor, "claude");
      yield* pool.completeLogin(actor, `https://localhost/callback?state=${login.state}`);
      yield* pool.loginStatus(actor, login.state);
    });

  return {
    prod,
    preview,
    github,
    prodWorker,
    previewWorker,
    handed,
    handOff,
    inside,
    poolsOf,
    signInOnProd,
  };
});

describe("preview setup", () => {
  it.effect("round-trips folder secret filters through the preview import", () =>
    Effect.gen(function* () {
      const { prod, preview, handed, handOff, inside } = yield* setup;
      const environment = OnePasswordEnvironmentId.make;
      const folders = yield* inside(
        prod,
        Effect.gen(function* () {
          const service = yield* UserFolders.UserFolders;
          const created = yield* service.create({
            name: "Clients",
            parentId: null,
            ownerId: PERSONAL_CONTEXT_ID,
          });
          const clients = created.folders.find((folder) => folder.name === "Clients")!;
          yield* service.setSecrets({
            level: { _tag: "top" },
            secrets: {
              environmentId: environment("env-top"),
              includeSubfolders: ["TOP_KEY"],
            },
          });
          yield* service.setSecrets({
            level: { _tag: "folder", folderId: clients.id },
            secrets: {
              environmentId: environment("env-clients"),
              includeSubfolders: ["CLIENT_KEY"],
            },
          });
          return yield* service.snapshot;
        }),
      );

      expect(yield* handOff()).toBe("/settings");
      expect(handed[0]?.folders).toMatchObject({
        topSecretsIncludeSubfolders: ["TOP_KEY"],
        folders: [
          {
            secrets_include_subfolders: ["CLIENT_KEY"],
          },
        ],
      });
      const imported = yield* inside(
        preview,
        UserFolders.UserFolders.use((service) => service.snapshot),
      );
      expect(imported.top.secrets).toEqual(folders.top.secrets);
      expect(imported.folders.map((folder) => folder.secrets)).toEqual(
        folders.folders.map((folder) => folder.secrets),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("a preview starts from the user's production setup, its pools routed to prod", () =>
    Effect.gen(function* () {
      const { prod, preview, github, handed, handOff, inside, poolsOf, signInOnProd } =
        yield* setup;
      // Production: pools with an account, folders nested with instructions and
      // one placement of a drive previews don't have, and GitHub connected.
      const work = yield* inside(
        prod,
        UserPools.UserPools.use((pools) => pools.create(actor, { name: "Work" })),
      );
      yield* signInOnProd(PERSONAL_POOL_ID);
      const folders = yield* inside(
        prod,
        Effect.gen(function* () {
          const service = yield* UserFolders.UserFolders;
          const created = yield* service.create({
            name: "Clients",
            parentId: null,
            ownerId: PERSONAL_CONTEXT_ID,
          });
          const clients = created.folders.find((folder) => folder.name === "Clients")!;
          yield* service.create({ name: "Acme", parentId: clients.id });
          yield* service.setInstructions({
            level: { _tag: "folder", folderId: clients.id },
            instructions: "Bill hourly.",
          });
          yield* service.setInstructions({ level: { _tag: "top" }, instructions: "Be brief." });
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO project_placements (project_id, section_id, position)
            VALUES ('drive-gone', ${clients.id}, 1)`;
          return yield* service.snapshot;
        }),
      );
      const user = prod.userDirectory.forUser(userId);
      yield* user.beginGitHubConnect({ grantId: "g", returnTo: "https://cloud.test/cb" });
      github.authorize(userId);
      yield* user.completeGitHubConnect("g");

      expect(yield* handOff()).toBe("/settings");

      // Setup only: nothing that runs or signs anyone in.
      expect(handed).toHaveLength(1);
      expect(Object.keys(handed[0]!).toSorted()).toEqual([
        "folders",
        "github",
        "pools",
        "sections",
        "userId",
      ]);

      // Same pools, under the same ids, each routed through production's link.
      const linked = yield* poolsOf(preview);
      expect(linked.map((pool) => [pool.id, pool.name, pool.backing])).toEqual([
        [PERSONAL_POOL_ID, "Personal", { mode: "external", url: LINK_URL }],
        [work.id, "Work", { mode: "external", url: LINK_URL }],
      ]);
      // Production's accounts show on the preview, and its model requests reach
      // production's CLIProxyAPI, which gets production's own key, not the link.
      const personal = preview.pools.directory.forPool(linked[0]!.objectName);
      const accounts = yield* personal.accounts(actor);
      const prodAccounts = yield* prod.pools.directory
        .forPool(PoolDirectory.poolObjectName(userId, PERSONAL_POOL_ID))
        .accounts(actor);
      expect(accounts.accounts.map((account) => account.name)).toEqual(
        prodAccounts.accounts.map((account) => account.name),
      );
      expect(accounts.accounts).toHaveLength(1);
      // So do the limits production read for them.
      expect(accounts.accounts[0]?.usageLimits).not.toBeNull();
      expect(accounts.accounts[0]?.usageLimits).toEqual(prodAccounts.accounts[0]?.usageLimits);
      const reply = yield* Effect.promise(() =>
        preview.pools
          .objectFor(linked[0]!.objectName)
          .api.forwardModel(
            actor,
            "/v1/messages",
            new Request("https://gateway.test/v1/messages", { method: "POST", body: "hi" }),
          ),
      );
      if (reply._tag !== "forwarded") return expect.unreachable();
      const echoed = (yield* Effect.promise(() => reply.response.json())) as {
        readonly path: string;
        readonly authorization: string;
        readonly body: string;
      };
      expect(echoed.path).toBe("/v1/messages");
      expect(echoed.body).toBe("hi");
      expect(echoed.authorization).not.toContain("sbpl_");
      // Accounts are added where the pool lives.
      expect(
        yield* personal.startLogin(actor, "claude").pipe(
          Effect.flip,
          Effect.map((e) => e.message),
        ),
      ).toBe("This pool is linked to app.signalbox.run. Add and manage its accounts there.");

      // Folders, their instructions and GitHub came along.
      const previewFolders = yield* inside(
        preview,
        UserFolders.UserFolders.use((service) => service.snapshot),
      );
      expect(previewFolders.folders).toEqual(folders.folders);
      expect(previewFolders.top).toEqual({ instructions: "Be brief." });
      expect(yield* preview.userDirectory.forUser(userId).githubAccessToken()).toBe(
        `gho_${userId}`,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("running it again renews the pool links and copies nothing twice", () =>
    Effect.gen(function* () {
      const { prod, preview, handed, handOff, inside, poolsOf } = yield* setup;
      const foldersOf = (cloud: typeof prod) =>
        inside(
          cloud,
          UserFolders.UserFolders.use((service) => service.snapshot),
        ).pipe(Effect.map((snapshot) => snapshot.folders.map((folder) => folder.name)));
      yield* inside(
        prod,
        UserFolders.UserFolders.use((service) =>
          service.create({ name: "Clients", parentId: null, ownerId: PERSONAL_CONTEXT_ID }),
        ),
      );
      yield* handOff();
      expect(yield* foldersOf(preview)).toEqual(["Clients"]);
      const firstPersonal = handed[0]!.pools.find((pool) => pool.personal)!.token;
      // Since then: deleted on the preview, and more made on production.
      yield* inside(
        preview,
        Effect.gen(function* () {
          const service = yield* UserFolders.UserFolders;
          const [clients] = (yield* service.snapshot).folders;
          yield* service.delete({ id: clients!.id });
        }),
      );
      yield* inside(
        prod,
        UserFolders.UserFolders.use((service) =>
          service.create({ name: "Later", parentId: null, ownerId: PERSONAL_CONTEXT_ID }),
        ),
      );
      const team = yield* inside(
        prod,
        UserPools.UserPools.use((pools) => pools.create(actor, { name: "Team" })),
      );

      expect(yield* handOff()).toBe("/settings");
      expect(handed).toHaveLength(2);
      // Folders were copied once: the preview's own changes stand.
      expect(yield* foldersOf(preview)).toEqual([]);
      // One preview pool per production pool, the new one included, on fresh links.
      const pools = yield* poolsOf(preview);
      expect(pools.map((pool) => pool.id).toSorted()).toEqual(
        [PERSONAL_POOL_ID, handed[1]!.pools.find((pool) => !pool.personal)!.id].toSorted(),
      );
      expect(pools.map((pool) => pool.id)).toContain(team.id);
      const secondPersonal = handed[1]!.pools.find((pool) => pool.personal)!.token;
      expect(secondPersonal).not.toBe(firstPersonal);
      const linkStatus = (token: string) =>
        Effect.promise(async () => {
          const decoded = decodeLinkToken(token)!;
          const response = await prod.pools
            .objectFor(decoded.objectName)
            .api.linkFetch(
              decoded.secret,
              new Request(`${LINK_URL}`, { headers: { authorization: `Bearer ${token}` } }),
            );
          return response.status;
        });
      // Production keeps the link before the newest, in case this hand-off had failed
      // part way; the one before that is retired.
      expect(yield* linkStatus(firstPersonal)).toBe(200);
      expect(yield* linkStatus(secondPersonal)).toBe(200);
      yield* handOff();
      const thirdPersonal = handed[2]!.pools.find((pool) => pool.personal)!.token;
      expect(yield* linkStatus(firstPersonal)).toBe(401);
      expect(yield* linkStatus(secondPersonal)).toBe(200);
      expect(yield* linkStatus(thirdPersonal)).toBe(200);
    }).pipe(Effect.scoped),
  );

  it.effect("a pool someone pointed elsewhere on the preview stays theirs", () =>
    Effect.gen(function* () {
      const { preview, handed, handOff, inside, poolsOf } = yield* setup;
      yield* handOff();
      yield* inside(
        preview,
        UserPools.UserPools.use((pools) =>
          pools.setBacking(actor, { poolId: PERSONAL_POOL_ID, backing: { mode: "managed" } }),
        ),
      );
      yield* handOff();
      expect(handed).toHaveLength(2);
      const [personal] = yield* poolsOf(preview);
      expect(personal?.backing).toEqual({ mode: "managed" });
    }).pipe(Effect.scoped),
  );

  it.effect("a claim is one-time and bound to its user, origin and verifier", () =>
    Effect.gen(function* () {
      const { prodWorker } = yield* setup;
      const verifier = AccountFlow.randomToken();
      const claim = (origin = PREVIEW) =>
        prodWorker
          .authorize({
            userId,
            origin,
            challenge: AccountFlow.pkceChallenge(verifier),
            state: "s",
          })
          .pipe(Effect.map((location) => new URL(location!).searchParams.get("code")!));
      const redeem = (
        code: string,
        overrides: Partial<{ origin: string; userId: string; verifier: string }> = {},
      ) =>
        prodWorker.redeem({ code, verifier, origin: PREVIEW, userId, ...overrides }).pipe(
          Effect.map((setup) => setup.userId),
          Effect.catchTags({
            PreviewSetupRedeemError: (error) => Effect.succeed(error.reason),
          }),
        );

      // Production answers only allowed preview origins, and gives nobody's setup
      // to a browser not signed in there.
      expect(
        yield* prodWorker.authorize({
          userId,
          origin: "https://evil.test",
          challenge: "c",
          state: "s",
        }),
      ).toBeNull();
      expect(
        yield* prodWorker.authorize({
          userId: null,
          origin: PREVIEW,
          challenge: AccountFlow.pkceChallenge(verifier),
          state: "s",
        }),
      ).toBe(`${PREVIEW}/api/preview-setup/callback?state=s`);

      const code = yield* claim();
      expect(yield* redeem(code, { origin: OTHER_PREVIEW })).toBe("rejected");
      expect(yield* redeem(code, { userId: "user_2" })).toBe("rejected");
      expect(yield* redeem(code, { verifier: AccountFlow.randomToken() })).toBe("expired");
      // None of those spent it; it works exactly once.
      expect(yield* redeem(code)).toBe(userId);
      expect(yield* redeem(code)).toBe("expired");

      // A claim made for one preview is no good at another.
      const forOther = yield* claim(OTHER_PREVIEW);
      expect(yield* redeem(forOther)).toBe("rejected");
      expect(yield* redeem(forOther, { origin: OTHER_PREVIEW })).toBe(userId);
    }).pipe(Effect.scoped),
  );

  it.effect("a claim expires within minutes", () =>
    Effect.gen(function* () {
      const { prodWorker } = yield* setup;
      const verifier = AccountFlow.randomToken();
      const location = yield* prodWorker.authorize({
        userId,
        origin: PREVIEW,
        challenge: AccountFlow.pkceChallenge(verifier),
        state: "s",
      });
      const code = new URL(location!).searchParams.get("code")!;
      // The user object stamps the claim on its own clock; past that, it's gone.
      const { exp } = JSON.parse(
        new TextDecoder().decode(Result.getOrThrow(Base64Url.decode(code.split(".")[0]!))),
      ) as { readonly exp: number };
      yield* TestClock.setTime(exp);
      const result = yield* prodWorker
        .redeem({ code, verifier, origin: PREVIEW, userId })
        .pipe(Effect.flip);
      expect(result.reason).toBe("expired");
    }).pipe(Effect.scoped),
  );

  it.effect("signing in goes on when production has nobody signed in, or someone else", () =>
    Effect.gen(function* () {
      const { handed, handOff, poolsOf, preview } = yield* setup;
      expect(yield* handOff({ prodUser: null })).toBe("/settings");
      expect(yield* handOff({ prodUser: "user_2" })).toBe("/settings");
      expect(handed).toEqual([]);
      const [personal] = yield* poolsOf(preview);
      expect(personal?.backing).toEqual({ mode: "managed" });
    }).pipe(Effect.scoped),
  );

  it.effect(
    "takes production's 1Password account whenever the preview has none, never over its own",
    () =>
      Effect.gen(function* () {
        const { prod, preview, handed, handOff, inside } = yield* setup;
        const connect = (cloud: typeof prod, token: string) =>
          inside(
            cloud,
            UserFolders.UserFolders.use((service) => service.setOnePassword({ token })),
          );
        const tokenOf = (cloud: typeof prod) =>
          cloud.userDirectory.forUser(userId).onePasswordToken();
        yield* handOff();
        expect(handed[0]!.onePassword).toBeUndefined();

        // Connected on production after the first hand-off: the next one brings it.
        yield* connect(prod, "ops_production");
        yield* handOff();
        expect(handed[1]!.onePassword).toEqual({ token: "ops_production" });
        expect(yield* tokenOf(preview)).toBe("ops_production");
        const previewFolders = yield* inside(
          preview,
          UserFolders.UserFolders.use((service) => service.snapshot),
        );
        expect(previewFolders.onePassword).toBeDefined();

        // One the preview connected itself stays.
        yield* connect(preview, "ops_preview");
        yield* handOff();
        expect(yield* tokenOf(preview)).toBe("ops_preview");
      }).pipe(Effect.scoped),
  );
});
