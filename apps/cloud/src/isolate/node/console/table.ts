import * as NodeUtil from "node:util";

/** Render tabular values without depending on Node's private cli_table module. */
export function consoleTable(
  data: object,
  properties: readonly string[] | undefined,
  options: NodeUtil.InspectOptions,
): string {
  const cell = (value: unknown) =>
    NodeUtil.inspect(value, { depth: 0, maxArrayLength: 3, breakLength: Infinity, ...options });
  let headers: string[];
  let rows: string[][];
  if (data instanceof Map) {
    headers = ["(iteration index)", "Key", "Values"];
    rows = [...data].map(([key, value], index) => [String(index), cell(key), cell(value)]);
  } else if (data instanceof Set) {
    headers = ["(iteration index)", "Values"];
    rows = [...data].map((value, index) => [String(index), cell(value)]);
  } else {
    const entries = Object.entries(data);
    const columns =
      properties === undefined
        ? [
            ...new Set(
              entries.flatMap(([, value]) =>
                value !== null && (typeof value === "object" || typeof value === "function")
                  ? Object.keys(value)
                  : [],
              ),
            ),
          ]
        : [...properties];
    const hasValues =
      properties === undefined &&
      entries.some(
        ([, value]) => value === null || (typeof value !== "object" && typeof value !== "function"),
      );
    headers = ["(index)", ...columns, ...(hasValues ? ["Values"] : [])];
    rows = entries.map(([key, value]) => {
      const object = value !== null && (typeof value === "object" || typeof value === "function");
      return [
        key,
        ...columns.map((column) =>
          object && Object.hasOwn(value, column) ? cell(Reflect.get(value, column)) : "",
        ),
        ...(hasValues ? [object ? "" : cell(value)] : []),
      ];
    });
  }
  const width = (value: string) => [...NodeUtil.stripVTControlCharacters(value)].length;
  const widths = headers.map((header, index) =>
    Math.max(width(header), ...rows.map((row) => width(row[index] ?? ""))),
  );
  const border = (left: string, middle: string, right: string) =>
    left + widths.map((size) => "─".repeat(size + 2)).join(middle) + right;
  const line = (row: string[]) =>
    "│ " +
    widths
      .map((size, index) => (row[index] ?? "") + " ".repeat(size - width(row[index] ?? "")))
      .join(" │ ") +
    " │";
  return [
    border("┌", "┬", "┐"),
    line(headers),
    border("├", "┼", "┤"),
    ...rows.map(line),
    border("└", "┴", "┘"),
  ].join("\n");
}
