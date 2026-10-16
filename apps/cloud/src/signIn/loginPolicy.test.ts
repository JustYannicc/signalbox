import { describe, expect, it } from "@effect/vitest";

import type { AuthChoice, AuthConnection, AuthField } from "../browser/KernelAuth.ts";
import { chooseRoute, emptyFlow, kindOfField, nextStep, withAnswered } from "./loginPolicy.ts";

const connection = (state: Partial<AuthConnection>): AuthConnection => ({
  id: "conn_1",
  domain: "example.com",
  status: "NEEDS_AUTH",
  save_credentials: false,
  ...state,
});
const field = (type: string, reason: string = "missing", id = `f-${type}`): AuthField => ({
  id,
  type,
  reason,
  label: type,
});
const choice = (id: string, extra: Partial<AuthChoice>): AuthChoice => ({
  id,
  type: "mfa_method",
  label: id,
  ...extra,
});
const awaiting = (interaction: string, state: Partial<AuthConnection>) =>
  connection({
    flow_status: "IN_PROGRESS",
    flow_step: "AWAITING_INPUT",
    interaction_id: interaction,
    ...state,
  });
const login = { username: "me@example.com" };

describe("which 1Password field answers which of Kernel's", () => {
  it("answers identifiers, passwords and authenticator codes, and nothing else", () => {
    expect(kindOfField(field("identifier"))).toBe("username");
    expect(kindOfField(field("password"))).toBe("password");
    expect(kindOfField(field("totp_code"))).toBe("totp");
    // Email and SMS codes come later (#577); a TOTP secret never leaves 1Password.
    expect(kindOfField(field("code"))).toBeNull();
    expect(kindOfField(field("totp_secret"))).toBeNull();
    expect(kindOfField(field("text"))).toBeNull();
  });
});

describe("the choice policy", () => {
  it("prefers a password, then an authenticator code, then email, then SMS", () => {
    const sms = choice("sms", { mfa_type: "sms" });
    const email = choice("email", { mfa_type: "email" });
    const totp = choice("totp", { mfa_type: "totp" });
    const password = choice("password", { mfa_type: "password", type: "sign_in_method" });
    expect(chooseRoute([sms, email, totp, password], login)).toEqual({
      _tag: "choose",
      choiceId: "password",
    });
    expect(chooseRoute([sms, email, totp], login)).toEqual({ _tag: "choose", choiceId: "totp" });
    expect(chooseRoute([sms, email], login)).toEqual({ _tag: "choose", choiceId: "email" });
    // Two of a kind: the first Kernel lists, every time.
    expect(chooseRoute([sms, choice("sms-2", { mfa_type: "sms" })], login)).toEqual({
      _tag: "choose",
      choiceId: "sms",
    });
  });

  it("never picks SSO, a push or a passkey, and names what it was offered", () => {
    expect(
      chooseRoute(
        [
          choice("google", { type: "sso_provider", label: "Continue with Google" }),
          choice("push", { mfa_type: "push", label: "Approve on your phone" }),
        ],
        login,
      ),
    ).toEqual({ _tag: "none", offered: ["Continue with Google", "Approve on your phone"] });
  });

  it("picks the account whose row names the login's username, and only one", () => {
    const mine = choice("acct-1", { type: "account", label: "Me", description: "ME@example.com" });
    const other = choice("acct-2", { type: "account", label: "Work", description: "w@corp.test" });
    expect(chooseRoute([other, mine], login)).toEqual({ _tag: "choose", choiceId: "acct-1" });
    expect(chooseRoute([other], login)._tag).toBe("none");
    expect(chooseRoute([mine, other], { username: null })._tag).toBe("none");
  });
});

describe("the next step of a login", () => {
  it("fills every field of a pause with the 1Password kind it needs", () => {
    const step = nextStep(
      awaiting("i-1", { fields: [field("identifier"), field("password")] }),
      emptyFlow,
      login,
    );
    expect(step).toEqual({
      _tag: "fill",
      interactionId: "i-1",
      fields: [
        { id: "f-identifier", kind: "username" },
        { id: "f-password", kind: "password" },
      ],
    });
  });

  it("waits on a pause it answered: Kernel still shows it while it submits", () => {
    const flow = withAnswered(emptyFlow, "i-1", ["password"]);
    const state = awaiting("i-1", { fields: [field("password")] });
    expect(nextStep(state, flow, login)).toEqual({ _tag: "wait" });
    // A new pause, the password page after the username page, is answered.
    expect(nextStep(awaiting("i-2", { fields: [field("password")] }), flow, login)._tag).toBe(
      "fill",
    );
  });

  it("stops when the site rejects a value from 1Password, and retries a code once", () => {
    const sent = withAnswered(emptyFlow, "i-1", ["username", "password"]);
    expect(
      nextStep(awaiting("i-2", { fields: [field("password", "rejected")] }), sent, login),
    ).toEqual({
      _tag: "stop",
      reason: "the site rejected the password saved in 1Password",
    });

    const coded = withAnswered(emptyFlow, "i-1", ["totp"]);
    const again = nextStep(
      awaiting("i-2", { fields: [field("totp_code", "rejected")] }),
      coded,
      login,
    );
    expect(again._tag).toBe("fill");
    const twice = withAnswered(coded, "i-2", ["totp"]);
    expect(
      nextStep(awaiting("i-3", { fields: [field("totp_code", "rejected")] }), twice, login),
    ).toEqual({ _tag: "stop", reason: "the site rejected two authenticator codes from 1Password" });
  });

  it("stops on a field 1Password can't answer, naming it", () => {
    expect(
      nextStep(
        awaiting("i-1", { fields: [{ ...field("code"), label: "Code we emailed you" }] }),
        emptyFlow,
        login,
      ),
    ).toEqual({
      _tag: "stop",
      reason: "the site asks for “Code we emailed you”, which 1Password can't answer yet",
    });
  });

  it("chooses a route by the policy, or stops when none fits", () => {
    expect(
      nextStep(
        awaiting("i-1", { choices: [choice("totp", { mfa_type: "totp" })] }),
        emptyFlow,
        login,
      ),
    ).toEqual({ _tag: "choose", interactionId: "i-1", choiceId: "totp" });
    expect(
      nextStep(
        awaiting("i-1", { choices: [choice("push", { mfa_type: "push", label: "Push" })] }),
        emptyFlow,
        login,
      ),
    ).toEqual({ _tag: "stop", reason: "the site offers only routes agents don't take: Push" });
  });

  it("stops when Kernel took the login to an SSO provider, before typing anything there", () => {
    expect(
      nextStep(
        awaiting("i-1", { sso_provider: "google", fields: [field("identifier")] }),
        emptyFlow,
        login,
      ),
    ).toEqual({
      _tag: "stop",
      reason: "the site went to google sign-in, which agents never use",
    });
  });

  it("ends on success, and stops on Kernel's failure or an action outside the browser", () => {
    expect(nextStep(connection({ flow_status: "SUCCESS" }), emptyFlow, login)).toEqual({
      _tag: "signed-in",
    });
    expect(
      nextStep(
        connection({
          flow_status: "FAILED",
          error_code: "credentials_invalid",
          error_message: "The site rejected the credentials.",
          website_error: "Wrong password",
        }),
        emptyFlow,
        login,
      ),
    ).toEqual({
      _tag: "stop",
      reason:
        "The site rejected the credentials. The site said: “Wrong password” (credentials_invalid)",
    });
    expect(nextStep(connection({ flow_status: "EXPIRED" }), emptyFlow, login)).toEqual({
      _tag: "stop",
      reason: "the login timed out (EXPIRED)",
    });
    expect(
      nextStep(
        connection({
          flow_status: "IN_PROGRESS",
          flow_step: "AWAITING_EXTERNAL_ACTION",
          external_action_message: "Approve the sign-in in the app",
        }),
        emptyFlow,
        login,
      ),
    ).toEqual({
      _tag: "stop",
      reason: "the site needs an action outside the browser: Approve the sign-in in the app",
    });
    expect(
      nextStep(
        connection({ flow_status: "IN_PROGRESS", flow_step: "DISCOVERING" }),
        emptyFlow,
        login,
      ),
    ).toEqual({ _tag: "wait" });
  });
});
