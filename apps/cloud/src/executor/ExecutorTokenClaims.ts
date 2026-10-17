import * as Schema from "effect/Schema";

export const ExecutorTokenIdentifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  // eslint-disable-next-line no-control-regex -- opaque IDs cannot contain ASCII controls.
  Schema.isPattern(/^[^\u0000-\u0020\u007f]+$/u),
);

const Identity = Schema.Struct({
  owner: ExecutorTokenIdentifier,
  level: ExecutorTokenIdentifier,
  person: Schema.optionalKey(ExecutorTokenIdentifier),
  thread: Schema.optionalKey(ExecutorTokenIdentifier),
  turn: Schema.optionalKey(ExecutorTokenIdentifier),
  automation: Schema.optionalKey(ExecutorTokenIdentifier),
});

export const AuthorizationClaims = Schema.Struct({
  ...Identity.fields,
  iat: Schema.Number,
  exp: Schema.Number,
  jti: ExecutorTokenIdentifier,
});

const decodeIdentity = Schema.decodeUnknownOption(Identity);
const decodeAuthorizationClaims = Schema.decodeUnknownOption(AuthorizationClaims);

export type ExecutorTokenIdentity = typeof Identity.Type;
export type ExecutorAuthorizationClaims = typeof AuthorizationClaims.Type;
export type ExecutorTokenRole = "person" | "turn" | "automation";

export const decodeExecutorTokenIdentity = (value: unknown): ExecutorTokenIdentity => {
  const parsed = decodeIdentity(value);
  if (parsed._tag === "None") throw new Error("Invalid Executor token identity.");
  roleOf(parsed.value);
  return parsed.value;
};

export const decodeExecutorAuthorizationClaims = (
  value: unknown,
): ExecutorAuthorizationClaims | null => {
  const parsed = decodeAuthorizationClaims(value);
  if (parsed._tag === "None") return null;
  try {
    roleOf(parsed.value);
    return parsed.value;
  } catch {
    return null;
  }
};

/** Caller attribution never changes the authority that the role receives. */
export const roleOf = (
  claims: Pick<ExecutorTokenIdentity, "person" | "thread" | "turn" | "automation">,
): ExecutorTokenRole => {
  const hasThread = claims.thread !== undefined;
  const hasTurn = claims.turn !== undefined;
  if (hasThread !== hasTurn) throw new Error("A thread and turn must be supplied together.");

  if (claims.person !== undefined) {
    if (hasThread && claims.automation !== undefined) {
      throw new Error("A turn token cannot also name an automation.");
    }
    return hasThread ? "turn" : "person";
  }

  if (claims.automation !== undefined) return "automation";
  if (hasThread) return "turn";
  throw new Error("Executor tokens need a person, turn, or automation authority.");
};

export const executorTokenPurpose = (identity: ExecutorTokenIdentity): ExecutorTokenPurpose => {
  const role = roleOf(identity);
  if (role === "turn") return "turn";
  if (role === "automation") return "automation";
  return identity.automation === undefined ? "interactive-person" : "background-person";
};

export const ExecutorTokenPurpose = Schema.Literals([
  "interactive-person",
  "background-person",
  "turn",
  "automation",
]);
export type ExecutorTokenPurpose = typeof ExecutorTokenPurpose.Type;
