import { CheckIcon, CopyIcon } from "lucide-react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

/** Copies `value` and confirms with a toast, so the result is visible even off-button. */
export function useCopyWithToast(target: string) {
  return useCopyToClipboard<{ toastTitle: string; toastDescription: string }>({
    target,
    onCopy: ({ toastTitle, toastDescription }) =>
      toastManager.add({
        id: "setup-copy",
        type: "success",
        title: toastTitle,
        description: toastDescription,
        timeout: 2500,
      }),
    onError: (error) =>
      toastManager.add({
        id: "setup-copy",
        type: "error",
        title: `Couldn't copy the ${target}`,
        description: `${error.message} Select the text and copy it by hand.`,
      }),
  });
}

/** A read-only code block with a small copy button in its corner. */
export function CopyableCode({
  value,
  label,
  className,
}: {
  readonly value: string;
  /** What is being copied, e.g. "MCP config". Used for the button label and toast. */
  readonly label: string;
  readonly className?: string;
}) {
  const { copyToClipboard, isCopied } = useCopyWithToast(label);
  return (
    <div className={cn("relative min-w-0", className)}>
      <pre className="m-0 overflow-x-auto rounded-md bg-code py-2.5 ps-3 pe-10 font-mono text-xs leading-relaxed text-code-foreground">
        {value}
      </pre>
      <div className="absolute top-1 right-1">
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={isCopied ? `Copied ${label}` : `Copy ${label}`}
          onClick={() =>
            copyToClipboard(value, {
              toastTitle: `Copied ${label}`,
              toastDescription: "Paste it where your agent can use it.",
            })
          }
        >
          {isCopied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </div>
    </div>
  );
}
