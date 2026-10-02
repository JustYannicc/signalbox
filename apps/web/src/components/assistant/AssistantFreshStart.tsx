/**
 * What a new day opens on: a greeting, whatever is still open (carried over),
 * a roomy composer and a few starters. Nothing else competes for attention.
 */
import { useState } from "react";

import { Button } from "../ui/button";
import type { ChatFixture } from "./assistantFixtures";
import { AssistantComposer } from "./AssistantComposer";
import { AssistantIcon, useAssistantIdentity } from "./assistantIdentity";
import { CarriedOver } from "./CarriedOver";

const SUGGESTIONS = [
  "What's waiting on me?",
  "Plan my day around my calendar",
  "Catch me up on Northwind",
] as const;

function greeting(hour: number): string {
  if (hour < 5) return "Up late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function AssistantFreshStart(props: {
  chat: ChatFixture;
  onTrace: (nodeId: string) => void;
  prompt?: string;
  onPromptChange?: (prompt: string) => void;
  onSend: (text: string, files: ReadonlyArray<File>) => void;
}) {
  const { name } = useAssistantIdentity();
  const [localPrompt, setLocalPrompt] = useState("");
  const prompt = props.prompt ?? localPrompt;
  const setPrompt = props.onPromptChange ?? setLocalPrompt;

  return (
    <div className="flex flex-col gap-6 pt-10 sm:pt-20">
      <div className="flex flex-col items-center gap-3 text-center">
        <AssistantIcon size={120} />
        <h1 className="text-2xl font-semibold tracking-tight text-balance">
          {greeting(new Date().getHours())}
        </h1>
        <p className="text-sm text-muted-foreground text-pretty">{name} here, with a fresh chat.</p>
      </div>
      <CarriedOver chat={props.chat} onTrace={props.onTrace} />
      <AssistantComposer
        recipient={name}
        targetKey="assistant"
        placeholder={`Ask ${name}, or hand something off`}
        size="large"
        prompt={prompt}
        onPromptChange={setPrompt}
        onSend={props.onSend}
      />
      <div className="flex flex-wrap justify-center gap-2">
        {SUGGESTIONS.map((suggestion) => (
          <Button
            key={suggestion}
            size="sm"
            variant="outline"
            onClick={() => setPrompt(suggestion)}
          >
            {suggestion}
          </Button>
        ))}
      </div>
    </div>
  );
}
