/**
 * The answer kit (#669): what a question's `{ kind: "kit", component, props }` surface may name.
 * Props stay JSON on the ask so later components need no envelope change; an unknown component
 * renders as plain choices, or as text when the question has no options.
 *
 * Answers keep the ask's `{ value, comment }` shape: `value` is the structured part and `comment`
 * the free text, which any answer may carry. On the kit's components a `null` value with a comment
 * answers in words only, so their option values can't be `null` and a `null` recommendation means
 * none. Surfaces the kit doesn't own (provider questions, automation forms, custom HTML) keep
 * their envelope: any JSON answers them, `null` included.
 *
 * A component the person never touched has no answer: clients defer that question instead of
 * submitting a default, and the recommendation applies only when the person picks it.
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ChatAttachmentId,
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
} from "./chatAttachment.ts";
import { PreviewTabId } from "./preview.ts";

export const AskKitComponent = Schema.Literals(["choices", "compare", "slider", "ranking", "text"]);
export type AskKitComponent = typeof AskKitComponent.Type;

export const ASK_KIT_JSON_MAX_LENGTH = 256_000;
export const ASK_KIT_JSON_MAX_DEPTH = 16;
export const ASK_KIT_TEXT_MAX_LENGTH = 20_000;
export const ASK_KIT_SLIDER_MAX_STEPS = 10_000;
export const ASK_KIT_SLIDER_MAX_MAGNITUDE = 1e12;
export const ASK_KIT_DATA_IMAGE_MAX_LENGTH = 48_000;
export const ASK_KIT_HTML_PREVIEW_MAX_LENGTH = 60_000;

const Label = TrimmedNonEmptyString.check(Schema.isMaxLength(80));
const Caption = TrimmedNonEmptyString.check(Schema.isMaxLength(300));

/**
 * A font the device already has, by family name or CSS generic family. Nothing is downloaded:
 * a name the device lacks falls back to the system font. Quotes, commas and `url(` can't appear.
 */
export const AskKitFont = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9 -]{0,62}[A-Za-z0-9])?$/),
);
export type AskKitFont = typeof AskKitFont.Type;

export const AskKitColor = Schema.String.check(
  Schema.isPattern(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/),
);
export type AskKitColor = typeof AskKitColor.Type;

/** Adjusts one option in place; `option` is its index in the question's options. */
export const AskKitOptionStyle = Schema.Struct({
  option: NonNegativeInt,
  font: Schema.optional(AskKitFont),
  color: Schema.optional(AskKitColor),
});
export type AskKitOptionStyle = typeof AskKitOptionStyle.Type;

const OptionStyles = Schema.Array(AskKitOptionStyle).check(Schema.isMaxLength(64));

export const AskKitChoicesProps = Schema.Struct({ optionStyles: Schema.optional(OptionStyles) });
export type AskKitChoicesProps = typeof AskKitChoicesProps.Type;

export const AskKitRankingProps = AskKitChoicesProps;
export type AskKitRankingProps = AskKitChoicesProps;

const HttpsUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(2_048),
  Schema.isPattern(/^https:\/\/\S+$/),
);

/**
 * Thread attachments resolve through the environment's signed asset URL (`AssetResource`
 * "attachment"), so they stay behind the person's session. Data images are for small inline
 * pictures; screenshots belong in attachments. SVG is excluded because it can carry script.
 */
export const AskKitImage = Schema.Union([
  Schema.Struct({ source: Schema.Literal("https"), url: HttpsUrl }),
  Schema.Struct({
    source: Schema.Literal("attachment"),
    attachmentId: ChatAttachmentId,
    mimeType: Schema.Literals(PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES),
  }),
  Schema.Struct({
    source: Schema.Literal("data"),
    dataUrl: Schema.String.check(
      Schema.isMaxLength(ASK_KIT_DATA_IMAGE_MAX_LENGTH),
      Schema.isPattern(/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/),
    ),
  }),
]);
export type AskKitImage = typeof AskKitImage.Type;

const Still = Schema.Struct({ image: AskKitImage, alt: Caption });

/** Descriptions only. Clients render HTML in their ask sandbox, never in the app's origin. */
export const AskKitPreview = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("image"), ...Still.fields }),
  Schema.Struct({
    kind: Schema.Literal("html"),
    title: Label,
    html: Schema.String.check(Schema.isMaxLength(ASK_KIT_HTML_PREVIEW_MAX_LENGTH)),
  }),
  /**
   * A browser preview tab the thread has open (`PreviewSessionSnapshot`). Tabs close and don't
   * outlive their server, so `still` stands in once the tab is gone.
   */
  Schema.Struct({
    kind: Schema.Literal("thread-preview"),
    threadId: ThreadId,
    tabId: PreviewTabId,
    still: Schema.optional(Still),
  }),
]);
export type AskKitPreview = typeof AskKitPreview.Type;

export const AskKitComparePane = Schema.Struct({
  option: NonNegativeInt,
  preview: AskKitPreview,
  caption: Schema.optional(Caption),
});
export type AskKitComparePane = typeof AskKitComparePane.Type;

/** One pane per option; picking a pane answers with that option's value. */
export const AskKitCompareProps = Schema.Struct({
  panes: Schema.Array(AskKitComparePane).check(Schema.isMinLength(2), Schema.isMaxLength(4)),
  optionStyles: Schema.optional(OptionStyles),
});
export type AskKitCompareProps = typeof AskKitCompareProps.Type;

const SliderNumber = Schema.Finite.check(
  Schema.isBetween({
    minimum: -ASK_KIT_SLIDER_MAX_MAGNITUDE,
    maximum: ASK_KIT_SLIDER_MAX_MAGNITUDE,
  }),
);

/** Answers with a number on the grid `min + k * step`, which must reach `max` exactly. */
export const AskKitSliderProps = Schema.Struct({
  min: SliderNumber,
  max: SliderNumber,
  step: SliderNumber.check(Schema.isGreaterThan(0)),
  startLabel: Schema.optional(Label),
  endLabel: Schema.optional(Label),
  unit: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(16))),
});
export type AskKitSliderProps = typeof AskKitSliderProps.Type;

export const AskKitTextProps = Schema.Struct({
  placeholder: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  maxLength: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: ASK_KIT_TEXT_MAX_LENGTH })),
  ),
});
export type AskKitTextProps = typeof AskKitTextProps.Type;

export const AskKitProblemCode = Schema.Literals([
  "json-invalid",
  "json-too-large",
  "props-invalid",
  "options-missing",
  "options-unexpected",
  "option-value-null",
  "option-values-repeated",
  "option-out-of-range",
  "option-repeated",
  "pane-missing",
  "multi-select-unsupported",
  "slider-range-invalid",
  "slider-step-invalid",
  "recommendation-invalid",
  "answer-invalid",
  "answer-unknown-option",
  "answer-repeated",
  "answer-incomplete",
  "answer-out-of-range",
  "answer-off-step",
  "answer-empty",
  "answer-too-long",
]);
export type AskKitProblemCode = typeof AskKitProblemCode.Type;

/** `path` is relative to the question, e.g. `["surface", "props", "panes", 1, "option"]`. */
export const AskKitProblem = Schema.Struct({
  code: AskKitProblemCode,
  path: Schema.Array(Schema.Union([Schema.String, Schema.Int])),
  message: Schema.String,
});
export type AskKitProblem = typeof AskKitProblem.Type;
