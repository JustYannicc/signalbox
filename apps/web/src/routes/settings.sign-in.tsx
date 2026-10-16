import { createFileRoute } from "@tanstack/react-router";

import { SignInSettingsPanel } from "../components/settings/SignInSettings";

// signalbox: standing sign-in grants (#575).
export const Route = createFileRoute("/settings/sign-in")({ component: SignInSettingsPanel });
