import * as NodeURL from "node:url";

// A failed destroy may remove the Workers before it removes Boat resources.
// Include those names in the sweep so the next run can finish the cleanup.
export const previewNumbers = (names) =>
  [
    ...new Set(
      names.flatMap(
        (name) => /^signalbox-cloud-pr-([1-9][0-9]*)-runner$/.exec(name)?.slice(1) ?? [],
      ),
    ),
  ]
    .map(Number)
    .sort((a, b) => a - b);

export const inventoryPreviewNumbers = async (key, base = "https://boat.dev/api/v1") => {
  const inventories = await Promise.all(
    [
      ["environments", "environments"],
      ["named-snapshots", "snapshots"],
      ["api-keys", "apiKeys"],
    ].map(async ([path, field]) => {
      const response = await fetch(`${base}/${path}`, {
        headers: { authorization: `Bearer ${key}`, accept: "application/json" },
        redirect: "error",
      });
      if (!response.ok) throw new Error(`Boat ${path} inventory returned ${response.status}.`);
      const body = await response.json();
      if (!Array.isArray(body[field])) throw new Error(`Boat ${path} inventory is unreadable.`);
      return body[field].flatMap((item) => (typeof item.name === "string" ? [item.name] : []));
    }),
  );
  return previewNumbers(inventories.flat());
};

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const key = process.env.BOAT_DEPLOY_API_KEY?.trim();
  if (!key) throw new Error("BOAT_DEPLOY_API_KEY is required for Boat preview cleanup.");
  const numbers = await inventoryPreviewNumbers(key);
  if (numbers.length > 0) console.log(numbers.join("\n"));
}
