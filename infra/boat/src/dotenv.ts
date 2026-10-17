/**
 * Boat stores an environment's variables as one `.env`-style file
 * (`envContents`). These helpers turn a variable map into that file and
 * back, so reconcile can compare observed variables with desired ones
 * instead of comparing file text that Boat may normalize.
 */

const BARE_VALUE = /^[A-Za-z0-9_./:@%+,=-]*$/;

const quote = (value: string) =>
  `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")}"`;

/** Serialize variables as `KEY=value` lines, quoting values that need it. */
export const formatEnvContents = (vars: Record<string, string>): string =>
  Object.keys(vars)
    .sort()
    .map((key) => `${key}=${BARE_VALUE.test(vars[key]!) ? vars[key] : quote(vars[key]!)}`)
    .join("\n");

const unquoteDouble = (value: string) =>
  value.replace(/\\([\\"nr])/g, (_, c: string) => (c === "n" ? "\n" : c === "r" ? "\r" : c));

/** Parse `.env` content: `KEY=value`, optional `export `, quotes and comments. */
export const parseEnvContents = (contents: string): Record<string, string> => {
  const vars: Record<string, string> = {};
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rest] = match as unknown as [string, string, string];
    if (rest.startsWith('"')) {
      const end = /^"((?:[^"\\]|\\.)*)"/.exec(rest);
      vars[key] = end ? unquoteDouble(end[1]!) : rest.slice(1);
    } else if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1);
      vars[key] = end === -1 ? rest.slice(1) : rest.slice(1, end);
    } else {
      vars[key] = rest.replace(/\s+#.*$/, "").trim();
    }
  }
  return vars;
};
