import { createFileRoute } from "@tanstack/react-router";

import { CapturePage } from "../components/capture/CapturePage";

export const Route = createFileRoute("/capture")({
  component: CapturePage,
});
