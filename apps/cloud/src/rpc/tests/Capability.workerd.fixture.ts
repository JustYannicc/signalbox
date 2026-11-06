import { DurableObject, RpcTarget, RpcStub } from "cloudflare:workers";
import { retainRpcCapability } from "../Capability.ts";
import { rpcResourceSnapshot } from "../Resources.ts";

class Source extends RpcTarget {
  readonly #release;
  constructor(release: () => void) {
    super();
    this.#release = release;
  }
  async ping() {
    return "retained argument";
  }
  [Symbol.dispose]() {
    this.#release();
  }
}
export class Authority extends DurableObject {
  #disposed = 0;
  readonly #released = Promise.withResolvers<void>();
  readonly #release = () => {
    this.#disposed++;
    this.#released.resolve();
  };
  issueTarget() {
    return new Source(this.#release);
  }
  issueFunction() {
    return new RpcStub(
      Object.assign(() => "retained argument", { [Symbol.dispose]: this.#release }),
    );
  }
  async released() {
    await this.#released.promise;
    return this.#disposed;
  }
}
export class Receiver extends DurableObject {
  #held: Disposable | undefined;
  #ping: (() => string | Promise<string>) | undefined;
  #hold<T extends object>(source: T, ping: (value: T) => string | Promise<string>) {
    const held = retainRpcCapability(source);
    this.#held = held;
    this.#ping = () => ping(held.value);
    return {
      duplicateType: typeof Reflect.get(source, "dup"),
      active: rpcResourceSnapshot().activeStubs,
    };
  }
  holdTarget(source: Pick<Source, "ping">) {
    return this.#hold(source, (value) => value.ping());
  }
  holdFunction(source: () => string | Promise<string>) {
    return this.#hold(source, (value) => value());
  }
  async ping() {
    if (this.#ping === undefined) throw new Error("No held capability");
    return await this.#ping();
  }
  close() {
    this.#held?.[Symbol.dispose]();
    this.#held = undefined;
    this.#ping = undefined;
    return rpcResourceSnapshot();
  }
}

export default {
  async fetch(
    request: Request,
    env: {
      RECEIVER: DurableObjectNamespace<Receiver>;
      AUTHORITY: DurableObjectNamespace<Authority>;
    },
  ) {
    const kind = new URL(request.url).searchParams.get("kind") ?? "target";
    const receiver = env.RECEIVER.getByName(kind);
    const path = new URL(request.url).pathname;
    if (path === "/hold") {
      const authority = env.AUTHORITY.getByName(kind);
      if (kind === "function") {
        using source = await authority.issueFunction();
        return Response.json(await receiver.holdFunction(source));
      }
      using source = await authority.issueTarget();
      return Response.json(await receiver.holdTarget(source));
    }
    if (path === "/ping") return Response.json({ value: await receiver.ping() });
    const resources = await receiver.close();
    return Response.json({
      resources,
      disposed: await env.AUTHORITY.getByName(kind).released(),
    });
  },
};
