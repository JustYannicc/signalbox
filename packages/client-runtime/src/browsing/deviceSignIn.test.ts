import { describe, expect, it } from "@effect/vitest";
import * as Redacted from "effect/Redacted";

import {
  afterSignIn,
  initialSignInRunner,
  type LoginForm,
  nextSignIn,
  parseLoginForm,
  signInStep,
  signsIn,
} from "./deviceSignIn.ts";

const form = (kinds: LoginForm["kinds"], path = "/login"): LoginForm => ({
  origin: "https://example.com",
  path,
  kinds,
});

describe("nextSignIn", () => {
  it("fills each step of a two-step login once, on one account", () => {
    let runner = initialSignInRunner;
    const first = nextSignIn(runner, form(["username"]), 0);
    expect(first._tag).toBe("fill");
    runner = afterSignIn(
      first.runner,
      "https://example.com",
      { _tag: "filled", item: "work", title: "Work", username: "me@example.com" },
      0,
    );
    expect(runner.item).toEqual({ origin: "https://example.com", id: "work" });
    // Still on the username step while the page moves on: nothing new to fill.
    const second = nextSignIn(runner, form(["password"]), 2_000);
    expect(second._tag).toBe("fill");
    runner = afterSignIn(
      second.runner,
      "https://example.com",
      { _tag: "filled", item: "work", title: "Work", password: Redacted.make("pw") },
      2_000,
    );
    const code = nextSignIn(runner, form(["totp"], "/login/verify"), 4_000);
    expect(code._tag).toBe("fill");
  });

  it("goes quiet when a site asks for the same step again: the login was turned down", () => {
    const filled = nextSignIn(initialSignInRunner, form(["username", "password"]), 0);
    const again = nextSignIn(filled.runner, form(["username", "password"]), 5_000);
    expect(again._tag).toBe("wait");
    expect(nextSignIn(again.runner, form(["username", "password"]), 9 * 60_000)._tag).toBe("wait");
    // Long after, a fresh look tries again.
    expect(nextSignIn(again.runner, form(["username", "password"]), 11 * 60_000)._tag).toBe("fill");
  });

  it("stops after a sign-in takes more steps than any login does", () => {
    let runner = initialSignInRunner;
    for (const [index, path] of ["/a", "/b", "/c", "/d"].entries()) {
      const next = nextSignIn(runner, form(["password"], path), index * 1_000);
      expect(next._tag).toBe("fill");
      runner = next.runner;
    }
    expect(nextSignIn(runner, form(["password"], "/e"), 5_000)._tag).toBe("wait");
  });

  it("asks nothing for a while once there's nothing to fill, and soon after 1Password was unreachable", () => {
    const step = nextSignIn(initialSignInRunner, form(["password"]), 0).runner;
    for (const answer of [
      { _tag: "ask", site: "example.com" },
      { _tag: "not-owner" },
      { _tag: "no-login", reason: "no-match" },
    ] as const) {
      const quiet = afterSignIn(step, "https://example.com", answer, 0);
      expect(nextSignIn(quiet, form(["password"], "/other"), 5 * 60_000)._tag).toBe("wait");
    }
    const unreachable = afterSignIn(
      step,
      "https://example.com",
      { _tag: "unavailable", message: "down" },
      0,
    );
    expect(nextSignIn(unreachable, form(["password"], "/other"), 30_000)._tag).toBe("wait");
    expect(nextSignIn(unreachable, form(["password"], "/other"), 61_000)._tag).toBe("fill");
  });
});

describe("parseLoginForm", () => {
  it("accepts what the page reports and drops anything else", () => {
    expect(
      parseLoginForm(
        JSON.stringify({
          origin: "https://example.com",
          path: "/",
          kinds: ["username", "password"],
        }),
      ),
    ).toEqual({ origin: "https://example.com", path: "/", kinds: ["username", "password"] });
    expect(parseLoginForm(null)).toBeNull();
    expect(parseLoginForm("{")).toBeNull();
    expect(parseLoginForm({ origin: "https://example.com", path: "/", kinds: [] })).toBeNull();
    expect(
      parseLoginForm({ origin: "https://example.com", path: "/", kinds: ["password", "card"] }),
    ).toBeNull();
  });
});

describe("signsIn", () => {
  it("signs in only on real https sites", () => {
    expect(signsIn("https://example.com/login")).toBe(true);
    expect(signsIn("http://example.com/login")).toBe(false);
    expect(signsIn("https://app.localhost:5173")).toBe(false);
    expect(signsIn("https://127.0.0.1:8443")).toBe(false);
    expect(signsIn("about:blank")).toBe(false);
    expect(signsIn(null)).toBe(false);
  });
});

describe("signInStep", () => {
  const engineAt = (url: { current: string | null }, reports: unknown) => {
    const scripts: Array<string> = [];
    return {
      scripts,
      engine: {
        url: () => url.current,
        evaluate: async (script: string) => {
          scripts.push(script);
          return scripts.length === 1 ? reports : "filled";
        },
      },
    };
  };
  const passwordForm = JSON.stringify({
    origin: "https://example.com",
    path: "/login",
    kinds: ["password"],
  });
  const filledAnswer = {
    _tag: "filled",
    item: "main",
    title: "Main",
    password: Redacted.make("pw-canary"),
  } as const;

  it("fills the step the page shows with what the cloud answered", async () => {
    const { engine, scripts } = engineAt({ current: "https://example.com/login" }, passwordForm);
    const asked: Array<unknown> = [];
    const runner = await signInStep({
      engine,
      runner: initialSignInRunner,
      now: () => 0,
      ask: async (form, item) => {
        asked.push({ kinds: form.kinds, item });
        return filledAnswer;
      },
    });
    expect(asked).toEqual([{ kinds: ["password"], item: null }]);
    expect(scripts).toHaveLength(2);
    expect(scripts[1]).toContain("pw-canary");
    expect(runner.item).toEqual({ origin: "https://example.com", id: "main" });
  });

  it("slows down on a page without a login form until it navigates", async () => {
    const url = { current: "https://example.com/feed" as string | null };
    const { engine, scripts } = engineAt(url, null);
    let runner = initialSignInRunner;
    const look = async (at: number) => {
      runner = await signInStep({ engine, runner, now: () => at, ask: async () => null });
    };
    await look(0);
    await look(2_500);
    await look(5_000);
    expect(scripts).toHaveLength(2);
    url.current = "https://example.com/login";
    await look(5_100);
    expect(scripts).toHaveLength(3);
  });

  it("doesn't look at the page at all while the tab is quiet", async () => {
    const { engine, scripts } = engineAt({ current: "https://example.com/login" }, passwordForm);
    const quiet = { ...initialSignInRunner, quietUntil: 10_000 };
    await signInStep({ engine, runner: quiet, now: () => 0, ask: async () => null });
    expect(scripts).toHaveLength(0);
  });

  it("carries a login on only within its own site", async () => {
    const { engine } = engineAt({ current: "https://example.com/login" }, passwordForm);
    const asked: Array<string | null> = [];
    const elsewhere = { ...initialSignInRunner, item: { origin: "https://other.test", id: "x" } };
    await signInStep({
      engine,
      runner: elsewhere,
      now: () => 0,
      ask: async (_form, item) => {
        asked.push(item);
        return null;
      },
    });
    expect(asked).toEqual([null]);
  });

  it("asks nothing for a form claiming another origin than the engine's", async () => {
    const { engine, scripts } = engineAt({ current: "https://evil.test/login" }, passwordForm);
    const ask = async () => filledAnswer;
    await signInStep({ engine, runner: initialSignInRunner, now: () => 0, ask });
    expect(scripts).toHaveLength(1);
  });

  it("fills nothing when the page left the site while the cloud answered", async () => {
    const url = { current: "https://example.com/login" as string | null };
    const { engine, scripts } = engineAt(url, passwordForm);
    await signInStep({
      engine,
      runner: initialSignInRunner,
      now: () => 0,
      ask: async () => {
        url.current = "https://elsewhere.test/";
        return filledAnswer;
      },
    });
    expect(scripts).toHaveLength(1);
  });

  it("never looks at pages that aren't real sites", async () => {
    const { engine, scripts } = engineAt({ current: "http://localhost:5173/" }, passwordForm);
    await signInStep({ engine, runner: initialSignInRunner, now: () => 0, ask: async () => null });
    expect(scripts).toHaveLength(0);
  });
});
