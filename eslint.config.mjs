import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Paths are LITERAL, so `grep` finds them; the escape turns Next.js's dynamic
// segments (`[id]`, `[...slug]`) back into literal brackets, since a flat-config
// `files` entry is a GLOB and `[id]` there is a character class matching "i" or
// "d" — 16 route files silently failed to match before this was added.
const escape = (f) => f.replace(/[[\]]/g, "\\$&");

const BASELINE = [
  "src/app/api/a2ui/route.ts",
  "src/app/api/apps/[id]/capabilities/route.ts",
  "src/app/api/assistant/conversations/[conversationId]/messages/route.ts",
  "src/app/api/assistant/feature-branches/route.ts",
  "src/app/api/assistant/reflect/route.ts",
  "src/app/api/assistant/runs/[runId]/events/route.ts",
  "src/app/api/assistant/runs/[runId]/surface-agents/route.ts",
  "src/app/api/assistant/runs/[runId]/surface-tools/route.ts",
  "src/app/api/assistant/runs/[runId]/tool-results/route.ts",
  "src/app/api/assistant/runs/route.ts",
  "src/app/api/assistant/self-improve/route.ts",
  "src/app/api/copilotkit/route.ts",
  "src/app/api/events/[id]/ack/route.ts",
  "src/app/api/events/handlers/route.ts",
  "src/app/api/events/preference/route.ts",
  "src/app/api/events/register/route.ts",
  "src/app/api/events/route.ts",
  "src/app/api/events/stream/route.ts",
  "src/app/api/events/unregister/route.ts",
  "src/app/api/git-remotes/route.ts",
  "src/app/api/gitfs/reconcile/route.ts",
  "src/app/api/integrations/[id]/credentials/route.ts",
  "src/app/api/integrations/[id]/services/[serviceId]/poll/route.ts",
  "src/app/api/integrations/git-providers/route.ts",
  "src/app/api/integrations/telegram/user/disconnect/route.ts",
  "src/app/api/integrations/telegram/user/status/route.ts",
  "src/app/api/integrations/webhooks/[integrationId]/[serviceId]/route.ts",
  "src/app/api/llm/openai/[...path]/route.ts",
  "src/app/api/logs/route.ts",
  "src/app/api/media-proxy/route.ts",
  "src/app/api/memory/consolidate/route.ts",
  "src/app/api/methods/route.ts",
  "src/app/api/repositories/route.ts",
  "src/app/api/secrets/[service]/route.ts",
  "src/app/api/secrets/[service]/verify/route.ts",
  "src/app/api/self-heal/route.ts",
  "src/app/api/services/[id]/config/route.ts",
  "src/app/api/services/[id]/route.ts",
  "src/app/api/services/events/route.ts",
  "src/app/api/specs/route.ts",
  "src/app/api/system/git/route.ts",
  "src/app/api/voice/test/route.ts",
  "src/app/api/voice/voices/route.ts",
  "src/app/apps/[...slug]/route.ts",
  "src/apps/build-studio/HistoryDialog.tsx",
  "src/apps/build-studio/MethodPicker.tsx",
  "src/apps/build-studio/conflict/ConflictStatusHeader.tsx",
  "src/apps/build-studio/index.tsx",
  "src/apps/chat/index.tsx",
  "src/apps/docs/index.tsx",
  "src/apps/event-viewer/index.tsx",
  "src/apps/files/index.tsx",
  "src/apps/marketplace/index.tsx",
  "src/apps/memory/components/EpisodesTab.tsx",
  "src/apps/memory/components/LoopsTab.tsx",
  "src/apps/memory/components/ProfileTab.tsx",
  "src/apps/memory/components/SearchTab.tsx",
  "src/apps/memory/components/TopicsTab.tsx",
  "src/apps/memory/index.tsx",
  "src/apps/presence/index.tsx",
  "src/apps/scheduler/index.tsx",
  "src/components/agent/MermaidDiagram.tsx",
  "src/components/agent/SelfImproveIndicator.tsx",
  "src/components/agent/v2/ChatInputV2.tsx",
  "src/components/agent/v2/ElicitationCards.tsx",
  "src/components/agent/v2/FrontendToolsV2.tsx",
  "src/components/agent/v2/InfoPanelV2.tsx",
  "src/components/apps/IframeApp.tsx",
  "src/components/apps/ProviderSettings.tsx",
  "src/components/apps/assistant-broker.ts",
  "src/components/apps/assistant/AgentSelector.tsx",
  "src/components/apps/assistant/ConversationPanel.tsx",
  "src/components/apps/settings/AppsTab.tsx",
  "src/components/apps/settings/AssistantTab.tsx",
  "src/components/apps/settings/BuildStudioTab.tsx",
  "src/components/apps/settings/CompactionTab.tsx",
  "src/components/apps/settings/ConfigForm.tsx",
  "src/components/apps/settings/DefaultAgentTab.tsx",
  "src/components/apps/settings/DevHarnessTab.tsx",
  "src/components/apps/settings/LogsTab.tsx",
  "src/components/apps/settings/McpServersTab.tsx",
  "src/components/apps/settings/SelfImprovementTab.tsx",
  "src/components/apps/settings/ServiceConfigPanel.tsx",
  "src/components/apps/settings/ServiceLogViewer.tsx",
  "src/components/apps/settings/ServicesTab.tsx",
  "src/components/apps/settings/ToolsTab.tsx",
  "src/components/apps/settings/VersionsTab.tsx",
  "src/components/apps/settings/VoiceTab.tsx",
  "src/components/apps/settings/assistant/AgentDetails.tsx",
  "src/components/apps/settings/assistant/DangerZone.tsx",
  "src/components/apps/settings/assistant/NewAgentDialog.tsx",
  "src/components/apps/settings/assistant/ToolAccordions.tsx",
  "src/components/apps/settings/integrations/ClientSecretUpload.tsx",
  "src/components/apps/settings/integrations/IntegrationDetailView.tsx",
  "src/components/apps/settings/integrations/OAuthCredentialsPanel.tsx",
  "src/components/apps/settings/integrations/PollingSection.tsx",
  "src/components/apps/settings/integrations/TelegramBotAgentConfig.tsx",
  "src/components/apps/settings/integrations/TelegramBotAuthSection.tsx",
  "src/components/apps/settings/integrations/WebhookSection.tsx",
  "src/components/apps/settings/integrations/useIntegrations.ts",
  "src/components/apps/settings/versions/GitRemotesTab.tsx",
  "src/components/desktop/ConflictLaunch.tsx",
  "src/components/desktop/EventBell.tsx",
  "src/components/desktop/SetupWizard.tsx",
  "src/components/desktop/Topbar.tsx",
  "src/components/desktop/VersionControls.tsx",
  "src/components/desktop/setup-wizard/Step1AiProvider.tsx",
  "src/components/desktop/setup-wizard/Step6SettingUp.tsx",
  "src/components/desktop/subscribeEventStream.ts",
  "src/components/gitops/ConflictSessionBadge.tsx",
  "src/components/logging/useLogContextMenu.tsx",
  "src/components/settings/TelegramWebhookConfig.tsx",
  "src/components/voice/VoiceWaveform.tsx",
  "src/core/service/ServiceManager.ts",
  "src/core/service/ServiceRegistry.ts",
  "src/core/service/manifestValidator.ts",
  "src/hooks/useVoice.ts",
  "src/lib/agent/compaction/summarize.ts",
  "src/lib/agent/compaction/v2.ts",
  "src/lib/agent/conversations-server.ts",
  "src/lib/agent/conversations.ts",
  "src/lib/agent/llm.ts",
  "src/lib/agent/memory/agent-memory.ts",
  "src/lib/agent/memory/consolidate.ts",
  "src/lib/agent/memory/episodes.ts",
  "src/lib/agent/memory/fast-loop.ts",
  "src/lib/agent/memory/search.ts",
  "src/lib/agent/memory/topics.ts",
  "src/lib/agent/memory/watermarks.ts",
  "src/lib/agent/seed-sync.ts",
  "src/lib/agent/skills/store.ts",
  "src/lib/agent/subagents/claude-runner.ts",
  "src/lib/agent/subagents/run-registry.ts",
  "src/lib/agent/subagents/store.ts",
  "src/lib/agent/subagents/transcript.ts",
  "src/lib/agent/tool-kernel.ts",
  "src/lib/agent/tool-metadata-overrides.ts",
  "src/lib/apps/build.ts",
  "src/lib/apps/store.ts",
  "src/lib/assistant/agent-loop.ts",
  "src/lib/assistant/client/run-client.ts",
  "src/lib/assistant/client/surface-agents.ts",
  "src/lib/assistant/conversation-store.ts",
  "src/lib/assistant/gate.ts",
  "src/lib/assistant/messages.ts",
  "src/lib/assistant/model-turn.ts",
  "src/lib/assistant/run-manager.ts",
  "src/lib/assistant/start-run.ts",
  "src/lib/assistant/tools/server/conflict-resolve.ts",
  "src/lib/assistant/tools/server/conversation-review.ts",
  "src/lib/assistant/tools/server/delegate-common.ts",
  "src/lib/assistant/tools/server/file-to-markdown.ts",
  "src/lib/assistant/tools/server/files.ts",
  "src/lib/assistant/tools/server/git-remotes.ts",
  "src/lib/assistant/tools/server/git.ts",
  "src/lib/assistant/tools/server/memory.ts",
  "src/lib/assistant/tools/server/skills.ts",
  "src/lib/assistant/tools/server/specs.ts",
  "src/lib/assistant/tools/server/video-tools.ts",
  "src/lib/datafs/clone.ts",
  "src/lib/dev/repo-fs.ts",
  "src/lib/dev/spec-fs.ts",
  "src/lib/docs/roots.ts",
  "src/lib/docs/store.ts",
  "src/lib/events/loopback.ts",
  "src/lib/events/migrate-integrations.ts",
  "src/lib/events/store.ts",
  "src/lib/events/stream.ts",
  "src/lib/file-handlers/registry.ts",
  "src/lib/gitops/auth.ts",
  "src/lib/gitops/conflict-agent.ts",
  "src/lib/gitops/filesystems.ts",
  "src/lib/gitops/git-credential-helper.ts",
  "src/lib/gitops/git-ops.ts",
  "src/lib/gitops/lock.ts",
  "src/lib/gitops/logging.ts",
  "src/lib/gitops/reconcile.ts",
  "src/lib/gitops/sessions/store.ts",
  "src/lib/gitops/sync-status.ts",
  "src/lib/iframe-sdk/index.ts",
  "src/lib/integrations/__tests__/oauth-delta-scope.test.ts",
  "src/lib/integrations/actions/dispatcher.ts",
  "src/lib/integrations/adapters/base.ts",
  "src/lib/integrations/oauth/manager.ts",
  "src/lib/integrations/scheduler/daemon.ts",
  "src/lib/integrations/scheduler/jobs.ts",
  "src/lib/integrations/secrets/keyfile.ts",
  "src/lib/integrations/secrets/store.ts",
  "src/lib/integrations/services/gsuite/adapters/gmail-webhook.ts",
  "src/lib/integrations/services/gsuite/adapters/gmail.ts",
  "src/lib/integrations/services/gsuite/client.ts",
  "src/lib/integrations/services/telegram/adapters/bot-webhook.ts",
  "src/lib/integrations/services/telegram/adapters/bot.ts",
  "src/lib/integrations/services/telegram/auth.ts",
  "src/lib/integrations/services/telegram/context-cache.ts",
  "src/lib/integrations/services/telegram/mtproto-client.ts",
  "src/lib/integrations/services/telegram/search-index.ts",
  "src/lib/integrations/services/telegram/user-cache.ts",
  "src/lib/integrations/webhooks/manager.ts",
  "src/lib/integrations/webhooks/verify.ts",
  "src/lib/logging/client/browser-logger.ts",
  "src/lib/logging/local-reader.ts",
  "src/lib/logging/services/logging-service.ts",
  "src/lib/logging/sinks/file-log-sink.ts",
  "src/lib/marketplace/client.ts",
  "src/lib/marketplace/migrate-installed-state.ts",
  "src/lib/marketplace/migrate-user-apps.ts",
  "src/lib/mcp/client.ts",
  "src/lib/mcp/gateway.ts",
  "src/lib/plugins/loader.ts",
  "src/lib/plugins/registry.ts",
  "src/lib/scheduler/engine.ts",
  "src/lib/scheduler/lock.ts",
  "src/lib/scheduler/migrate.ts",
  "src/lib/self-heal/diagnostician.ts",
  "src/lib/self-heal/intake.ts",
  "src/lib/self-heal/report.ts",
  "src/lib/self-heal/runs.ts",
  "src/lib/self-heal/store.ts",
  "src/lib/specs/item-stores.ts",
  "src/lib/specs/method/builtin-pack.ts",
  "src/lib/specs/method/constitution.ts",
  "src/lib/specs/method/modules.ts",
  "src/lib/specs/method/overlay.ts",
  "src/lib/specs/method/preflight.ts",
  "src/lib/specs/pipeline.ts",
  "src/lib/specs/promote.ts",
  "src/lib/specs/repositories.ts",
  "src/lib/specs/seed.ts",
  "src/lib/specs/store-git.ts",
  "src/lib/specs/stores.ts",
  "src/lib/system/bash.ts",
  "src/lib/system/git.ts",
  "src/lib/system/run-command.ts",
  "src/lib/voice/client/config-store.ts",
  "src/lib/voice/stt-client.ts",
  "src/lib/voice/tts/omnivoice.ts",
  "src/lib/voice/tts/openai.ts",
  "src/os/atomic-write.ts",
  "src/os/fs/docs-fs.ts",
  "src/os/fs/git-fs.ts",
  "src/os/fs/spec-fs.ts",
  "src/os/vfs.ts",
  "src/plugins/self-heal/index.ts",
  "src/system/items/capabilities.ts",
  "src/system/items/installed.ts",
  "src/system/marketplace/install/bundledAssets.ts",
  "src/system/marketplace/install/serviceInstaller.ts",
  "src/system/marketplace/install/symlinkManager.ts",
  "tests/agent/delegation-targets.test.ts",
  "tests/bastion/image-autobuild.test.ts",
  "tests/e2e/mounts-sync.test.ts",
  "tests/events/_test-env.ts",
  "tests/gitops/conflict-session-store.test.ts",
  "tests/gitops/git-credential-helper.test.ts",
  "tests/self-heal/_test-env.ts",
  "tests/services/_stub-server-only.ts",
  "tests/services/bundled-assets.test.ts",
  "tests/specs/branch-mount-split-brain.test.ts",
  "tools/copy-vad-assets.mjs",
  "tools/supervisor/lib/build.mjs",
  "tools/supervisor/lib/conversations.mjs",
  "tools/supervisor/lib/coupled-repos.mjs",
  "tools/supervisor/lib/git-auth.mjs",
  "tools/supervisor/lib/preview.mjs",
  "tools/supervisor/lib/proc.mjs",
  "tools/supervisor/lib/push.mjs",
  "tools/supervisor/lib/secrets.mjs",
  "tools/supervisor/lib/worktree.mjs",
  "tools/supervisor/log-store.mjs",
].map(escape);

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // External spec stores (018-external-spec-store) are independent git repos
    // mounted under specs/ at runtime — not BrowserOS source, and absent (and
    // gitignored) in a plain checkout, so the app's eslint must not lint them.
    "specs/**",
    // Supervisor-created runtime state for feature-branch previews, both
    // gitignored (.gitignore:59-60) and neither BOS source:
    //   bos-worktrees/<branch>/   — a FULL second checkout of BOS, so linting
    //                               it lints the whole codebase twice, at some
    //                               other branch, including its own bastion/
    //                               (which the entry below only excludes at the
    //                               top level).
    //   bos-data-clones/<branch>/ — a data clone holding whatever an installed
    //                               marketplace item vendors, i.e. third-party JS.
    // Both appear the moment anyone previews a branch locally, and together
    // they reported 600+ errors from code nobody here owns — which makes
    // `npm run lint` useless as a gate. Same rationale as specs/** above.
    "bos-worktrees/**",
    "bos-data-clones/**",
    // Everything under data/ is RUNTIME STATE, gitignored, and belongs to the
    // USER — installed items, cloned marketplaces, and (050) any repository the
    // user registers. Linting it reports a user's own application, in whatever
    // style and language they chose, as errors against BOS's rules. Adding a
    // repository must not be able to fail BOS's build.
    "data/**",
    // Test fixtures a suite WRITES at run time — generated artifacts, gitignored
    // (.gitignore's `tests/**/.tmp*/`), and deliberately not in BOS's style:
    // manifestValidator's fixtures are CommonJS worker entrypoints, because
    // that is what a real marketplace item ships. A lint gate that fails on
    // files a test created is a gate that punishes writing tests.
    "tests/**/.tmp*/**",
    // bastion/ is a standalone Node.js/Express + react-router sub-project with
    // its own package.json/tsconfig — not part of the Next.js app, so the
    // app's Next/React lint rules do not apply to it.
    "bastion/**",
  ]),

  // ── Swallowed errors are illegal in BOS ─────────────────────────────────────
  //
  // A catch must distinguish an EXPECTED ABSENCE (test `err.code === "ENOENT"`)
  // from a FAILURE (report or rethrow it). The banned shape is a handler that
  // takes NO PARAMETER and yields a constant — `.catch(() => [])`,
  // `.catch(() => null)`, `.catch(() => {})`. Having never bound the error, it
  // cannot have inspected it, so "there is nothing here" and "I could not tell"
  // come back as the same answer.
  //
  // Not a style preference — this exact shape has produced real defects:
  //   - `hashDirectory`'s walk skipped an unreadable directory and returned the
  //     digest of FEWER FILES, so UNEQUAL assets compared EQUAL and an update was
  //     silently skipped (surfaced only as an intermittent test failure);
  //   - `seedOneKind` reported "this item bundles nothing" for a source it could
  //     not read;
  //   - `copyOverlay` dropped a user's customisations when forking a workflow.
  // Each was invisible at the call site and expensive to find.
  //
  // Empty `catch {}` blocks are the same thing in statement form.
  {
    files: ["src/**/*.{ts,tsx,mjs}", "tools/**/*.{ts,mjs}", "tests/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          // `.catch(() => value)` — concise arrow body, no parameter.
          selector:
            "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression[params.length=0][body.type!='BlockStatement']",
          message:
            "Swallowed error: this `.catch` takes no parameter, so it cannot have inspected the failure — an expected absence and a real error return the same value. Bind it and test it: `.catch((err) => { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; throw err; })`.",
        },
        {
          // `.catch(() => {})` and any parameterless block body — including
          // `.catch(() => { /* ignore */ })`, which is the same thing with an
          // excuse attached.
          selector:
            "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression[params.length=0] > BlockStatement",
          message:
            "Swallowed error: this `.catch` takes no parameter, so nothing about the failure was examined. Bind the error and either report it (`logger().error(...)`) or rethrow.",
        },
        {
          // `try { ... } catch { }` / `catch (err) { }`.
          selector: "CatchClause > BlockStatement[body.length=0]",
          message:
            "Empty catch block: the error is discarded. Name the case you expect (`if (err.code === 'ENOENT') return ...`) and rethrow everything else.",
        },
      ],
    },
  },

  // BASELINE — every file that already had one when the rule went in.
  //
  // A SHRINKING LIST. Its only job is to stop NEW swallows while leaving the
  // existing ones visible and countable; each entry is a place where "nothing
  // here" and "could not tell" are currently indistinguishable. Delete an entry
  // when you fix its file. DO NOT ADD TO IT — a new file that needs to be here
  // is a change that should not be made.
  //
  // Suppressing per-file rather than per-line is deliberate: 637 inline
  // `eslint-disable` comments would read as 637 considered decisions, when they
  // are one decision not to stop the world for a cleanup.
  //
  // THE HOLE THIS LEAVES, stated rather than discovered: a file on this list is
  // unprotected, so a NEW swallow added to one of these 271 files goes unflagged.
  // 1146 of the 1417 linted files are covered, and every new file is. If you are
  // editing a file that is on this list, fix its swallows and remove the entry —
  // that is the intended way for the list to empty.
  // Spread, because flat config rejects an empty `files` array — so when the
  // last entry goes, this block disappears rather than breaking the build.
  ...(BASELINE.length ? [{ files: BASELINE, rules: { "no-restricted-syntax": "off" } }] : []),
]);

export default eslintConfig;
