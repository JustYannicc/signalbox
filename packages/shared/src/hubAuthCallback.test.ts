// @effect-diagnostics globalFetch:off - Plays the browser landing on the loopback redirect.
import { describe, expect, it } from "vite-plus/test";

import { hubAuthorizationRequest, receiveHubAuthCallback } from "./hubAuthCallback.ts";

const CLIENTS: Record<string, string> = {
  "https://auth.openai.com/oauth/authorize": "app_EMoamEEZ73f0CkXaXp7hrann",
  "https://claude.ai/oauth/authorize": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  "https://accounts.google.com/o/oauth2/v2/auth":
    "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
};
const authorize = (base: string, redirectUri: string, state = "state-1234567890") =>
  `${base}?${new URLSearchParams({
    client_id: CLIENTS[base] ?? "someone-else",
    response_type: "code",
    redirect_uri: redirectUri,
    state,
  })}`;

describe("hub sign-in on this computer", () => {
  it("accepts exactly the hub's own logins", () => {
    expect(
      hubAuthorizationRequest(
        authorize("https://auth.openai.com/oauth/authorize", "http://localhost:1455/auth/callback"),
      )?.redirectUri,
    ).toBe("http://localhost:1455/auth/callback");
    expect(
      hubAuthorizationRequest(
        authorize("https://claude.ai/oauth/authorize", "http://localhost:54545/callback"),
      ),
    ).toBeDefined();
    expect(
      hubAuthorizationRequest(
        authorize(
          "https://accounts.google.com/o/oauth2/v2/auth",
          "http://localhost:51121/oauth-callback",
        ),
      ),
    ).toBeDefined();
    // Another redirect or another site is not one of them.
    expect(
      hubAuthorizationRequest(
        authorize("https://auth.openai.com/oauth/authorize", "http://localhost:9999/auth/callback"),
      ),
    ).toBeUndefined();
    expect(
      hubAuthorizationRequest(
        authorize(
          "https://evil.example.com/oauth/authorize",
          "http://localhost:1455/auth/callback",
        ),
      ),
    ).toBeUndefined();
  });

  it("lets a new sign-in take over the port from one left behind", async () => {
    const google = (state: string) =>
      authorize(
        "https://accounts.google.com/o/oauth2/v2/auth",
        "http://localhost:51121/oauth-callback",
        state,
      );
    const abandoned = receiveHubAuthCallback(google("abandoned-state"), async () => true);
    const retry = receiveHubAuthCallback(google("retry-state-1"), async () => {
      await fetch("http://127.0.0.1:51121/oauth-callback?code=ok&state=retry-state-1");
      return true;
    });
    await expect(abandoned).rejects.toThrow("cancelled");
    await expect(retry).resolves.toContain("state=retry-state-1");
  });

  it("catches the redirect and hands back the address the provider used", async () => {
    const url = authorize(
      "https://accounts.google.com/o/oauth2/v2/auth",
      "http://localhost:51121/oauth-callback",
    );
    const received = await receiveHubAuthCallback(url, async () => {
      // The browser lands on the redirect; a stray request with the wrong state is refused.
      const wrong = await fetch("http://127.0.0.1:51121/oauth-callback?code=x&state=nope");
      expect(wrong.status).toBe(400);
      await fetch("http://127.0.0.1:51121/oauth-callback?code=abc&state=state-1234567890");
      return true;
    });
    expect(received).toBe("http://localhost:51121/oauth-callback?code=abc&state=state-1234567890");
  });
});
