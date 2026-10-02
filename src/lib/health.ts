import "server-only";

import { version } from "../../package.json";
import type { HealthResponse } from "@/types/health";

export function getHealth(): HealthResponse {
  return {
    status: "ok",
    service: "vyro-automation-engine",
    timestamp: new Date().toISOString(),
    version,
  };
}
