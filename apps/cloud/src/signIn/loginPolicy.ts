import type { AuthChoice, AuthConnection, AuthField } from "../browser/KernelAuth.ts";
import type { LoginKind } from "./ExecutorLogins.ts";

/**
 * The login service's decisions during one Kernel login (#576), apart from
 * Kernel, Executor and storage so each is testable alone. Every decision is
 * deterministic: the same pause gets the same answer. Anything the policy
 * won't answer stops the login with a reason for the person, never a guess.
 */

/** The 1Password field that answers a Kernel field, or null when 1Password can't. */
export const kindOfField = (field: AuthField): LoginKind | null => {
  switch (field.type) {
    case "identifier":
      return "username";
    case "password":
      return "password";
    case "totp_code":
      return "totp";
    // `code` is an email or SMS code (#577); a `totp_secret` never leaves 1Password.
    default:
      return null;
  }
};

/** MFA routes agents take, best first. */
const ROUTES = ["password", "totp", "email", "sms"];

const mentions = (choice: AuthChoice, username: string) =>
  [choice.label, choice.description, choice.display_text].some((text) =>
    text?.toLowerCase().includes(username.toLowerCase()),
  );

/**
 * The route a login takes: a password, then an authenticator code, then an
 * email code, then an SMS code, the first Kernel lists of a kind; else the one
 * account row naming the login's username. SSO is never picked: a 1Password
 * login doesn't say which provider its account uses.
 */
export const chooseRoute = (
  choices: ReadonlyArray<AuthChoice>,
  login: { readonly username: string | null },
):
  | { readonly _tag: "choose"; readonly choiceId: string }
  | { readonly _tag: "none"; readonly offered: ReadonlyArray<string> } => {
  for (const route of ROUTES) {
    const found = choices.find((choice) => choice.mfa_type === route);
    if (found !== undefined) return { _tag: "choose", choiceId: found.id };
  }
  const { username } = login;
  const accounts =
    username === null
      ? []
      : choices.filter((choice) => choice.type === "account" && mentions(choice, username));
  const [account] = accounts;
  return accounts.length === 1 && account !== undefined
    ? { _tag: "choose", choiceId: account.id }
    : { _tag: "none", offered: choices.map((choice) => choice.label) };
};

/** What one login has sent so far. */
export interface Flow {
  /** Pauses already answered: Kernel keeps showing one while it submits it. */
  readonly answered: ReadonlySet<string>;
  readonly sent: ReadonlySet<LoginKind>;
  readonly codesSent: number;
}

export const emptyFlow: Flow = { answered: new Set(), sent: new Set(), codesSent: 0 };

export const withAnswered = (
  flow: Flow,
  interactionId: string,
  kinds: ReadonlyArray<LoginKind>,
): Flow => ({
  answered: new Set([...flow.answered, interactionId]),
  sent: new Set([...flow.sent, ...kinds]),
  codesSent: flow.codesSent + (kinds.includes("totp") ? 1 : 0),
});

/** A field of a pause, and the 1Password field that answers it. */
export interface PlannedField {
  readonly id: string;
  readonly kind: LoginKind;
}

/** The 1Password fields a pause needs, each once, in the order the page asks. */
export const kindsOf = (
  fields: readonly [PlannedField, ...Array<PlannedField>],
): readonly [LoginKind, ...Array<LoginKind>] => {
  const [first, ...rest] = fields;
  const others = new Set(rest.map((field) => field.kind).filter((kind) => kind !== first.kind));
  return [first.kind, ...others];
};

export type NextStep =
  | { readonly _tag: "wait" }
  | { readonly _tag: "signed-in" }
  | {
      readonly _tag: "fill";
      readonly interactionId: string;
      readonly fields: readonly [PlannedField, ...Array<PlannedField>];
    }
  | { readonly _tag: "choose"; readonly interactionId: string; readonly choiceId: string }
  /** The login can't go on without the person; `reason` says why, in words. */
  | { readonly _tag: "stop"; readonly reason: string };

const KIND_NAMES: Readonly<Record<LoginKind, string>> = {
  username: "username",
  password: "password",
  totp: "authenticator code",
};

/** Kernel's own words for a failed flow, with the site's when it showed one. */
const failureOf = (connection: AuthConnection) => {
  if (connection.flow_status === "EXPIRED") return "the login timed out (EXPIRED)";
  if (connection.flow_status === "CANCELED") return "the login was canceled (CANCELED)";
  const said = connection.website_error ? ` The site said: “${connection.website_error}”` : "";
  const code = connection.error_code ? ` (${connection.error_code})` : "";
  const message = connection.error_message?.trim() || "the login failed";
  return `${message}${said}${code}`;
};

const fill = (interactionId: string, fields: ReadonlyArray<AuthField>, flow: Flow): NextStep => {
  const planned: Array<PlannedField> = [];
  for (const field of fields) {
    const kind = kindOfField(field);
    if (kind === null) {
      return {
        _tag: "stop",
        reason: `the site asks for “${field.label ?? field.type}”, which 1Password can't answer yet`,
      };
    }
    if (field.reason === "rejected" && flow.sent.has(kind)) {
      // A code can go stale between reading and submitting; a second one may pass.
      if (kind !== "totp") {
        return {
          _tag: "stop",
          reason: `the site rejected the ${KIND_NAMES[kind]} saved in 1Password`,
        };
      }
      if (flow.codesSent >= 2) {
        return { _tag: "stop", reason: "the site rejected two authenticator codes from 1Password" };
      }
    }
    planned.push({ id: field.id, kind });
  }
  const [first, ...rest] = planned;
  return first === undefined
    ? { _tag: "wait" }
    : { _tag: "fill", interactionId, fields: [first, ...rest] };
};

/** What to do about the connection's state now. */
export const nextStep = (
  connection: AuthConnection,
  flow: Flow,
  login: { readonly username: string | null },
): NextStep => {
  switch (connection.flow_status) {
    case "SUCCESS":
      return { _tag: "signed-in" };
    case "FAILED":
    case "EXPIRED":
    case "CANCELED":
      return { _tag: "stop", reason: failureOf(connection) };
  }
  if (connection.flow_step === "AWAITING_EXTERNAL_ACTION") {
    return {
      _tag: "stop",
      reason: `the site needs an action outside the browser: ${connection.external_action_message ?? "no details"}`,
    };
  }
  const interactionId = connection.interaction_id;
  if (connection.flow_step !== "AWAITING_INPUT" || !interactionId) return { _tag: "wait" };
  if (flow.answered.has(interactionId)) return { _tag: "wait" };
  const fields = connection.fields ?? [];
  if (fields.length > 0) return fill(interactionId, fields, flow);
  const choices = connection.choices ?? [];
  if (choices.length === 0) return { _tag: "wait" };
  const route = chooseRoute(choices, login);
  return route._tag === "choose"
    ? { _tag: "choose", interactionId, choiceId: route.choiceId }
    : {
        _tag: "stop",
        reason: `the site offers only routes agents don't take: ${route.offered.join(", ")}`,
      };
};
