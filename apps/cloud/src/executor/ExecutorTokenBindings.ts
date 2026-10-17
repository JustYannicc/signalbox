import { SignInSource as SignInSourceSchema } from "@t3tools/contracts/signalboxSignIn";
import * as Schema from "effect/Schema";

import {
  ExecutorTokenIdentifier,
  ExecutorTokenIdentitySchema,
  ExecutorTokenPurpose,
  type ExecutorTokenIdentity,
} from "./ExecutorTokenClaims.ts";

export const ExecutorTokenBinding = Schema.Struct({
  jti: ExecutorTokenIdentifier,
  identity: ExecutorTokenIdentitySchema,
  issuedAt: Schema.Number,
  ownerUserId: ExecutorTokenIdentifier,
  requester: ExecutorTokenIdentifier,
  source: SignInSourceSchema,
  origin: ExecutorTokenIdentifier,
  grantId: ExecutorTokenIdentifier,
  purpose: ExecutorTokenPurpose,
  sessionId: Schema.optionalKey(ExecutorTokenIdentifier),
  expiresAt: Schema.Number,
});
export type ExecutorTokenBinding = typeof ExecutorTokenBinding.Type;
export const decodeExecutorTokenBinding = Schema.decodeUnknownOption(ExecutorTokenBinding);

export type ExecutorTokenBindingInput = Omit<
  ExecutorTokenBinding,
  "jti" | "identity" | "issuedAt" | "expiresAt"
>;

export const executorTokenBindingMatchesIdentity = (
  binding: Pick<ExecutorTokenBinding, "identity">,
  identity: ExecutorTokenIdentity,
): boolean =>
  binding.identity.owner === identity.owner &&
  binding.identity.level === identity.level &&
  binding.identity.person === identity.person &&
  binding.identity.thread === identity.thread &&
  binding.identity.turn === identity.turn &&
  binding.identity.automation === identity.automation;

export interface ExecutorTokenBindingObjectApi {
  readonly bind: (binding: ExecutorTokenBinding) => Promise<boolean>;
  readonly read: (jti: string) => Promise<unknown | null>;
  readonly remove: (jti: string) => Promise<void>;
}

export interface ExecutorTokenBindingNamespace {
  readonly idFromName: (name: string) => DurableObjectId;
  readonly jurisdiction: (name: "eu") => {
    readonly idFromName: (name: string) => DurableObjectId;
  };
  readonly get: (id: DurableObjectId) => ExecutorTokenBindingObjectApi;
}

export interface ExecutorTokenBindingStore {
  readonly bind: (binding: ExecutorTokenBinding) => Promise<boolean>;
  readonly get: (jti: string) => Promise<ExecutorTokenBinding | null>;
  readonly remove: (jti: string) => Promise<void>;
}

/** Each opaque JTI addresses one private, short lived Durable Object record. */
export const executorTokenBindingStore = (
  namespace: ExecutorTokenBindingNamespace,
  options: { readonly localWorkerd: boolean },
): ExecutorTokenBindingStore => {
  const objectFor = (jti: string) => {
    const ids = options.localWorkerd ? namespace : namespace.jurisdiction("eu");
    return namespace.get(ids.idFromName(jti));
  };
  return {
    bind: (binding) => objectFor(binding.jti).bind(binding),
    get: async (jti) => {
      const value = await objectFor(jti).read(jti);
      if (value === null) return null;
      const parsed = decodeExecutorTokenBinding(value);
      return parsed._tag === "Some" ? parsed.value : null;
    },
    remove: (jti) => objectFor(jti).remove(jti),
  };
};

export type { ExecutorTokenIdentity };
