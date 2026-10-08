import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import { EnvironmentId } from "@t3tools/contracts";
import type { AccountProfile } from "@t3tools/contracts/account";
import { DurableObject } from "cloudflare:workers";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";

import * as DriveDirectory from "../drive/DriveDirectory.ts";
import * as DriveFiles from "../drive/DriveFiles.ts";
import * as DrivePacks from "../drive/DrivePacks.ts";
import * as Environment from "../environment.ts";
import * as Platform from "../platform.ts";
import * as CloudThreadService from "../thread/CloudThreadService.ts";
import type { MachineBackendEnv } from "../thread/runner/MachineBackend.ts";
import { type PreviewEnv, previewSettings } from "../thread/preview/previewHost.ts";
import { machineSettings } from "../thread/runner/machineBackends.ts";
import * as ThreadDirectory from "../thread/ThreadDirectory.ts";
import { serveConnection } from "./connection.ts";
import {
  CONNECTION_HEADER,
  decodeConnectionInfo,
  USER_OBJECT_JURISDICTION,
  type UserObjectApi,
} from "./UserDirectory.ts";
import * as ThreadContexts from "./threadContexts.ts";
import * as UserContexts from "./UserContexts.ts";
import { makeUserObjectApi } from "./userObjectApi.ts";
import * as UserSections from "./UserSections.ts";
import * as UserShell from "./UserShell.ts";
import * as UserStore from "./UserStore.ts";

/**
 * One per WorkOS user, named by their user id, always in the EU jurisdiction.
 * It owns that user's state (see `UserStore`) and terminates their clients'
 * RPC sockets, reaching their threads through `CloudThreadService`. The Worker
 * authenticates every request before it gets here and forwards a socket's
 * session in `CONNECTION_HEADER`.
 *
 * Sockets use the standard (non-hibernating) API, so an object stays in memory
 * while a client is connected.
 */

export interface UserObjectEnv extends MachineBackendEnv, PreviewEnv {
  /** Drives' objects and packs: clients browse them through this object (`drive/DriveFiles.ts`). */
  readonly DRIVES?: DriveDirectory.DriveObjectNamespace;
  readonly DRIVE_PACKS?: DrivePacks.PackBucket;
  readonly ENVIRONMENT_ID: string;
  readonly ENVIRONMENT_LABEL?: string;
  /** Set by `vp run dev` only. Local workerd has no jurisdictions. */
  readonly LOCAL_WORKERD?: string;
  readonly THREADS: ThreadDirectory.ThreadObjectNamespace;
}

const decodeEnvironmentId = Schema.decodeSync(EnvironmentId);

// The whole storage, not just `storage.sql`: migrations run in transactions.
const layerDrives = (env: UserObjectEnv) =>
  env.DRIVES === undefined || env.DRIVE_PACKS === undefined
    ? Layer.empty
    : DriveFiles.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            DriveDirectory.layerDurableObjects(env.DRIVES, {
              localWorkerd: env.LOCAL_WORKERD === "1",
            }),
            DrivePacks.layerBucket(env.DRIVE_PACKS),
          ),
        ),
      );

const makeRuntime = (storage: DurableObjectStorage, env: UserObjectEnv) =>
  ManagedRuntime.make(
    Layer.mergeAll(
      UserShell.layer,
      CloudThreadService.layer,
      UserSections.layer,
      layerDrives(env),
    ).pipe(
      Layer.provideMerge(ThreadContexts.layer),
      Layer.provideMerge(Layer.mergeAll(UserStore.layer, UserContexts.layer)),
      Layer.provideMerge(
        ThreadDirectory.layerDurableObjects(env.THREADS, {
          localWorkerd: env.LOCAL_WORKERD === "1",
        }),
      ),
      Layer.provideMerge(Layer.mergeAll(SqliteClient.layer({ storage }), Platform.layerCrypto)),
    ),
  );

export class UserObject extends DurableObject<UserObjectEnv> implements UserObjectApi {
  private readonly runtime: ReturnType<typeof makeRuntime>;
  private readonly identity: Environment.CloudEnvironmentIdentity;
  /** Open sockets per session, so revoking a session also disconnects it. */
  private readonly connections = new Map<string, Set<Fiber.Fiber<void>>>();

  constructor(ctx: DurableObjectState, env: UserObjectEnv) {
    super(ctx, env);
    // Created only through `jurisdiction("eu")`; anything else is a routing bug
    // that must not quietly store a user's data elsewhere.
    if (env.LOCAL_WORKERD !== "1" && ctx.id.jurisdiction !== USER_OBJECT_JURISDICTION) {
      throw new Error("User objects must live in the EU jurisdiction.");
    }
    // Decoded like the Worker's `CloudConfig`, from the same vars.
    this.identity = {
      environmentId: decodeEnvironmentId(env.ENVIRONMENT_ID),
      label: env.ENVIRONMENT_LABEL ?? Environment.DEFAULT_ENVIRONMENT_LABEL,
      harnesses: machineSettings(env) !== null,
      // Only machines run dev servers.
      previews: machineSettings(env) !== null && previewSettings(env) !== null,
    };
    this.runtime = makeRuntime(ctx.storage, env);
    void ctx.blockConcurrencyWhile(() => this.runtime.runPromise(UserStore.migrate));
  }

  private readonly api: UserObjectApi = makeUserObjectApi((effect) =>
    this.runtime.runPromise(effect),
  );

  // Durable Object RPC dispatches to prototype methods, so each one is spelled out.
  recordSignIn(profile: AccountProfile) {
    return this.api.recordSignIn(profile);
  }

  profile() {
    return this.api.profile();
  }

  createSession(input: Parameters<UserObjectApi["createSession"]>[0]) {
    return this.api.createSession(input);
  }

  findSession(sid: string) {
    return this.api.findSession(sid);
  }

  async revokeSession(sid: string) {
    const revoked = await this.api.revokeSession(sid);
    const fibers = this.connections.get(sid);
    if (fibers) await this.runtime.runPromise(Fiber.interruptAll(fibers));
    return revoked;
  }

  issueGrant(input: Parameters<UserObjectApi["issueGrant"]>[0]) {
    return this.api.issueGrant(input);
  }

  redeemHandoff(input: Parameters<UserObjectApi["redeemHandoff"]>[0]) {
    return this.api.redeemHandoff(input);
  }

  exchangeCredential(input: Parameters<UserObjectApi["exchangeCredential"]>[0]) {
    return this.api.exchangeCredential(input);
  }

  syncOrganizations(organizations: Parameters<UserObjectApi["syncOrganizations"]>[0]) {
    return this.api.syncOrganizations(organizations);
  }

  shellSnapshot() {
    return this.api.shellSnapshot();
  }

  recordThreadSummary(summary: unknown) {
    return this.api.recordThreadSummary(summary);
  }

  rebuildThreadIndex() {
    return this.api.rebuildThreadIndex();
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    // The Worker checked only the token's signature; the record is the authority.
    const { sid } = decodeConnectionInfo(request.headers.get(CONNECTION_HEADER));
    const session = await this.findSession(sid);
    const profile = await this.profile();
    if (!session || !profile) return new Response("Unauthorized", { status: 401 });

    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    server.accept();
    const fibers = this.connections.get(sid) ?? new Set();
    this.connections.set(sid, fibers);
    const fiber = this.runtime.runFork(
      serveConnection({
        webSocket: server,
        scopes: session.scopes,
        identity: this.identity,
        actor: { userId: profile.id },
      }).pipe(
        // An open socket never outlives its session.
        Effect.raceFirst(
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) => Effect.sleep(Math.max(0, session.expiresAt - now))),
          ),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            fibers.delete(fiber);
            if (fibers.size === 0) this.connections.delete(sid);
            try {
              server.close(1000);
            } catch {
              // Already closed by the client.
            }
          }),
        ),
      ),
    );
    fibers.add(fiber);
    // A revoke that landed while the socket was being set up missed this fiber.
    if (!(await this.findSession(sid))) await this.runtime.runPromise(Fiber.interrupt(fiber));
    return new Response(null, { status: 101, webSocket: client });
  }
}
