import * as Schema from "effect/Schema";

const builtins = new Set([
  "openai",
  "ollama",
  "lmstudio",
  "amazon-bedrock",
  "amazon-bedrock-runtime",
]);
const decodeTable = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));

/** The gateway exposes Responses over HTTP for every pool's backing provider. */
export function gatewayConfig(overrides: Readonly<Record<string, unknown>>, origin: string) {
  const requested =
    typeof overrides.model_provider === "string" ? overrides.model_provider : "openai";
  // 0.162.1 rejects overriding built-in openai; removed WebSocket feature flags have no effect.
  const provider = builtins.has(requested) ? "signalbox-gateway" : requested;
  const tables =
    overrides.model_providers === undefined ? {} : decodeTable(overrides.model_providers);
  const flatKey = `model_providers.${requested}`;
  const previous = tables[requested] ?? overrides[flatKey];
  const table = previous === undefined ? {} : decodeTable(previous);
  const { [requested]: _selected, ...others } = tables;
  const { [flatKey]: _flat, ...rest } = overrides;
  return {
    ...rest,
    model_provider: provider,
    model_providers: {
      ...others,
      [provider]: {
        name: "Signalbox",
        base_url: new URL("/v1", origin).href,
        wire_api: "responses",
        requires_openai_auth: false,
        ...table,
        supports_websockets: false,
      },
    },
  };
}
