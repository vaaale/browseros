// Framework-free — no server-only, no React. Safe to import from client.

export interface PluginRouteContext {
  pluginId: string;
  log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
}

export type RouteMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

export type RouteHandler = (
  req: Request,
  ctx: PluginRouteContext,
) => Promise<Response>;

export interface RouteRegistration {
  method: RouteMethod;
  /** Normalised path, e.g. "/session" or "/app/bundle.js". Leading slash required. */
  path: string;
  handler: RouteHandler;
}

export interface SettingsPanelRegistration {
  pluginId: string;
  label: string;
  /** lucide-react icon name */
  icon: string;
  order: number;
  configSchema: Record<string, unknown>;
  /** Keys whose values are stored in the secrets store and never returned to the browser. */
  secretFields: string[];
}

export interface BosPluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  bosVersion?: string;
  sdkVersion?: string;
  entry?: string;
}

export interface BosPluginContext {
  pluginId: string;
  log: PluginRouteContext["log"];
}

export interface BosPluginModule {
  activate?(ctx: BosPluginContext): Promise<void>;
  deactivate?(ctx: BosPluginContext): Promise<void>;
}

export interface VoiceEnginePlugin {
  id: string;
  displayName: string;
  configSchema?: Record<string, unknown>;
  /**
   * A visual presence for the agent — BOS hosts this URL in its presence window
   * and drives its lifecycle (036). The surface renders media, reports its aspect
   * ratio and whether it is actually playing; it owns no connect/disconnect UI.
   * Absent for engines that only produce sound.
   */
  surface?: { url: string; label?: string };
  onSessionStart?(sessionId: string): Promise<void>;
  onSessionEnd?(sessionId: string): Promise<void>;
  speak(
    text: string,
    config: Record<string, unknown>,
    sessionId: string,
  ): Promise<{ durationMs: number; audioUrl?: string }>;
  interrupt(sessionId: string): Promise<void>;
  /**
   * Audio sinks render audio that another engine generated (e.g. a lip-synced
   * avatar). While a sink reports itself active, the voice pipeline routes every
   * utterance to it instead of playing in the browser — so the avatar speaks the
   * conversation whatever TTS engine is selected.
   */
  isSinkActive?(): boolean | Promise<boolean>;
  playAudio?(audio: { dataUrl: string; durationMs: number }, sessionId: string): Promise<void>;
}
