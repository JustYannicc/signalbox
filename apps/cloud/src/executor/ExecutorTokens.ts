import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importJWK,
  SignJWT,
  type JWK,
} from "jose";
import * as Schema from "effect/Schema";

import {
  decodeExecutorAuthorizationClaims,
  decodeExecutorTokenIdentity,
  executorTokenPurpose,
  type ExecutorAuthorizationClaims,
  type ExecutorTokenIdentity,
  type ExecutorTokenRole,
  roleOf,
} from "./ExecutorTokenClaims.ts";
import {
  executorTokenBindingMatchesIdentity,
  type ExecutorTokenBinding,
  type ExecutorTokenBindingInput,
  type ExecutorTokenBindingStore,
} from "./ExecutorTokenBindings.ts";

export const EXECUTOR_TOKEN_TTL_SECONDS = 300;
export const EXECUTOR_JWKS_PATH = "/.well-known/executor-jwks.json";
const FUTURE_IAT_TOLERANCE_SECONDS = 30;

export type ExecutorPublicJwk = Omit<JsonWebKey, "alg" | "key_ops" | "use"> & {
  readonly alg: "ES256";
  readonly kid: string;
  readonly key_ops: Array<"verify">;
  readonly use: "sig";
};

export interface ExecutorTokenEnv {
  readonly EXECUTOR_TOKEN_ISSUER?: string;
  /** JSON P-256 JWK, derived from the deployment's stable secret seed. */
  readonly EXECUTOR_TOKEN_PRIVATE_JWK?: string;
  /** Local workerd may use an ephemeral key because it never holds production state. */
  readonly LOCAL_WORKERD?: string;
}

export interface ExecutorTokenAuthority {
  readonly person: (
    claims: ExecutorAuthorizationClaims,
    binding: ExecutorTokenBinding,
  ) => Promise<boolean>;
  readonly turn: (
    claims: ExecutorAuthorizationClaims,
    binding: ExecutorTokenBinding,
  ) => Promise<boolean>;
  readonly automation: (
    claims: ExecutorAuthorizationClaims,
    binding: ExecutorTokenBinding,
  ) => Promise<boolean>;
}

export interface ExecutorTokenService {
  readonly issue: (
    identity: ExecutorTokenIdentity,
    binding: ExecutorTokenBindingInput,
  ) => Promise<string>;
  readonly jwks: () => Promise<{ readonly keys: ReadonlyArray<ExecutorPublicJwk> }>;
  readonly authorize: (
    claims: unknown,
    authority: ExecutorTokenAuthority,
  ) => Promise<{ readonly active: boolean }>;
}

export interface ExecutorTokenRuntime {
  readonly nowSeconds: () => number | Promise<number>;
  readonly newJti: () => string | Promise<string>;
}

const PrivateJwk = Schema.Struct({
  kty: Schema.Literal("EC"),
  crv: Schema.Literal("P-256"),
  d: Schema.NonEmptyString,
  x: Schema.NonEmptyString,
  y: Schema.NonEmptyString,
});
const decodePrivateJwk = Schema.decodeUnknownOption(PrivateJwk);

const privateJwkFrom = (env: ExecutorTokenEnv): JWK => {
  const serialized = env.EXECUTOR_TOKEN_PRIVATE_JWK?.trim();
  if (!serialized) throw new Error("Executor token signing is not configured.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error("Executor token signing is not configured.");
  }
  const jwk = decodePrivateJwk(parsed);
  if (jwk._tag === "None") {
    throw new Error("Executor token signing is not configured.");
  }
  return jwk.value;
};

const bindingMatchesIdentity = (
  binding: ExecutorTokenBinding,
  identity: ExecutorTokenIdentity,
  jti: string,
  iat: number,
  exp: number,
) =>
  binding.jti === jti &&
  binding.issuedAt === iat &&
  binding.expiresAt === exp &&
  binding.purpose === executorTokenPurpose(identity) &&
  executorTokenBindingMatchesIdentity(binding, identity) &&
  (binding.source._tag === "folder"
    ? identity.level !== identity.owner && binding.source.folderId === identity.level
    : identity.level === identity.owner);

/** ES256 issuer and per-request, fail-closed authorization over a private JTI registry. */
export const makeExecutorTokenService = (
  env: ExecutorTokenEnv,
  bindings: ExecutorTokenBindingStore,
  runtime: ExecutorTokenRuntime,
): ExecutorTokenService => {
  let material:
    | Promise<{
        readonly privateKey: CryptoKey;
        readonly publicJwk: ExecutorPublicJwk;
        readonly kid: string;
      }>
    | undefined;
  const keyMaterial = () => {
    material ??= (async () => {
      const configuredKey = env.EXECUTOR_TOKEN_PRIVATE_JWK?.trim();
      const jwk =
        configuredKey === undefined || configuredKey.length === 0
          ? env.LOCAL_WORKERD === "1"
            ? await exportJWK((await generateKeyPair("ES256", { extractable: true })).privateKey)
            : privateJwkFrom(env)
          : privateJwkFrom({ ...env, EXECUTOR_TOKEN_PRIVATE_JWK: configuredKey });
      const privateKey = await importJWK(jwk, "ES256");
      const kid = await calculateJwkThumbprint(jwk);
      const x = jwk.x;
      const y = jwk.y;
      if (typeof x !== "string" || typeof y !== "string") {
        throw new Error("Executor token signing is not configured.");
      }
      return {
        privateKey: privateKey as CryptoKey,
        publicJwk: {
          kty: "EC",
          crv: "P-256",
          x,
          y,
          kid,
          use: "sig",
          alg: "ES256",
          key_ops: ["verify"],
        } as ExecutorPublicJwk,
        kid,
      };
    })();
    return material;
  };

  return {
    issue: async (input, context) => {
      const identity = decodeExecutorTokenIdentity(input);
      const issuer = env.EXECUTOR_TOKEN_ISSUER?.trim();
      if (!issuer) throw new Error("Executor token issuer is not configured.");
      const purpose = executorTokenPurpose(identity);
      if (
        context.purpose !== purpose ||
        (purpose === "interactive-person" && context.sessionId === undefined) ||
        (purpose !== "interactive-person" && context.sessionId !== undefined) ||
        (identity.person !== undefined && identity.person !== context.ownerUserId) ||
        (context.source._tag === "person" && identity.level !== identity.owner) ||
        (context.source._tag === "folder" &&
          (identity.level === identity.owner || context.source.folderId !== identity.level))
      ) {
        throw new Error("Executor token authority binding is invalid.");
      }
      const { privateKey, kid } = await keyMaterial();
      const iat = await runtime.nowSeconds();
      if (!Number.isSafeInteger(iat)) throw new Error("Executor token clock is unavailable.");
      const exp = iat + EXECUTOR_TOKEN_TTL_SECONDS;
      const jti = await runtime.newJti();
      const token = await new SignJWT(identity)
        .setProtectedHeader({ alg: "ES256", kid, typ: "JWT" })
        .setIssuer(issuer)
        .setAudience("executor")
        .setIssuedAt(iat)
        .setExpirationTime(exp)
        .setJti(jti)
        .sign(privateKey);
      const created = await bindings.bind({
        ...context,
        jti,
        identity,
        issuedAt: iat,
        expiresAt: exp,
      });
      if (!created) throw new Error("Executor token authority binding could not be stored.");
      return token;
    },
    jwks: async () => {
      const { publicJwk } = await keyMaterial();
      return { keys: [publicJwk] };
    },
    authorize: async (value, authority) => {
      const claims = decodeExecutorAuthorizationClaims(value);
      if (claims === null) return { active: false };
      let now: number;
      try {
        now = await runtime.nowSeconds();
      } catch {
        return { active: false };
      }
      if (!validTime(claims, now)) return { active: false };
      let binding: ExecutorTokenBinding | null;
      try {
        binding = await bindings.get(claims.jti);
      } catch {
        return { active: false };
      }
      if (
        binding === null ||
        !bindingMatchesIdentity(binding, claims, claims.jti, claims.iat, claims.exp)
      ) {
        return { active: false };
      }
      try {
        return { active: await authority[roleOf(claims)](claims, binding) };
      } catch {
        return { active: false };
      }
    },
  };
};

const validTime = (claims: ExecutorAuthorizationClaims, now: number) =>
  Number.isSafeInteger(claims.iat) &&
  Number.isSafeInteger(claims.exp) &&
  Number.isSafeInteger(now) &&
  claims.exp > now &&
  claims.exp > claims.iat &&
  claims.exp - claims.iat <= EXECUTOR_TOKEN_TTL_SECONDS &&
  claims.iat <= now + FUTURE_IAT_TOLERANCE_SECONDS;

export { roleOf };
export type { ExecutorAuthorizationClaims, ExecutorTokenIdentity, ExecutorTokenRole };
