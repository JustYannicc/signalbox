import * as Context from "effect/Context";

export interface SearchSettings {
  readonly generation: string;
  readonly disabled: boolean;
}

export const SearchSettings = Context.Reference<SearchSettings>(
  "@signalbox/cloud/search/SearchSettings",
  { defaultValue: () => ({ generation: "1", disabled: false }) },
);

export interface SearchSettingsEnv {
  readonly SEARCH_INDEX_GENERATION?: string;
  readonly SEARCH_INDEX_DISABLED?: string;
}

/** Fail startup on misspellings instead of silently serving an old or empty index. */
export const searchSettings = (env: SearchSettingsEnv): SearchSettings => {
  const generation = env.SEARCH_INDEX_GENERATION?.trim() || "1";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(generation)) {
    throw new Error(
      "SEARCH_INDEX_GENERATION must be 1-64 letters, digits, underscores or hyphens.",
    );
  }
  const disabled = env.SEARCH_INDEX_DISABLED?.trim() || "0";
  if (disabled !== "0" && disabled !== "1") {
    throw new Error("SEARCH_INDEX_DISABLED must be 0 or 1.");
  }
  return { generation, disabled: disabled === "1" };
};
