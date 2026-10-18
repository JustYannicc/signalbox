import { HomeObject as CatalogHomeObject } from "../HomeObject.ts";
import type { ShardDOState } from "lunorash/do";
export { CatalogScheduler } from "../catalogScheduler.ts";

export class HomeObject extends CatalogHomeObject {
  private readonly testStorage: DurableObjectStorage;

  constructor(state: ShardDOState, env: unknown) {
    super(state, env);
    this.testStorage = (state as ShardDOState & DurableObjectState).storage;
  }

  override async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === "/test/fence-failure") {
      await this.testStorage.put("test:block-fences", request.method === "POST");
      return new Response(null, { status: 204 });
    }
    if (path === "/_lunora/delivery-fence" && (await this.testStorage.get("test:block-fences"))) {
      return new Response("Injected fence installation failure", { status: 503 });
    }
    return super.fetch(request);
  }
}

export default {
  fetch: () => new Response("No public Catalog route", { status: 404 }),
};
