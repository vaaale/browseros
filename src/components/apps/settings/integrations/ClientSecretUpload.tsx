"use client";

import { useCallback, useRef, useState } from "react";
import { Upload, KeyRound } from "lucide-react";

export interface ClientSecretUploadProps {
  integrationId: string;
  onUploaded: () => void;
}

/**
 * Drag/drop + file picker for `client_secrets.json`. Validates that the file
 * parses as JSON before POSTing; deeper structural validation runs server-side
 * so the UI never sees the raw credentials.
 */
export function ClientSecretUpload({ integrationId, onUploaded }: ClientSecretUploadProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [dragging, setDragging] = useState(false);
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
        onUploaded();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [integrationId, onUploaded],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file) void submit(file);
    },
    [submit],
  );

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
        <div className="text-center text-[10.5px] text-white/40">
          Drag the file here, or pick it manually. Never committed to your repo — encrypted at rest.
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          className="mt-1 inline-flex items-center gap-1.5 rounded bg-violet-500/80 px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
        >
          <Upload size={12} />
          {busy ? "Uploading…" : "Choose file"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void submit(file);
            // Allow selecting the same file twice.
            e.target.value = "";
          }}
        />
        {error && <div className="mt-2 text-[11px] text-red-300">{error}</div>}
      </div>
    </div>
  );
}
