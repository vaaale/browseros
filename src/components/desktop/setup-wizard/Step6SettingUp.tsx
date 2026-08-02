"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle, XCircle, Loader2 } from "lucide-react";
import type { SetupOperation, Step4Values, MarketplaceRow, OperationStatus } from "./wizard-types";
import type { ProviderType } from "@/lib/agent/provider-meta";

interface Props {
  provider: ProviderType;
  model: string;
  baseUrl: string;
  apiKey: string;
  repos: Step4Values;
  marketplaces: MarketplaceRow[];
  onComplete: () => void;
}

function detectProvider(url: string): "github" | "gitlab" | "generic" {
  if (/github\.com/i.test(url)) return "github";
  if (/gitlab\.com/i.test(url)) return "gitlab";
  return "generic";
}

function StatusIcon({ status }: { status: OperationStatus }) {
  if (status === "running") return <Loader2 size={14} className="animate-spin text-violet-400" />;
  if (status === "ok") return <CheckCircle size={14} className="text-emerald-400" />;
  if (status === "failed") return <XCircle size={14} className="text-red-400" />;
  return <div className="h-3.5 w-3.5 rounded-full border border-white/20" />;
}

function buildOperations(repos: Step4Values, marketplaces: MarketplaceRow[]): SetupOperation[] {
  const ops: SetupOperation[] = [
    { id: "ai-provider", label: "Configure AI provider", status: "pending" },
  ];
  if (repos.bosSource.url) {
    ops.push({ id: "bos-source", label: "Set up BOS Source remote", status: "pending" });
  }
  ops.push({ id: "bos-specs", label: "Set up BOS Specifications", status: "pending" });
  ops.push({ id: "user-apps", label: "Set up User Apps", status: "pending" });
  for (const m of marketplaces.filter((r) => r.checked && r.url)) {
    ops.push({ id: `mp:${m.url}`, label: `Add marketplace: ${m.name}`, status: "pending" });
  }
  return ops;
}

export function Step6SettingUp({ provider, model, baseUrl, apiKey, repos, marketplaces, onComplete }: Props) {
  const [ops, setOps] = useState<SetupOperation[]>(() => buildOperations(repos, marketplaces));
  const started = useRef(false);

  const update = (id: string, status: OperationStatus, error?: string) =>
    setOps((prev) => prev.map((op) => op.id === id ? { ...op, status, error } : op));

  const run = async (id: string, fn: () => Promise<void>) => {
    update(id, "running");
    try {
      await fn();
      update(id, "ok");
    } catch (e) {
      update(id, "failed", (e as Error).message);
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    void (async () => {
      // Parallel phase: AI provider + repo operations
      await Promise.all([
        run("ai-provider", async () => {
          const r = await fetch("/api/config", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              namespace: "ai-provider",
              values: { provider, model, baseUrl, ...(apiKey ? { apiKey } : {}) },
            }),
          });
          if (!r.ok) throw new Error((await r.json() as { error?: string }).error ?? "Failed");
        }),

        repos.bosSource.url
          ? run("bos-source", async () => {
              const r = await fetch("/api/git-remotes", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  action: "add",
                  filesystem: "bos-src",
                  name: "origin",
                  url: repos.bosSource.url,
                  authType: "token",
                  provider: detectProvider(repos.bosSource.url),
                  defaultBranch: repos.bosSource.branch || "main",
                  autoPush: false,
                }),
              });
              if (!r.ok) {
                const d = await r.json() as { error?: { message?: string } };
                throw new Error(d.error?.message ?? "Failed");
              }
            })
          : Promise.resolve(),

        run("bos-specs", async () => {
          const r = await fetch("/api/system/setup/repos", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ op: "bos-specs", url: repos.bosSpecs.url, branch: repos.bosSpecs.branch }),
          });
          if (!r.ok) {
            const d = await r.json() as { error?: string };
            throw new Error(d.error ?? "Failed");
          }
        }),

        run("user-apps", async () => {
          const r = await fetch("/api/system/setup/repos", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ op: "user-apps", url: repos.userApps.url, branch: repos.userApps.branch }),
          });
          if (!r.ok) {
            const d = await r.json() as { error?: string };
            throw new Error(d.error ?? "Failed");
          }
        }),
      ]);

      // Sequential phase: marketplace adds
      for (const m of marketplaces.filter((r) => r.checked && r.url)) {
        await run(`mp:${m.url}`, async () => {
          const r = await fetch("/api/marketplace", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ op: "add", url: m.url }),
          });
          if (!r.ok) {
            const d = await r.json() as { error?: string };
            throw new Error(d.error ?? "Failed");
          }
        });
      }

      // Mark setup complete and open desktop
      await fetch("/api/system/setup", { method: "POST" }).catch(() => {});
      onComplete();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const allSettled = ops.every((op) => op.status === "ok" || op.status === "failed");

  return (
    <div className="space-y-4">
      <p className="text-xs text-white/50">
        BrowserOS is setting up your environment. This may take a moment while repositories are cloned.
      </p>

      <div className="space-y-2">
        {ops.map((op) => (
          <div
            key={op.id}
            className={`flex items-start gap-3 rounded border p-3 transition-colors
              ${op.status === "ok" ? "border-emerald-500/20 bg-emerald-500/5"
              : op.status === "failed" ? "border-red-500/20 bg-red-500/5"
              : op.status === "running" ? "border-violet-500/20 bg-violet-500/5"
              : "border-white/10"}`}
          >
            <div className="mt-0.5 shrink-0">
              <StatusIcon status={op.status} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs text-white/80">{op.label}</div>
              {op.error && <div className="mt-0.5 text-[10px] text-red-400">{op.error}</div>}
            </div>
          </div>
        ))}
      </div>

      {allSettled && ops.some((op) => op.status === "failed") && (
        <p className="text-[11px] text-white/40">
          Some steps failed. You can retry them later in Settings → Versions or Settings → Marketplace.
          Opening desktop…
        </p>
      )}
    </div>
  );
}
