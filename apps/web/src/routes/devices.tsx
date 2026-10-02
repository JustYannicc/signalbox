import { createFileRoute } from "@tanstack/react-router";

import { DevicesPage } from "../components/devices/DevicesPage";

export const Route = createFileRoute("/devices")({
  component: DevicesPage,
});
