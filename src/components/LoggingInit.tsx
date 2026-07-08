"use client";

import { useEffect } from "react";
import { startBrowserLogging } from "@/lib/logging/client/browser-logger";

// Mounts once at the app root to start browser logging (global error capture +
// batched shipping to the Supervisor). Renders nothing. See specs/017-central-logging.
export function LoggingInit() {
  useEffect(() => {
    const stop = startBrowserLogging();
    return stop;
  }, []);
  return null;
}
