// @effect-diagnostics preferSchemaOverJson:off - preflight bounds allocations before the native JSON parser.
type Frame =
  | { kind: "object"; state: "key" | "colon" | "value" | "comma"; keys: Set<string>; key: string }
  | { kind: "array"; state: "value" | "comma" };

/** Reject allocation-heavy shapes and duplicate keys before materializing the message graph. */
export function preflightJsonFrame(text: string): string | undefined {
  const stack: Frame[] = [];
  let offset = 0;
  let values = 0;
  let rootSeen = false;
  let rootId: string | undefined;
  const fail = (message: string): never => {
    throw new SyntaxError(message);
  };
  const whitespace = () => {
    while (offset < text.length && /[\t\n\r ]/.test(text[offset]!)) offset++;
  };
  const quoted = () => {
    const start = offset++;
    while (offset < text.length) {
      const character = text[offset++]!;
      if (character === '"') return text.slice(start, offset);
      if (character === "\\") offset++;
      else if (character.charCodeAt(0) < 32) fail("Invalid JSON string");
    }
    return fail("Unterminated JSON string");
  };
  for (;;) {
    whitespace();
    const frame = stack.at(-1);
    const character = text[offset];
    if (frame?.kind === "object" && frame.state === "colon") {
      if (character !== ":") fail("Expected a colon");
      offset++;
      frame.state = "value";
      continue;
    }
    if (frame?.state === "comma") {
      if (character === ",") {
        offset++;
        frame.state = frame.kind === "object" ? "key" : "value";
        continue;
      }
      if (character !== (frame.kind === "object" ? "}" : "]"))
        fail("Expected a comma or container end");
      offset++;
      stack.pop();
      continue;
    }
    if (frame?.kind === "object" && frame.state === "key") {
      if (character === "}") {
        offset++;
        stack.pop();
        continue;
      }
      if (character !== '"') fail("Expected an object key");
      const key: unknown = JSON.parse(quoted());
      if (typeof key !== "string") return fail("Invalid object key");
      if (frame.keys.has(key)) fail("Duplicate JSON object key");
      frame.keys.add(key);
      frame.key = key;
      frame.state = "colon";
      continue;
    }
    if (frame?.kind === "array" && frame.state === "value" && character === "]") {
      offset++;
      stack.pop();
      continue;
    }
    if (!frame && rootSeen) {
      if (offset !== text.length) fail("Unexpected trailing JSON");
      return rootId;
    }
    if (character === undefined) fail("Incomplete JSON");
    if (++values > 256 * 1024) fail("Message exceeds value limit");
    rootSeen = true;
    if (frame) frame.state = "comma";
    if (character === "{" || character === "[") {
      if (stack.length >= 128) fail("JSON nesting exceeds 128 containers");
      offset++;
      stack.push(
        character === "{"
          ? { kind: "object", state: "key", keys: new Set(), key: "" }
          : { kind: "array", state: "value" },
      );
      continue;
    }
    if (character === '"') {
      quoted();
      continue;
    }
    const start = offset;
    while (offset < text.length && !/[\t\n\r ,\]}]/.test(text[offset]!)) offset++;
    if (start === offset) fail("Invalid JSON value");
    if (stack.length === 1 && frame?.kind === "object" && frame.key === "id") {
      rootId = text.slice(start, offset);
    }
  }
}
