import { expect, it } from "vite-plus/test";
import { gatewayConfig } from "./gatewayConfig.ts";

it.each([
  {},
  { model_provider: "openai" },
  { model_provider: "openai", "model_providers.openai.requires_openai_auth": false },
])("keeps built-in auth semantics when replacing %j", (overrides) => {
  const result = gatewayConfig(overrides, "http://model.fixture");
  expect(result.model_providers["signalbox-gateway"]).toMatchObject({
    requires_openai_auth: true,
    supports_websockets: false,
  });
});

it("normalizes all flat descendants while preserving literal IDs and forcing HTTP last", () => {
  const original = {
    model_provider: "fixture.dot",
    model_providers: {
      "fixture.dot": { name: "Dotted", http_headers: { retained: "yes" } },
      other: { name: "Other" },
    },
    "model_providers.fixture.dot.supports_websockets": true,
    "model_providers.fixture.dot.http_headers.added": "value",
    "model_providers.other.supports_websockets": true,
    "model_providers.third": { name: "Third", supports_websockets: true },
    "model_providers.third.request_max_retries": 2,
  };
  const before = structuredClone(original);
  const result = gatewayConfig(original, "http://model.fixture");
  expect(result.model_providers).toMatchObject({
    "fixture.dot": {
      name: "Dotted",
      supports_websockets: false,
      http_headers: { retained: "yes", added: "value" },
    },
    other: { name: "Other", supports_websockets: false },
    third: { name: "Third", request_max_retries: 2, supports_websockets: false },
  });
  expect(Object.keys(result).some((key) => key.startsWith("model_providers."))).toBe(false);
  expect(original).toEqual(before);
});
