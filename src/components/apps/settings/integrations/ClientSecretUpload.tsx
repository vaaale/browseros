"use client";

import { useCallback, useRef, useState } from "react";
import { Upload, KeyRound, Trash2 } from "lucide-react";
import { getRedirectUri } from "@/lib/integrations/oauth/origin";

export interface ClientSecretUploadProps {
  integrationId: string;
  hasClientSecret: boolean;
  onUploaded: () => void;
  onCleared: () => void;
}

/**
 * Drag/drop + file picker for `client_secrets.json`. Validates that the file
 * parses as JSON before POSTing; deeper structural validation runs server-side
 * so the UI never sees the raw credentials.
 *
 * When a secret is already stored, shows a "configured" status with Replace
 * and Clear actions instead of the upload form.
 */
export function ClientSecretUpload({ integrationId, hasClientSecret, onUploaded, onCleared }: ClientSecretUploadProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [dragging, setDragging] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const submit = useCallback(
    async (file: File) => {
      setBusy(true);
      setError(undefined);
      try {
        const text = await file.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new Error("File is not valid JSON.");
        }
        const res = await fetch(`/api/integrations/${encodeURIComponent(integrationId)}/client-secret`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(parsed),
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string; ok?: boolean };
        if (!res.ok) throw new Error(body.error ?? `Upload failed: ${res.status}`);
        setReplacing(false);
        onUploaded();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [integrationId, onUploaded],
  );

  const clear = useCallback(async () => {
    if (!confirm("Remove the stored client_secrets.json? You will need to upload it again to reconnect.")) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch(`/api/integrations/${encodeURIComponent(integrationId)}/client-secret`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Clear failed: ${res.status}`);
      }
      onCleared();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [integrationId, onCleared]);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file) void submit(file);
    },
    [submit],
  );

  const redirectUri = getRedirectUri("/api/integrations/oauth/callback");

  if (hasClientSecret && !replacing) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/[0.02] px-4 py-3 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[12px] text-white/70">
            <KeyRound size={14} className="shrink-0 text-white/40" />
            <span><span className="font-mono">client_secrets.json</span> configured</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => { setError(undefined); setReplacing(true); }}
              className="inline-flex items-center gap-1.5 rounded border border-white/15 px-2.5 py-1 text-[11px] font-medium text-white/80 transition-colors hover:bg-white/10 disabled:opacity-50"
            >
              <Upload size={11} /> Replace
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void clear()}
              className="inline-flex items-center gap-1.5 rounded border border-red-400/40 px-2.5 py-1 text-[11px] font-medium text-red-300 transition-colors hover:bg-red-500/15 disabled:opacity-50"
            >
              <Trash2 size={11} /> Clear
            </button>
          </div>
        </div>
        {redirectUri && (
          <div className="text-[10.5px] text-white/40">
            Authorized redirect URI for Google Cloud Console:{" "}
            <span className="font-mono text-white/60 select-all">{redirectUri}</span>
          </div>
        )}
        {error && <div className="mt-1 text-[11px] text-red-300">{error}</div>}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-dashed border-white/15 bg-white/[0.02] p-4">
      <div
        className={`flex flex-col items-center gap-2 rounded p-4 transition-colors ${
          dragging ? "bg-violet-500/10" : ""
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <KeyRound size={20} className="text-white/50" />
        <div className="text-center text-[12px] text-white/70">
          Upload <span className="font-mono">client_secrets.json</span> from your Google Cloud Console OAuth client.
        </div>
        {redirectUri && (
          <div className="text-center text-[10.5px] text-white/50">
            Add this as an authorized redirect URI in Google Cloud Console:{" "}
            <span className="font-mono text-white/70 select-all">{redirectUri}</span>
          </div>
        )}
        <div className="text-center text-[10.5px] text-white/40">
          Drag the file here, or pick it manually. Never committed to your repo — encrypted at rest.
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            className="mt-1 inline-flex items-center gap-1.5 rounded bg-violet-500/80 px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
          >
            <Upload size={12} />
            {busy ? "Uploading…" : "Choose file"}
          </button>
          {replacing && (
            <button
              type="button"
              disabled={busy}
              onClick={() => { setError(undefined); setReplacing(false); }}
              className="mt-1 inline-flex items-center gap-1.5 rounded border border-white/15 px-3 py-1.5 text-[11px] font-medium text-white/60 transition-colors hover:bg-white/10 disabled:opacity-50"
            >
              Cancel
            </button>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void submit(file);
            e.target.value = "";
          }}
        />
        {error && <div className="mt-2 text-[11px] text-red-300">{error}</div>}
      </div>
    </div>
  );
}
