// BOS Plugin SDK — import as "#bos-plugin-sdk" from plugin code.
// Re-exports the registration functions plugins need at runtime.

export { registerRoute, unregisterRoutes } from "@/lib/bos-plugins/route-registry";
export { registerAdditionalCapabilities, unregisterCapabilities } from "@/lib/agent/capabilities-registry";
export { registerSettingsPanel, unregisterSettingsPanel } from "@/lib/bos-plugins/settings-registry";
export { registerVoiceEngine, unregisterVoiceEngine } from "@/lib/voice/engine-registry";
export { registerIntegration, unregisterIntegration } from "@/lib/integrations/registry";
export { registerAdapter, unregisterAdapter } from "@/lib/integrations/actions/adapter-registry";
export { registerWebhookHandler, unregisterWebhookHandler } from "@/lib/integrations/webhooks/registry";

export type {
  BosPluginContext,
  BosPluginModule,
  PluginRouteContext,
  RouteMethod,
  RouteHandler,
  SettingsPanelRegistration,
  VoiceEnginePlugin,
} from "@/lib/bos-plugins/types";
