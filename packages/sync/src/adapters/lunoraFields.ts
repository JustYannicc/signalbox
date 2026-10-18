// Lunora aliases the `id` column to its native document key; keep domain id in the JSON row.
export const LUNORA_DOMAIN_ID_FIELD = "__sync_domain_id";

export const lunoraFieldName = (field: string): string =>
  field === "id" ? LUNORA_DOMAIN_ID_FIELD : field;

export const encodeLunoraRow = (row: Record<string, unknown>): Record<string, unknown> => {
  if (!Object.hasOwn(row, "id")) return row;
  const { id, ...rest } = row;
  return { ...rest, [LUNORA_DOMAIN_ID_FIELD]: id };
};

export const decodeLunoraRow = (row: Record<string, unknown>): Record<string, unknown> => {
  if (!Object.hasOwn(row, LUNORA_DOMAIN_ID_FIELD)) return row;
  const { [LUNORA_DOMAIN_ID_FIELD]: id, ...rest } = row;
  return { ...rest, id };
};
