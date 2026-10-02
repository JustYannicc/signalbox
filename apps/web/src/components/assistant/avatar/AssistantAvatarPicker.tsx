/**
 * Compact avatar creator: a preview, a Shuffle button, and one row each for
 * colour, shape and face. Every option previews itself on the current avatar,
 * so choices are visual. Controlled: it only emits `onChange(config)`; the
 * caller decides when to save.
 */
import { ShuffleIcon } from "lucide-react";

import { Button } from "../../ui/button";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import { AssistantAvatar } from "./AssistantAvatar";
import {
  AVATAR_COLORS,
  AVATAR_FACES,
  AVATAR_SHAPES,
  generateAvatar,
  randomAvatarSeed,
  type AssistantAvatarConfig,
} from "./avatarConfig";

const ROWS = [
  { field: "color", label: "Colour", values: AVATAR_COLORS },
  { field: "shape", label: "Shape", values: AVATAR_SHAPES },
  { field: "face", label: "Face", values: AVATAR_FACES },
] as const;

type RowField = (typeof ROWS)[number]["field"];

function OptionRow<F extends RowField>(props: {
  field: F;
  label: string;
  values: readonly AssistantAvatarConfig[F][];
  value: AssistantAvatarConfig;
  onChange: (config: AssistantAvatarConfig) => void;
}) {
  const { field, label, value } = props;
  return (
    <div className="flex items-start gap-3">
      <span className="w-12 shrink-0 pt-1 text-sm text-muted-foreground">{label}</span>
      <ToggleGroup
        aria-label={label}
        variant="default"
        size="sm"
        className="min-w-0 flex-1 flex-wrap"
        value={[value[field]]}
        onValueChange={(next) => {
          const picked = props.values.find((candidate) => candidate === next[0]);
          if (picked) props.onChange({ ...value, [field]: picked });
        }}
      >
        {props.values.map((option) => (
          <Toggle key={option} value={option} aria-label={`${label}: ${option}`}>
            <AssistantAvatar
              config={{ ...value, [field]: option }}
              size={24}
              className="size-6 opacity-100"
            />
          </Toggle>
        ))}
      </ToggleGroup>
    </div>
  );
}

export function AssistantAvatarPicker(props: {
  value: AssistantAvatarConfig;
  onChange: (config: AssistantAvatarConfig) => void;
  /** Shown under the preview. */
  name?: string;
}) {
  const { value, onChange } = props;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4 rounded-2xl bg-muted p-3">
        <AssistantAvatar
          config={value}
          size={72}
          label={props.name ? `${props.name}'s avatar` : "Avatar preview"}
        />
        <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
          {props.name && (
            <span className="max-w-full truncate text-base font-semibold">{props.name}</span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => onChange(generateAvatar(randomAvatarSeed()))}
          >
            <ShuffleIcon />
            Shuffle
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {ROWS.map((row) => (
          <OptionRow
            key={row.field}
            field={row.field}
            label={row.label}
            values={row.values}
            value={value}
            onChange={onChange}
          />
        ))}
      </div>
    </div>
  );
}
