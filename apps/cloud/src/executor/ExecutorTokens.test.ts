import { exportJWK, generateKeyPair, SignJWT, jwtVerify } from "jose";
import { describe, expect, it } from "@effect/vitest";
import { FolderId } from "@t3tools/contracts/signalboxFolders";
import * as DateTime from "effect/DateTime";

import {
  decodeExecutorAuthorizationClaims,
  type ExecutorAuthorizationClaims,
} from "./ExecutorTokenClaims.ts";
import {
  EXECUTOR_TOKEN_TTL_SECONDS,
  makeExecutorTokenService,
  type ExecutorTokenAuthority,
} from "./ExecutorTokens.ts";
import type {
  ExecutorTokenBinding,
  ExecutorTokenBindingInput,
  ExecutorTokenBindingStore,
} from "./ExecutorTokenBindings.ts";

const ISSUER = "https://signalbox.example.test";
const NOW = 2_000_000_000;
const currentDate = DateTime.toDateUtc(DateTime.fromEpochSeconds(NOW));
const identity = {
  owner: "org_acme",
  level: "folder_1",
  thread: "thread_1",
  turn: "run_live",
};

const binding = (changes: Partial<ExecutorTokenBindingInput> = {}): ExecutorTokenBindingInput => ({
  ownerUserId: "user_mia",
  requester: "user_mia",
  source: { _tag: "folder", folderId: FolderId.make("folder_1") },
  origin: "https://example.test/",
  grantId: "grant_1",
  purpose: "turn",
  ...changes,
});

const memoryBindings = (): ExecutorTokenBindingStore => {
  const records = new Map<string, ExecutorTokenBinding>();
  return {
    bind: async (value) => {
      if (records.has(value.jti)) return false;
      records.set(value.jti, value);
      return true;
    },
    get: async (jti) => records.get(jti) ?? null,
    remove: async (jti) => {
      records.delete(jti);
    },
  };
};

const runtimeAt = (now: number) => {
  let nextJti = 0;
  return {
    nowSeconds: () => now,
    newJti: () => `test-jti-${++nextJti}`,
  };
};

const serviceFor = async (
  privateKey: CryptoKey,
  bindings: ExecutorTokenBindingStore = memoryBindings(),
) => {
  const privateJwk = await exportJWK(privateKey);
  const service = makeExecutorTokenService(
    {
      EXECUTOR_TOKEN_ISSUER: ISSUER,
      EXECUTOR_TOKEN_PRIVATE_JWK: JSON.stringify(privateJwk),
    },
    bindings,
    runtimeAt(NOW),
  );
  return { service, now: NOW };
};

const fixture = async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const { service, now } = await serviceFor(pair.privateKey);
  return { pair, service, now };
};

const claimsFrom = async (
  token: string,
  publicKey: CryptoKey,
): Promise<ExecutorAuthorizationClaims> => {
  const verified = await jwtVerify(token, publicKey, {
    issuer: ISSUER,
    audience: "executor",
    currentDate,
  });
  const claims = decodeExecutorAuthorizationClaims(verified.payload);
  if (claims === null) throw new Error("The issued token did not contain authorization claims.");
  return claims;
};

describe("Executor token issuer and live authorization", () => {
  it("rejects identifiers the Executor verifier will refuse", async () => {
    const { service } = await fixture();

    await expect(service.issue({ ...identity, owner: "org acme" }, binding())).rejects.toThrow(
      "Invalid Executor token identity.",
    );
  });

  it("issues short-lived ES256 tokens and publishes only the public key", async () => {
    const { pair, service, now } = await fixture();
    const token = await service.issue({ ...identity, person: "user_mia" }, binding());
    const verified = await jwtVerify(token, pair.publicKey, {
      issuer: ISSUER,
      audience: "executor",
      currentDate,
    });

    expect(verified.protectedHeader.alg).toBe("ES256");
    expect(verified.protectedHeader.kid).toEqual(expect.any(String));
    expect(verified.payload).toMatchObject({
      iss: ISSUER,
      aud: "executor",
      ...identity,
      person: "user_mia",
      iat: now,
      exp: now + EXECUTOR_TOKEN_TTL_SECONDS,
    });

    const jwks = await service.jwks();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({
      kty: "EC",
      crv: "P-256",
      alg: "ES256",
      use: "sig",
      key_ops: ["verify"],
    });
    expect(jwks.keys[0]).not.toHaveProperty("d");
    expect(Object.keys(jwks.keys[0] ?? {}).sort()).toEqual([
      "alg",
      "crv",
      "key_ops",
      "kid",
      "kty",
      "use",
      "x",
      "y",
    ]);
    expect(jwks.keys[0]?.kid).toBe(verified.protectedHeader.kid);
  });

  it("generates a cached ephemeral key for local workerd without deployment secrets", async () => {
    const service = makeExecutorTokenService(
      { EXECUTOR_TOKEN_ISSUER: ISSUER, LOCAL_WORKERD: "1" },
      memoryBindings(),
      runtimeAt(NOW),
    );
    const first = await service.jwks();
    const second = await service.jwks();

    expect(first).toEqual(second);
    expect(first.keys[0]).not.toHaveProperty("d");
  });

  it("rejects a wrong audience, wrong signing key, and expired token", async () => {
    const { pair, service } = await fixture();
    const token = await service.issue(identity, binding());
    const wrongKey = await generateKeyPair("ES256");
    const expiredToken = await new SignJWT(identity)
      .setProtectedHeader({ alg: "ES256" })
      .setIssuer(ISSUER)
      .setAudience("executor")
      .setIssuedAt(1)
      .setExpirationTime(2)
      .setJti("expired-test-jti")
      .sign(pair.privateKey);

    await expect(
      jwtVerify(token, pair.publicKey, {
        issuer: ISSUER,
        audience: "another-service",
        currentDate,
      }),
    ).rejects.toThrow();
    await expect(
      jwtVerify(token, wrongKey.publicKey, { issuer: ISSUER, audience: "executor" }),
    ).rejects.toThrow();
    await expect(
      jwtVerify(expiredToken, pair.publicKey, {
        issuer: ISSUER,
        audience: "executor",
        currentDate,
      }),
    ).rejects.toThrow();
  });

  it("denies stopped turns and a level outside the current folder on every request", async () => {
    const { pair, service } = await fixture();
    const token = await service.issue(identity, binding());
    const claims = await claimsFrom(token, pair.publicKey);
    let activeTurn: string | null = "run_live";
    let currentFolder = "folder_1";
    let checks = 0;
    const authority: ExecutorTokenAuthority = {
      person: async () => false,
      turn: async (verified, record) => {
        checks++;
        return (
          activeTurn === verified.turn &&
          currentFolder === verified.level &&
          record.source._tag === "folder" &&
          record.source.folderId === currentFolder
        );
      },
      automation: async () => false,
    };

    expect(await service.authorize(claims, authority)).toEqual({ active: true });
    activeTurn = null;
    expect(await service.authorize(claims, authority)).toEqual({ active: false });
    activeTurn = "run_live";
    currentFolder = "folder_elsewhere";
    expect(await service.authorize(claims, authority)).toEqual({ active: false });
    expect(checks).toBe(3);
  });

  it("denies mutated identity, time and JTI before consulting current authority", async () => {
    const { pair, service } = await fixture();
    const token = await service.issue(identity, binding());
    const claims = await claimsFrom(token, pair.publicKey);
    let consulted = false;
    const authority: ExecutorTokenAuthority = {
      person: async () => false,
      turn: async () => {
        consulted = true;
        return true;
      },
      automation: async () => false,
    };

    expect(await service.authorize({ ...claims, level: "folder_elsewhere" }, authority)).toEqual({
      active: false,
    });
    expect(await service.authorize({ ...claims, exp: 999 }, authority)).toEqual({ active: false });
    expect(await service.authorize({ ...claims, iat: claims.iat + 1 }, authority)).toEqual({
      active: false,
    });
    expect(await service.authorize({ ...claims, exp: claims.exp - 1 }, authority)).toEqual({
      active: false,
    });
    expect(await service.authorize({ ...claims, jti: "unknown-jti" }, authority)).toEqual({
      active: false,
    });
    expect(consulted).toBe(false);
  });

  it("denies malformed claims without consulting current authority", async () => {
    const { service } = await fixture();
    let consulted = false;

    expect(
      await service.authorize(null, {
        person: async () => {
          consulted = true;
          return true;
        },
        turn: async () => {
          consulted = true;
          return true;
        },
        automation: async () => {
          consulted = true;
          return true;
        },
      }),
    ).toEqual({ active: false });
    expect(consulted).toBe(false);
  });

  it("denies when live authorization is unavailable", async () => {
    const { pair, service } = await fixture();
    const token = await service.issue(identity, binding());
    const claims = await claimsFrom(token, pair.publicKey);

    expect(
      await service.authorize(claims, {
        person: async () => false,
        turn: async () => {
          throw new Error("authority unavailable");
        },
        automation: async () => false,
      }),
    ).toEqual({ active: false });
  });

  it("keeps unattended person sweeps as person authority and rechecks their standing grant", async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    const bindings = memoryBindings();
    const { service } = await serviceFor(pair.privateKey, bindings);
    const token = await service.issue(
      { owner: "org_acme", level: "folder_1", person: "user_mia", automation: "sweep_1" },
      binding({ purpose: "background-person" }),
    );
    const claims = await claimsFrom(token, pair.publicKey);
    let grantActive = true;
    let personChecks = 0;
    let automationChecks = 0;
    const authority: ExecutorTokenAuthority = {
      person: async (current) => {
        personChecks++;
        return current.automation === "sweep_1" && grantActive;
      },
      turn: async () => false,
      automation: async () => {
        automationChecks++;
        return true;
      },
    };

    expect(await service.authorize(claims, authority)).toEqual({ active: true });
    grantActive = false;
    expect(await service.authorize(claims, authority)).toEqual({ active: false });
    expect(personChecks).toBe(2);
    expect(automationChecks).toBe(0);
  });

  it("checks automation runs independently of correlated thread liveness", async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    const { service } = await serviceFor(pair.privateKey);
    const token = await service.issue(
      {
        owner: "org_acme",
        level: "folder_1",
        thread: "thread_stopped",
        turn: "turn_stopped",
        automation: "automation_live",
      },
      binding({ purpose: "automation" }),
    );
    const claims = await claimsFrom(token, pair.publicKey);
    let automationActive = true;
    let turnChecks = 0;
    let automationChecks = 0;
    const authority: ExecutorTokenAuthority = {
      person: async () => false,
      turn: async () => {
        turnChecks++;
        return true;
      },
      automation: async (current) => {
        automationChecks++;
        return current.automation === "automation_live" && automationActive;
      },
    };

    expect(await service.authorize(claims, authority)).toEqual({ active: true });
    automationActive = false;
    expect(await service.authorize(claims, authority)).toEqual({ active: false });
    expect(turnChecks).toBe(0);
    expect(automationChecks).toBe(2);
  });

  it("denies authorization when the private JTI store is unavailable", async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    const { service } = await serviceFor(pair.privateKey, {
      bind: async () => true,
      get: async () => {
        throw new Error("private store unavailable");
      },
      remove: async () => undefined,
    });
    const token = await service.issue(identity, binding());
    const claims = await claimsFrom(token, pair.publicKey);
    let consulted = false;

    expect(
      await service.authorize(claims, {
        person: async () => false,
        turn: async () => {
          consulted = true;
          return true;
        },
        automation: async () => false,
      }),
    ).toEqual({ active: false });
    expect(consulted).toBe(false);
  });

  it("denies malformed claims and current-authority failures", async () => {
    const { pair, service } = await fixture();
    const token = await service.issue(identity, binding());
    const claims = await claimsFrom(token, pair.publicKey);
    let consulted = 0;

    const authority: ExecutorTokenAuthority = {
      person: async () => false,
      turn: async () => {
        consulted++;
        throw new Error("user object unavailable");
      },
      automation: async () => false,
    };

    expect(await service.authorize({ ...claims, iat: "not-a-time" }, authority)).toEqual({
      active: false,
    });
    expect(await service.authorize(claims, authority)).toEqual({ active: false });
    expect(consulted).toBe(1);
  });
});
