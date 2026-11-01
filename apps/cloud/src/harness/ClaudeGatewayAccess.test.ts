import { expect, it } from "vite-plus/test";
import { claudeGatewayEnvironment, claudeGatewayTransport } from "./ClaudeGatewayAccess.ts";

it("requires both the gateway route and the issued credential reference", () => {
  expect(() => claudeGatewayEnvironment({ baseUrl: "", credentialRef: "scoped" })).toThrow(
    "base URL",
  );
  expect(() =>
    claudeGatewayEnvironment({ baseUrl: "https://gateway.test/anthropic", credentialRef: "" }),
  ).toThrow("credential reference");
  expect(() =>
    claudeGatewayEnvironment({
      baseUrl: "https://key@gateway.test/anthropic",
      credentialRef: "scoped",
    }),
  ).toThrow("invalid");
});

it("resolves each turn's gateway grant without changing the persistent CLI credential or request body", async () => {
  const access = { baseUrl: "https://gateway.test/anthropic", credentialRef: "first-turn" };
  let current = "first-turn";
  const forwarded: Request[] = [];
  const transport = claudeGatewayTransport(
    access,
    async () => ({ ...access, credentialRef: current }),
    async (request) => {
      forwarded.push(request);
      return new Response("ok");
    },
  );
  const request = () =>
    new Request(`${access.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": access.credentialRef },
      body: '{"model":"claude"}',
    });
  await transport(request());
  current = "second-turn";
  await transport(request());
  expect(forwarded.map((request) => request.headers.get("authorization"))).toEqual([
    "Bearer first-turn",
    "Bearer second-turn",
  ]);
  expect(forwarded.every((request) => !request.headers.has("x-api-key"))).toBe(true);
  expect(await forwarded[1]!.text()).toBe('{"model":"claude"}');
  current = "";
  await expect(transport(request())).rejects.toThrow("credential reference");
  expect(forwarded).toHaveLength(2);
});

it("refuses a foreign credential or destination before resolving or forwarding", async () => {
  const access = { baseUrl: "https://gateway.test/anthropic", credentialRef: "scoped" };
  const transport = claudeGatewayTransport(
    access,
    async () => {
      throw new Error("should not resolve");
    },
    async () => {
      throw new Error("should not forward");
    },
  );
  await expect(transport(new Request(`${access.baseUrl}/v1/messages`))).rejects.toThrow(
    "another Claude gateway grant",
  );
  await expect(
    transport(
      new Request("https://provider.test/v1/messages", {
        headers: { authorization: "Bearer scoped" },
      }),
    ),
  ).rejects.toThrow("another Claude gateway grant");
});
