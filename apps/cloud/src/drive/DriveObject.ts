import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import { DurableObject } from "cloudflare:workers";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { DRIVE_OBJECT_JURISDICTION, type DriveObjectApi } from "./DriveDirectory.ts";
import { makeDriveObjectApi } from "./driveObjectApi.ts";
import * as DriveStore from "./DriveStore.ts";

/**
 * One per drive, named by its drive id, always in the EU jurisdiction. It
 * holds the drive's refs and the index of its packs (see `DriveStore`); the
 * packs themselves are in R2. Every call is a short SQLite transaction, so the
 * object serializes ref moves without any lock of its own.
 */

export interface DriveObjectEnv {
  /** Set by `vp run dev` only. Local workerd has no jurisdictions. */
  readonly LOCAL_WORKERD?: string;
}

// The whole storage, not just `storage.sql`: writes and migrations run in transactions.
const makeRuntime = (storage: DurableObjectStorage) =>
  ManagedRuntime.make(DriveStore.layer.pipe(Layer.provideMerge(SqliteClient.layer({ storage }))));

export class DriveObject extends DurableObject<DriveObjectEnv> implements DriveObjectApi {
  private readonly api: DriveObjectApi;

  constructor(ctx: DurableObjectState, env: DriveObjectEnv) {
    super(ctx, env);
    if (env.LOCAL_WORKERD !== "1" && ctx.id.jurisdiction !== DRIVE_OBJECT_JURISDICTION) {
      throw new Error("Drive objects must live in the EU jurisdiction.");
    }
    const runtime = makeRuntime(ctx.storage);
    this.api = makeDriveObjectApi((effect) => runtime.runPromise(effect));
    void ctx.blockConcurrencyWhile(() =>
      runtime.runPromise(DriveStore.DriveStore.use((store) => store.initialize)),
    );
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

  registerPack(...args: Parameters<DriveObjectApi["registerPack"]>) {
    return this.api.registerPack(...args);
  }

  updateRefs(...args: Parameters<DriveObjectApi["updateRefs"]>) {
    return this.api.updateRefs(...args);
  }

  reconcile(...args: Parameters<DriveObjectApi["reconcile"]>) {
    return this.api.reconcile(...args);
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
}
