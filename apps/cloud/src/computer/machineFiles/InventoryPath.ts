interface InventoryEntry {
  readonly path: string;
  readonly type: string;
  readonly target?: string;
}

/** The image still supplies ancestor symlinks when upper directories shadow them. */
export function resolveInventoryPath<Entry extends InventoryEntry>(
  path: string,
  entries: ReadonlyMap<string, Entry>,
  excludedRoots: readonly string[],
  followFinal: boolean,
): { kind: "entry"; path: string; entry: Entry } | { kind: "excluded" | "missing" } {
  const pending = path.slice(1).split("/").filter(Boolean);
  const components: string[] = [];
  let entry = entries.get("/");
  let links = 0;
  while (pending.length > 0) {
    if (entry?.type !== "directory") return { kind: "missing" };
    const component = pending.shift()!;
    if (component === ".") continue;
    if (component === "..") components.pop();
    else components.push(component);
    const current = `/${components.join("/")}`;
    if (excludedRoots.includes(current)) return { kind: "excluded" };
    entry = entries.get(current);
    if (entry === undefined) return { kind: "missing" };
    if (entry.type === "symlink" && (pending.length > 0 || followFinal)) {
      if (++links > 40)
        throw Object.assign(new Error("Too many machine symlinks"), { code: "ELOOP" });
      const target = entry.target!;
      components.pop();
      if (target.startsWith("/")) components.length = 0;
      pending.unshift(...target.split("/").filter(Boolean));
      entry = entries.get(`/${components.join("/")}`);
    }
  }
  return entry === undefined
    ? { kind: "missing" }
    : { kind: "entry", path: `/${components.join("/")}`, entry };
}
