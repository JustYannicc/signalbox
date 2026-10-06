import { createFileRoute } from "@tanstack/react-router";

import { PoolsSettings } from "../components/accountPool/PoolsSettings";

// signalbox: account pools.
export const Route = createFileRoute("/settings/pools")({ component: PoolsSettings });
