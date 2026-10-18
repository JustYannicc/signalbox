import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AuthorizationFence, SyncFailure, type HomeBinding } from "@signalbox/sync/definition";
import { catalogHomeKey } from "./catalogHome.ts";
import { CatalogPersonalRoot, CatalogPolicyActor, CatalogPolicyTarget } from "./catalogPolicy.ts";

type PersonalRoot = typeof CatalogPersonalRoot.Type;
type Actor = typeof CatalogPolicyActor.Type;
type Target = typeof CatalogPolicyTarget.Type;
type Request = {
  readonly home: PersonalRoot;
  readonly kind: "view" | "change" | "receipt";
  readonly operation: string;
  readonly input: unknown;
};
type Permit = {
  readonly scope: string;
  readonly localEpoch: number;
  readonly actorId: Actor["userId"];
  readonly target: Target;
};

const decodeHome = Schema.decodeUnknownSync(CatalogPersonalRoot);
const decodeActor = Schema.decodeUnknownSync(CatalogPolicyActor);
const decodeTarget = Schema.decodeUnknownSync(CatalogPolicyTarget);
const decodeFence = Schema.decodeUnknownSync(AuthorizationFence);

const denied = () => new SyncFailure({ reason: "denied" });
const invalidState = () => new SyncFailure({ reason: "invalid_state" });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const targetFromRequest = (request: Request): Target | null => {
  const input = request.input;
  const candidate =
    request.operation === "access"
      ? input
      : isRecord(input) && Object.hasOwn(input, "target")
        ? input.target
        : input;
  try {
    return decodeTarget(candidate);
  } catch {
    return null;
  }
};

const isEpoch = (epoch: number): boolean => Number.isSafeInteger(epoch) && epoch >= 0;

/**
 * Binds Catalog policy to one canonical personal root. The resolver closes over the current
 * Lunora invocation context, so policy reads share its transaction and never call WorkOS.
 */
export const makeCatalogHomeBinding = (options: {
  readonly home: PersonalRoot;
  readonly resolvePolicy: (
    actor: Actor,
    request: Request,
  ) => Effect.Effect<{ readonly epoch: number }, SyncFailure>;
  /** Checks the installed native fence, not the in-flight transaction's staged policy writes. */
  readonly isLocalEpochCurrent: (scope: string, localEpoch: number) => boolean;
  /** Installs a durable native fence after the sync receipt commits. */
  readonly installFence: (
    fence: typeof AuthorizationFence.Type,
  ) => Effect.Effect<void, SyncFailure>;
}) => {
  const home = decodeHome(options.home);
  const scope = catalogHomeKey(home);
  const trustedIngress = Object.freeze(Object.create(null)) as object;
  const issued = new WeakSet<object>();

  const binding: HomeBinding<Actor, PersonalRoot, object, Permit> = {
    home,
    authorization: {
      authorize: (actor, request) =>
        Effect.gen(function* () {
          let decodedActor: Actor;
          let requestScope: string;
          try {
            decodedActor = decodeActor(actor);
            requestScope = catalogHomeKey(decodeHome(request.home));
          } catch {
            return yield* Effect.fail(denied());
          }
          if (requestScope !== scope) return yield* Effect.fail(denied());

          const target = targetFromRequest(request);
          if (target === null) return yield* Effect.fail(denied());
          const policy = yield* options.resolvePolicy(decodedActor, request);
          if (!isEpoch(policy.epoch)) return yield* Effect.fail(invalidState());

          const permit = Object.freeze({
            scope,
            localEpoch: policy.epoch,
            actorId: decodedActor.userId,
            target,
          });
          issued.add(permit);
          return permit;
        }),
      isCurrent: (permit) => {
        try {
          return (
            typeof permit === "object" &&
            permit !== null &&
            issued.has(permit) &&
            permit.scope === scope &&
            isEpoch(permit.localEpoch) &&
            options.isLocalEpochCurrent(scope, permit.localEpoch)
          );
        } catch {
          return false;
        }
      },
    },
    authorizeIngress: (ingress) =>
      ingress === trustedIngress ? Effect.void : Effect.fail(denied()),
    completion: {
      install: (fence) => {
        let decoded: typeof AuthorizationFence.Type;
        try {
          decoded = decodeFence(fence);
        } catch {
          return Effect.fail(denied());
        }
        if (decoded.scope !== scope) return Effect.fail(denied());
        if (!isEpoch(decoded.epoch)) return Effect.fail(invalidState());
        return options.installFence(decoded);
      },
    },
  };

  return { binding, ingress: trustedIngress } as const;
};
