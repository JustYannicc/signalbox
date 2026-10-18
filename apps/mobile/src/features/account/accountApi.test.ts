import { afterEach, describe, expect, it, vi } from "@effect/vitest";

import { parseGitHubConnectReturn, startGitHubConnect } from "./accountApi";

const RETURN_URL = "signalbox://account-return";

function answer(status: number, body: unknown) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("starting to connect GitHub", () => {
  it("asks with the session's bearer token and opens the link it gets back", async () => {
    const fetch = answer(200, { url: "https://cloud.example/api/github/connect/one-time" });
    await expect(startGitHubConnect("https://cloud.example/", "token-1", RETURN_URL)).resolves.toBe(
      "https://cloud.example/api/github/connect/one-time",
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://cloud.example/api/github/connect",
      expect.objectContaining({
        method: "POST",
        headers: { authorization: "Bearer token-1", "content-type": "application/json" },
        body: JSON.stringify({ returnUrl: RETURN_URL }),
      }),
    );
  });

  it("says why when the server refuses", async () => {
    answer(401, { error: "unauthorized" });
    await expect(startGitHubConnect("https://cloud.example", "t", RETURN_URL)).rejects.toThrow(
      "Couldn’t start connecting GitHub (401).",
    );
  });

  it("refuses an answer it can't open", async () => {
    answer(200, { link: "https://cloud.example" });
    await expect(startGitHubConnect("https://cloud.example", "t", RETURN_URL)).rejects.toThrow(
      "can’t open",
    );
    answer(200, { url: "javascript:alert(1)" });
    await expect(startGitHubConnect("https://cloud.example", "t", RETURN_URL)).rejects.toThrow(
      "can’t open",
    );
  });

  it("reports an unreachable server instead of throwing a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Network request failed");
      }),
    );
    await expect(startGitHubConnect("https://cloud.example", "t", RETURN_URL)).rejects.toThrow(
      "Couldn’t reach Signalbox",
    );
  });
});

describe("coming back from GitHub", () => {
  it("reads how connecting ended, and treats anything unknown as failed", () => {
    expect(parseGitHubConnectReturn(`${RETURN_URL}?github=connected`)).toBe("connected");
    expect(parseGitHubConnectReturn(`${RETURN_URL}?github=cancelled`)).toBe("cancelled");
    expect(parseGitHubConnectReturn(`${RETURN_URL}?github=failed`)).toBe("failed");
    expect(parseGitHubConnectReturn(`${RETURN_URL}?github=whatever`)).toBe("failed");
    expect(parseGitHubConnectReturn("not a url")).toBe("failed");
  });
});
