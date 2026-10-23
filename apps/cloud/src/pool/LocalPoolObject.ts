import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import type { ModelSelection } from "@t3tools/contracts";
import { DurableObject, RpcTarget, type RpcStub } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import { createLocalPool } from "./LocalPool.ts";
import { LocalPoolCapability, type LocalPoolCapabilityApi } from "./LocalPoolCapability.ts";
import type { PoolModelApi, PoolObjectApi } from "./PoolDirectory.ts";
import {
  LocalModelRequest,
  forwardLocalModelRequest,
  type LocalModelRequestApi,
} from "./LocalModelRequest.ts";

/** A callback stays on its owner; RPC transfers a callable capability. */
export interface LocalModelTransportApi extends RpcTarget {
  readonly request: (request: Request) => LocalModelRequestApi;
}

export class LocalModelTransport extends RpcTarget implements LocalModelTransportApi {
  readonly #fetch: (request: Request) => Promise<Response>;

  constructor(fetch: (request: Request) => Promise<Response>) {
    super();
    this.#fetch = fetch;
  }

  request(request: Request): LocalModelRequestApi {
    return new LocalModelRequest(request, this.#fetch);
  }
}

export type LocalPoolObjectApi = PoolObjectApi &
  PoolModelApi & {
    readonly configure: (
      ownerId: string,
      transport: RpcStub<LocalModelTransportApi>,
      selection: ModelSelection,
    ) => Promise<void>;
    readonly register: () => Promise<void>;
    readonly capability: () => Promise<RpcStub<LocalPoolCapabilityApi>>;
    readonly dispose: () => Promise<void>;
  };

/** Owns the local pool's real engine and storage; only its model handler crosses RPC. */
export class LocalPoolObject extends DurableObject<unknown> implements PoolObjectApi, PoolModelApi {
  private readonly scope = Effect.runSync(Scope.make());
  private configured: Promise<Effect.Success<ReturnType<typeof createLocalPool>>> | undefined;
  private configuration: { readonly ownerId: string; readonly model: string } | undefined;
  private closed = false;
  private transport: RpcStub<LocalModelTransportApi> | undefined;

  async configure(
    ownerId: string,
    transport: RpcStub<LocalModelTransportApi>,
    selection: ModelSelection,
  ) {
    return this.ctx.blockConcurrencyWhile(() => this.configurePool(ownerId, transport, selection));
  }

  private async configurePool(
    ownerId: string,
    transport: RpcStub<LocalModelTransportApi>,
    selection: ModelSelection,
  ) {
    if (this.closed) throw new Error("The local pool is closed.");
    if (this.configuration !== undefined) {
      if (this.configuration.ownerId !== ownerId || this.configuration.model !== selection.model)
        throw new Error("A local pool cannot be rebound to another owner or model.");
      await this.configured;
      return;
    }
    const expected = { ownerId, model: selection.model };
    const previous = await this.ctx.storage.get<typeof expected>("local-pool-owner");
    if (
      previous !== undefined &&
      (previous.ownerId !== ownerId || previous.model !== selection.model)
    )
      throw new Error("This pool storage belongs to another local domain.");
    await this.ctx.storage.put("local-pool-owner", expected);
    this.configuration = expected;
    const held = transport.dup();
    this.transport = held;
    this.configured = Effect.runPromise(
      createLocalPool({
        sql: SqliteClient.layer({ storage: this.ctx.storage }),
        ownerId,
        transport: {
          id: "local",
          models: [{ id: selection.model, ownedBy: "anthropic", created: null }],
          fetch: (request) => forwardLocalModelRequest(request, (input) => held.request(input)),
        },
      }).pipe(Scope.provide(this.scope)),
    );
    await this.configured;
  }

  private async pool() {
    if (this.closed) throw new Error("The local pool is closed.");
    if (this.configured === undefined) throw new Error("The local pool is not configured.");
    return this.configured;
  }

  capability(): LocalPoolCapabilityApi {
    return new LocalPoolCapability(this);
  }

  async register() {
    await Effect.runPromise((await this.pool()).register);
  }
  async dispose() {
    this.closed = true;
    try {
      await Effect.runPromise(Scope.close(this.scope, Exit.void));
    } finally {
      this.transport?.[Symbol.dispose]();
      this.transport = undefined;
    }
  }

  async create(...args: Parameters<PoolObjectApi["create"]>) {
    return (await this.pool()).api.create(...args);
  }
  async info(...args: Parameters<PoolObjectApi["info"]>) {
    return (await this.pool()).api.info(...args);
  }
  async rename(...args: Parameters<PoolObjectApi["rename"]>) {
    return (await this.pool()).api.rename(...args);
  }
  async setRouting(...args: Parameters<PoolObjectApi["setRouting"]>) {
    return (await this.pool()).api.setRouting(...args);
  }
  async setBacking(...args: Parameters<PoolObjectApi["setBacking"]>) {
    return (await this.pool()).api.setBacking(...args);
  }
  async delete(...args: Parameters<PoolObjectApi["delete"]>) {
    return (await this.pool()).api.delete(...args);
  }
  async accounts(...args: Parameters<PoolObjectApi["accounts"]>) {
    return (await this.pool()).api.accounts(...args);
  }
  async advice(...args: Parameters<PoolObjectApi["advice"]>) {
    return (await this.pool()).api.advice(...args);
  }
  async models(...args: Parameters<PoolObjectApi["models"]>) {
    return (await this.pool()).api.models(...args);
  }
  async startLogin(...args: Parameters<PoolObjectApi["startLogin"]>) {
    return (await this.pool()).api.startLogin(...args);
  }
  async loginStatus(...args: Parameters<PoolObjectApi["loginStatus"]>) {
    return (await this.pool()).api.loginStatus(...args);
  }
  async completeLogin(...args: Parameters<PoolObjectApi["completeLogin"]>) {
    return (await this.pool()).api.completeLogin(...args);
  }
  async cancelLogin(...args: Parameters<PoolObjectApi["cancelLogin"]>) {
    return (await this.pool()).api.cancelLogin(...args);
  }
  async logoutAccount(...args: Parameters<PoolObjectApi["logoutAccount"]>) {
    return (await this.pool()).api.logoutAccount(...args);
  }
  async updateAccount(...args: Parameters<PoolObjectApi["updateAccount"]>) {
    return (await this.pool()).api.updateAccount(...args);
  }
  async openLink(...args: Parameters<PoolObjectApi["openLink"]>) {
    return (await this.pool()).api.openLink(...args);
  }
  async forwardModel(...args: Parameters<PoolModelApi["forwardModel"]>) {
    return (await this.pool()).api.forwardModel(...args);
  }
}
