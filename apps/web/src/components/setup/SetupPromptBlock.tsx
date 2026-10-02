/**
 * The main onboarding path: copy one prompt into the coding agent you already
 * use, or hand it straight to your assistant.
 */
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, CopyIcon } from "lucide-react";

import { useAssistantIdentity } from "../assistant/assistantIdentity";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { useCopyWithToast } from "./CopyableCode";
import { SETUP_PROMPT } from "./setupFixtures";

export function SetupPromptBlock() {
  const navigate = useNavigate();
  const { name } = useAssistantIdentity();
  const { copyToClipboard, isCopied } = useCopyWithToast("setup prompt");

  const handToAssistant = () => {
    toastManager.add({
      id: "setup-assistant",
      type: "info",
      title: `${name} is setting things up`,
      description: "Prototype only; the prompt isn't sent yet.",
      timeout: 3000,
    });
    void navigate({ to: "/assistant" });
  };

  return (
    <section aria-labelledby="setup-prompt" className="flex flex-col gap-3">
      <h2 id="setup-prompt" className="text-sm font-medium text-foreground">
        Setup prompt
      </h2>
      <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-code">
        <pre className="m-0 max-h-80 overflow-auto p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-code-foreground">
          {SETUP_PROMPT}
        </pre>
        <div className="flex flex-wrap items-center gap-3 border-t border-border bg-background p-3">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            Paste it into Codex, Claude Code, or any coding agent.
          </p>
          <Button size="lg" variant="outline" onClick={handToAssistant}>
            Let {name} do it
          </Button>
          <Button
            size="lg"
            onClick={() =>
              copyToClipboard(SETUP_PROMPT, {
                toastTitle: "Setup prompt copied",
                toastDescription: "Paste it into your coding agent.",
              })
            }
          >
            {isCopied ? <CheckIcon /> : <CopyIcon />}
            {isCopied ? "Copied" : "Copy setup prompt"}
          </Button>
        </div>
      </div>
    </section>
  );
}
