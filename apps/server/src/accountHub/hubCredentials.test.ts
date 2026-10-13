import { describe, expect, it } from "@effect/vitest";

import { chatGptCredentialFile } from "./hubCredentials.ts";

const profile = (overrides: { email?: string | null; earliestRefreshAt?: number | null } = {}) => ({
  registration: { clientId: "oaiapp_abc" },
  credentials: {
    clientId: "oaiapp_abc",
    accessToken: "access",
    refreshToken: "refresh",
    idToken: "id",
    issuer: "https://auth.openai.com",
    expiresAt: 1_760_000_000_500,
    earliestRefreshAt:
      "earliestRefreshAt" in overrides ? overrides.earliestRefreshAt! : 1_759_999_000_000,
    scopes: ["openid", "chatgpt.tokens.use.direct"],
    subject: "user-1",
    email: "email" in overrides ? overrides.email! : "Ada.Lovelace@Example.com",
  },
});

describe("chatGptCredentialFile", () => {
  it("writes the plugin's credential contract with unix-second times", () => {
    const file = chatGptCredentialFile(profile(), "urn:uuid:env");
    expect(file.name).toBe("chatgpt-siwc-ada.lovelace@example.com.json");
    expect(file.content).toEqual({
      type: "chatgpt-siwc",
      client_id: "oaiapp_abc",
      ext_agent_host_id: "urn:uuid:env",
      access_token: "access",
      refresh_token: "refresh",
      id_token: "id",
      expires_at: 1_760_000_000,
      earliest_refresh_at: 1_759_999_000,
      scopes: ["openid", "chatgpt.tokens.use.direct"],
      email: "Ada.Lovelace@Example.com",
    });
  });

  it("names the file by client id when ChatGPT shares no email", () => {
    const file = chatGptCredentialFile(
      profile({ email: null, earliestRefreshAt: null }),
      "urn:uuid:env",
    );
    expect(file.name).toBe("chatgpt-siwc-oaiapp-abc.json");
    expect(file.content).not.toHaveProperty("email");
    expect(file.content).not.toHaveProperty("earliest_refresh_at");
  });

  it("keeps hostile emails inside a plain file name", () => {
    const file = chatGptCredentialFile(profile({ email: "../../etc/passwd" }), "urn:uuid:env");
    expect(file.name).not.toContain("/");
    expect(file.name.startsWith("chatgpt-siwc-")).toBe(true);
  });
});
