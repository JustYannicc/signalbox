import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import { DurableObject } from "cloudflare:workers";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import * as UserDirectory from "../user/UserDirectory.ts";
import { deliverAccess } from "./driveAccessOutbox.ts";
import { deliverDriveEvents } from "./driveEventOutbox.ts";
import { DRIVE_OBJECT_JURISDICTION, type DriveObjectApi } from "./DriveDirectory.ts";
import { makeDriveObjectApi } from "./driveObjectApi.ts";
import * as DrivePacks from "./DrivePacks.ts";
import * as DriveStore from "./DriveStore.ts";

/**
 * One per drive, named by its drive id, always in the EU jurisdiction. It
 * holds the drive's refs and the index of its packs (see `DriveStore`), and
 * its members (`DriveMembers`); the packs themselves are in R2. Every call is
 * a short SQLite transaction, so the object serializes ref moves without any
 * lock of its own.
 *
 * Membership changes reach each person's index, and ref moves each person's
 * automations (`DriveEvents`), from the object's alarm, which retries until
 * they land.
 */

export interface DriveObjectEnv {
  /** Set by `vp run dev` only. Local workerd has no jurisdictions. */
  readonly LOCAL_WORKERD?: string;
  readonly USERS: UserDirectory.UserObjectNamespace;
  readonly DRIVE_PACKS?: DrivePacks.PackBucket;
  readonly DRIVE_PACKS_PREFIX?: string;
}

const unavailablePacks: DrivePacks.PackBucket = {
  put: async () => {
    throw new Error("Drive pack storage is unavailable.");
  },
  get: async () => {
    throw new Error("Drive pack storage is unavailable.");
  },
  delete: async () => {
    throw new Error("Drive pack storage is unavailable.");
  },
};

/** Wait after the `failures`th failed delivery in a row: 5 s, doubling, at most 5 min. */
const retryDelay = (failures: number) => Math.min(5_000 * 2 ** (failures - 1), 300_000);

// The whole storage, not just `storage.sql`: writes and migrations run in transactions.
const makeRuntime = (storage: DurableObjectStorage, driveId: string, env: DriveObjectEnv) =>
  ManagedRuntime.make(
    DriveStore.layer(driveId).pipe(
      Layer.provideMerge(
        UserDirectory.layerDurableObjects(env.USERS, { localWorkerd: env.LOCAL_WORKERD === "1" }),
      ),
      Layer.provideMerge(
        DrivePacks.layerBucket(env.DRIVE_PACKS ?? unavailablePacks, env.DRIVE_PACKS_PREFIX),
      ),
      Layer.provideMerge(SqliteClient.layer({ storage })),
    ),
  );

type OutboxServices = ManagedRuntime.ManagedRuntime.Services<ReturnType<typeof makeRuntime>>;

export class DriveObject extends DurableObject<DriveObjectEnv> implements DriveObjectApi {
  private readonly api: DriveObjectApi;
  private readonly runtime: ReturnType<typeof makeRuntime>;
  private readonly driveId: string;
  private deliveryFailures = 0;

  constructor(ctx: DurableObjectState, env: DriveObjectEnv) {
    super(ctx, env);
    if (env.LOCAL_WORKERD !== "1" && ctx.id.jurisdiction !== DRIVE_OBJECT_JURISDICTION) {
      throw new Error("Drive objects must live in the EU jurisdiction.");
    }
    const driveId = ctx.id.name;
    if (driveId === undefined) throw new Error("Drive objects are always named by their drive id.");
    this.driveId = driveId;
    this.runtime = makeRuntime(ctx.storage, driveId, env);
    this.api = makeDriveObjectApi(
      driveId,
      (effect) => this.runtime.runPromise(effect),
      () => this.armAlarm(),
    );
    void ctx.blockConcurrencyWhile(() =>
      this.runtime.runPromise(DriveStore.DriveStore.use((store) => store.initialize)),
    );
  }

  private async armAlarm() {
    const current = await this.ctx.storage.getAlarm();
    // While deliveries fail, the backoff stands: every save would otherwise retry at once.
    if (current !== null && this.deliveryFailures > 0) return;
    const now = await this.runtime.runPromise(Clock.currentTimeMillis);
    if (current === null || current > now) await this.ctx.storage.setAlarm(now);
  }

  override async alarm() {
    const outbox = (name: string, deliver: Effect.Effect<boolean, never, OutboxServices>) =>
      deliver.pipe(
        Effect.catchCause((cause) =>
          Effect.logError(`drive ${name} delivery failed`, cause).pipe(Effect.as(false)),
        ),
      );
    // One failing doesn't hold up the other.
    const [access, events] = await this.runtime.runPromise(
      Effect.all(
        [
          outbox("access", deliverAccess(this.driveId)),
          outbox("event", deliverDriveEvents(this.driveId)),
        ],
        { concurrency: "unbounded" },
      ),
    );
    const delivered = access && events;
    this.deliveryFailures = delivered ? 0 : this.deliveryFailures + 1;
    if (!delivered) {
      const now = await this.runtime.runPromise(Clock.currentTimeMillis);
      await this.ctx.storage.setAlarm(now + retryDelay(this.deliveryFailures));
    }
  }

  // Durable Object RPC dispatches to prototype methods, so each one is spelled out.
  open(...args: Parameters<DriveObjectApi["open"]>) {
    return this.api.open(...args);
  }

  refs(...args: Parameters<DriveObjectApi["refs"]>) {
    return this.api.refs(...args);
  }

  ref(...args: Parameters<DriveObjectApi["ref"]>) {
    return this.api.ref(...args);
  }

  missing(...args: Parameters<DriveObjectApi["missing"]>) {
    return this.api.missing(...args);
  }

  promised(...args: Parameters<DriveObjectApi["promised"]>) {
    return this.api.promised(...args);
  }

  registerPack(...args: Parameters<DriveObjectApi["registerPack"]>) {
    return this.api.registerPack(...args);
  }

  updateRefs(...args: Parameters<DriveObjectApi["updateRefs"]>) {
    return this.api.updateRefs(...args);
  }

  reconcile(...args: Parameters<DriveObjectApi["reconcile"]>) {
    return this.api.reconcile(...args);
  }

  setRemote(...args: Parameters<DriveObjectApi["setRemote"]>) {
    return this.api.setRemote(...args);
  }

  remote() {
    return this.api.remote();
  }

  mirror(...args: Parameters<DriveObjectApi["mirror"]>) {
    return this.api.mirror(...args);
  }

  locate(...args: Parameters<DriveObjectApi["locate"]>) {
    return this.api.locate(...args);
  }

  locateAt(...args: Parameters<DriveObjectApi["locateAt"]>) {
    return this.api.locateAt(...args);
  }

  commits(...args: Parameters<DriveObjectApi["commits"]>) {
    return this.api.commits(...args);
  }

  log(...args: Parameters<DriveObjectApi["log"]>) {
    return this.api.log(...args);
  }

  replaceMain(...args: Parameters<DriveObjectApi["replaceMain"]>) {
    return this.api.replaceMain(...args);
  }

  shortcuts() {
    return this.api.shortcuts();
  }

  addShortcut(...args: Parameters<DriveObjectApi["addShortcut"]>) {
    return this.api.addShortcut(...args);
  }

  removeShortcut(...args: Parameters<DriveObjectApi["removeShortcut"]>) {
    return this.api.removeShortcut(...args);
  }

  unreconciled(...args: Parameters<DriveObjectApi["unreconciled"]>) {
    return this.api.unreconciled(...args);
  }

  setup(...args: Parameters<DriveObjectApi["setup"]>) {
    return this.api.setup(...args);
  }

  driveName() {
    return this.api.driveName();
  }

  role(...args: Parameters<DriveObjectApi["role"]>) {
    return this.api.role(...args);
  }

  members() {
    return this.api.members();
  }

  share(...args: Parameters<DriveObjectApi["share"]>) {
    return this.api.share(...args);
  }

  unshare(...args: Parameters<DriveObjectApi["unshare"]>) {
    return this.api.unshare(...args);
  }

  pendingAccess() {
    return this.api.pendingAccess();
  }

  purgeThread(...args: Parameters<DriveObjectApi["purgeThread"]>) {
    return this.api.purgeThread(...args);
  }

  collectPurgedPacks(...args: Parameters<DriveObjectApi["collectPurgedPacks"]>) {
    return this.api.collectPurgedPacks(...args);
  }
}
