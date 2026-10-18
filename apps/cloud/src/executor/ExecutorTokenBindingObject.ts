import { DurableObject } from "cloudflare:workers";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { decodeExecutorTokenBinding } from "./ExecutorTokenBindings.ts";

interface Env {
  readonly LOCAL_WORKERD?: string;
}

const BINDING_KEY = "binding";
const isExpired = async (expiresAt: number) =>
  expiresAt * 1000 <= (await Effect.runPromise(Clock.currentTimeMillis));

/** One private authorization record, removed as soon as its short JWT expires. */
export class ExecutorTokenBindingObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (env.LOCAL_WORKERD !== "1" && ctx.id.jurisdiction !== "eu") {
      throw new Error("Executor token bindings must live in the EU.");
    }
  }

  async bind(value: unknown): Promise<boolean> {
    const decoded = decodeExecutorTokenBinding(value);
    if (decoded._tag === "None" || (await isExpired(decoded.value.expiresAt))) return false;
    const binding = decoded.value;
    if (this.ctx.id.name !== binding.jti) return false;
    return this.ctx.blockConcurrencyWhile(async () => {
      if ((await this.ctx.storage.get(BINDING_KEY)) !== undefined) return false;
      await this.ctx.storage.put(BINDING_KEY, binding);
      await this.ctx.storage.setAlarm(binding.expiresAt * 1000);
      return true;
    });
  }

  async read(jti: string): Promise<unknown | null> {
    if (this.ctx.id.name !== jti) return null;
    const value = await this.ctx.storage.get(BINDING_KEY);
    if (value === undefined) return null;
    const decoded = decodeExecutorTokenBinding(value);
    if (
      decoded._tag === "None" ||
      decoded.value.jti !== jti ||
      (await isExpired(decoded.value.expiresAt))
    ) {
      await this.ctx.storage.delete(BINDING_KEY);
      return null;
    }
    return decoded.value;
  }

  async remove(jti: string): Promise<void> {
    if (this.ctx.id.name !== jti) return;
    await this.ctx.storage.delete(BINDING_KEY);
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.delete(BINDING_KEY);
  }
}
