import type { ComponentType } from "react";

export interface AppProps {
  windowId: string;
  appId: string;
  params?: Record<string, unknown>;
}

export type AppComponent = ComponentType<AppProps>;
