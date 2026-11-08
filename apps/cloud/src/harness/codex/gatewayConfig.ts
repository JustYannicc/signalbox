import * as Schema from "effect/Schema";

const builtins = new Set([
  "openai",
  "ollama",
  "lmstudio",
  "amazon-bedrock",
  "amazon-bedrock-runtime",
]);
const Table = Schema.Record(Schema.String, Schema.Unknown);
const decodeTable = Schema.decodeUnknownSync(Table);
const isTable = Schema.is(Table);

function withPath(
  table: Record<string, unknown>,
  path: string[],
  value: unknown,
): Record<string, unknown> {
  const [key, ...tail] = path;
  if (key === undefined) return decodeTable(value);
  const previous = table[key];
  return {
    ...table,
    [key]: tail.length === 0 ? value : withPath(isTable(previous) ? previous : {}, tail, value),
  };
}

function providerTables(overrides: Readonly<Record<string, unknown>>, requested: string) {
  const tables = {
    ...(overrides.model_providers === undefined ? {} : decodeTable(overrides.model_providers)),
  };
  // Known IDs are literal keys; longest first keeps fixture.dot distinct from fixture.
  const ids = [...new Set([requested, ...Object.keys(tables)])].sort((a, b) => b.length - a.length);
  const rest: Record<string, unknown> = {};
  // Bootstrap's BTreeMap applies flat descendants after their parent tables.
  for (const [key, value] of Object.entries(overrides).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (key === "model_providers") continue;
    if (!key.startsWith("model_providers.")) {
      rest[key] = value;
      continue;
    }
    const path = key.slice("model_providers.".length);
    const id = ids.find((id) => path === id || path.startsWith(`${id}.`)) ?? path.split(".")[0];
    if (!id) throw new TypeError("Model provider override requires an ID");
    const suffix = path.slice(id.length);
    tables[id] =
      suffix === ""
        ? decodeTable(value)
        : withPath(
            tables[id] === undefined ? {} : decodeTable(tables[id]),
            suffix.slice(1).split("."),
            value,
          );
  }
  return { tables, rest };
}

/** The gateway exposes Responses over HTTP for every pool's backing provider. */
export function gatewayConfig(overrides: Readonly<Record<string, unknown>>, origin: string) {
  const requested =
    typeof overrides.model_provider === "string" ? overrides.model_provider : "openai";
  // 0.162.1 rejects overriding built-ins; removed WebSocket feature flags have no effect.
  const provider = builtins.has(requested) ? "signalbox-gateway" : requested;
  const { tables, rest } = providerTables(overrides, requested);
  const { [requested]: previous, ...others } = tables;
  const selected = {
    name: "Signalbox",
    base_url: new URL("/v1", origin).href,
    wire_api: "responses",
    requires_openai_auth: false,
    ...(previous === undefined ? {} : decodeTable(previous)),
    // Preserve create_openai_provider's auth.json / ChatGPT credential selection.
    ...(requested === "openai" ? { requires_openai_auth: true } : {}),
  };
  return {
    ...rest,
    model_provider: provider,
    model_providers: Object.fromEntries(
      Object.entries({ ...others, [provider]: selected }).map(([id, table]) => [
        id,
        { ...decodeTable(table), supports_websockets: false },
      ]),
    ),
  };
}
