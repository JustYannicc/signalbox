import { RpcTarget } from "cloudflare:workers";
import type { PoolModelApi, PoolObjectApi } from "./PoolDirectory.ts";
import { LocalModelRequest, type LocalModelRequestApi } from "./LocalModelRequest.ts";

/** Retains the pool object's existing RPC surface for another object. */
export interface LocalPoolCapabilityApi extends RpcTarget, PoolObjectApi, PoolModelApi {
  readonly requestModel: (
    ...args: Parameters<PoolModelApi["forwardModel"]>
  ) => LocalModelRequestApi;
}

export class LocalPoolCapability extends RpcTarget implements LocalPoolCapabilityApi {
  readonly #api: PoolObjectApi & PoolModelApi;

  constructor(api: PoolObjectApi & PoolModelApi) {
    super();
    this.#api = api;
  }

  async create(...args: Parameters<PoolObjectApi["create"]>) {
    return this.#api.create(...args);
  }
  async info(...args: Parameters<PoolObjectApi["info"]>) {
    return this.#api.info(...args);
  }
  async rename(...args: Parameters<PoolObjectApi["rename"]>) {
    return this.#api.rename(...args);
  }
  async setRouting(...args: Parameters<PoolObjectApi["setRouting"]>) {
    return this.#api.setRouting(...args);
  }
  async setBacking(...args: Parameters<PoolObjectApi["setBacking"]>) {
    return this.#api.setBacking(...args);
  }
  async delete(...args: Parameters<PoolObjectApi["delete"]>) {
    return this.#api.delete(...args);
  }
  async accounts(...args: Parameters<PoolObjectApi["accounts"]>) {
    return this.#api.accounts(...args);
  }
  async advice(...args: Parameters<PoolObjectApi["advice"]>) {
    return this.#api.advice(...args);
  }
  async models(...args: Parameters<PoolObjectApi["models"]>) {
    return this.#api.models(...args);
  }
  async startLogin(...args: Parameters<PoolObjectApi["startLogin"]>) {
    return this.#api.startLogin(...args);
  }
  async loginStatus(...args: Parameters<PoolObjectApi["loginStatus"]>) {
    return this.#api.loginStatus(...args);
  }
  async completeLogin(...args: Parameters<PoolObjectApi["completeLogin"]>) {
    return this.#api.completeLogin(...args);
  }
  async cancelLogin(...args: Parameters<PoolObjectApi["cancelLogin"]>) {
    return this.#api.cancelLogin(...args);
  }
  async logoutAccount(...args: Parameters<PoolObjectApi["logoutAccount"]>) {
    return this.#api.logoutAccount(...args);
  }
  async updateAccount(...args: Parameters<PoolObjectApi["updateAccount"]>) {
    return this.#api.updateAccount(...args);
  }
  async openLink(...args: Parameters<PoolObjectApi["openLink"]>) {
    return this.#api.openLink(...args);
  }
  async forwardModel(...args: Parameters<PoolModelApi["forwardModel"]>) {
    return this.#api.forwardModel(...args);
  }

  requestModel(
    actor: Parameters<PoolModelApi["forwardModel"]>[0],
    path: string,
    request: Request,
    thread?: string,
    trace?: Parameters<PoolModelApi["forwardModel"]>[4],
  ): LocalModelRequestApi {
    return new LocalModelRequest(request, async (input) => {
      const reply = await this.#api.forwardModel(actor, path, input, thread, trace);
      if (reply._tag !== "forwarded") throw new Error(reply.reason);
      return reply.response;
    });
  }
}
