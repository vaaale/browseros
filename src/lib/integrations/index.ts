// Public entry point for the integrations subsystem.
//
// Framework-free — safe to import from client or server. Server-only
// modules (SecretsStore, OAuthManager, State store) live under
// `./secrets`, `./oauth`, `./state` and are imported directly from
// server code (API routes / adapters) — they are NOT re-exported here.

export * from "./types";
export * from "./errors";

// Side-effect import: registers the GSuite manifest with the registry.
// Add further service modules here as they come online.
import "./services/gsuite";
import "./services/telegram";
