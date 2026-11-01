import { expect, it } from "vite-plus/test";
import { claudeHostOptionsFixture } from "./claudeHostOptions.fixture.ts";

it("the real Claude host builder injects gateway access and refuses either missing value before launch", async () => {
  const fixture = await claudeHostOptionsFixture();
  try {
    const options = await fixture.build();
    const environment = options.native.process.env;
    expect(environment.ANTHROPIC_BASE_URL).toBe(fixture.issued.baseUrl);
    expect(environment.ANTHROPIC_AUTH_TOKEN).toBe(fixture.issued.credentialRef);
    expect(environment.ANTHROPIC_API_KEY).toBe("");
    expect(environment.CLAUDE_CODE_OAUTH_TOKEN).toBe("");
    expect(fixture.accesses).toEqual([
      { incarnation: "real-builder-incarnation", variant: "baseline" },
    ]);
    await expect(
      fixture.gateway.gatewayAccess({ incarnation: "foreign", variant: "baseline" }),
    ).rejects.toThrow("prepared active run");
    await expect(
      fixture.gateway.gatewayAccess({ incarnation: "real-builder-incarnation", variant: "hooks" }),
    ).rejects.toThrow("prepared active run");
    await expect(
      fixture.gateway.request(
        new Request(`${fixture.issued.baseUrl}/v1/messages`, {
          method: "POST",
          headers: { authorization: "Bearer foreign-run" },
          body: "{}",
        }),
      ),
    ).rejects.toThrow("matching run-scoped gateway credential");
    await expect(fixture.build({ ...fixture.issued, baseUrl: "" })).rejects.toThrow("base URL");
    await expect(fixture.build({ ...fixture.issued, credentialRef: "" })).rejects.toThrow(
      "credential reference",
    );
  } finally {
    await fixture.dispose();
  }
});
