import type {
  AskKitComparePane,
  AskKitOptionStyle,
  AskKitProblem,
  AskKitSliderProps,
} from "@t3tools/contracts/askKit";

/** The question fields the kit reads. The ask contract's question is assignable to it. */
export interface AskKitQuestion {
  readonly options: ReadonlyArray<{ readonly label: string; readonly value: unknown }>;
  readonly multiSelect?: boolean | undefined;
  readonly recommendation?: unknown;
  readonly surface:
    | { readonly kind: "kit"; readonly component: string; readonly props?: unknown }
    | { readonly kind: "html"; readonly html: string };
}

/** Aligned with the question's options; `null` where an option keeps the default look. */
export type AskKitOptionLooks = ReadonlyArray<Omit<AskKitOptionStyle, "option"> | null>;

export type AskKitComponentSpec =
  | {
      readonly component: "choices";
      readonly multiSelect: boolean;
      readonly looks: AskKitOptionLooks;
    }
  | {
      readonly component: "compare";
      readonly panes: ReadonlyArray<AskKitComparePane>;
      readonly looks: AskKitOptionLooks;
    }
  | ({ readonly component: "slider" } & AskKitSliderProps)
  | { readonly component: "ranking"; readonly looks: AskKitOptionLooks }
  | {
      readonly component: "text";
      readonly placeholder?: string | undefined;
      readonly maxLength: number;
    };

/**
 * `legacy` is a surface the kit doesn't own, rendered as #780 does: options as choices, or a text
 * field without options, answered by any JSON. `invalid` is a kit component raised wrong; it
 * renders and answers in words only, so a broken surface never accepts unchecked values.
 */
export type AskKitSpec =
  | AskKitComponentSpec
  | {
      readonly component: "legacy";
      readonly reason: "unknown-component" | "html";
      readonly multiSelect: boolean;
    }
  | { readonly component: "invalid" };

/** A raise is valid only without problems; the spec is always safe to render. */
export interface AskKitResolution {
  readonly spec: AskKitSpec;
  readonly problems: ReadonlyArray<AskKitProblem>;
}

/** An answer value in option indexes; `words-only` leaves the whole answer to the comment. */
export type AskKitValue =
  | { readonly component: "choices"; readonly selected: ReadonlyArray<number> }
  | { readonly component: "compare"; readonly selected: number }
  | { readonly component: "slider"; readonly value: number }
  | { readonly component: "ranking"; readonly order: ReadonlyArray<number> }
  | { readonly component: "text"; readonly text: string }
  | { readonly component: "words-only" }
  | { readonly component: "legacy"; readonly value: unknown };
