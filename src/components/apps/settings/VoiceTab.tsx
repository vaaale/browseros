"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceConfig, OmnivoiceTTSConfig } from "@/lib/voice/types";

type VoiceSource = "alias" | "design" | "clone";

const INPUT = "w-full rounded-md border border-white/10 bg-white/[0.05] px-2.5 py-1.5 text-sm text-white/90 outline-none focus:border-white/20 focus:bg-white/[0.08]";
const LABEL = "mb-1 block text-xs text-white/60";
const SECTION_HEAD = "mb-3 text-xs font-semibold uppercase tracking-wide text-white/40";
const SUBHEAD = "mb-2 text-[11px] font-semibold uppercase tracking-wide text-white/30";
const BTN = "rounded-md bg-white/10 px-3 py-1.5 text-xs text-white/70 hover:bg-white/15 disabled:opacity-40";
const BTN_PRIMARY = "rounded-md bg-[#5b8cff] px-3 py-1.5 text-xs text-white hover:bg-[#4a7be8] disabled:opacity-40";

// Voice-design attribute options — mirror Omnivoice's /tts/voice-design/options.
// "" = No preference (dropped from the composed instruct).
const DESIGN_OPTIONS: Record<string, string[]> = {
  gender: ["male", "female"],
  age: ["child", "teenager", "young adult", "middle-aged", "elderly"],
  pitch: ["very low pitch", "low pitch", "moderate pitch", "high pitch", "very high pitch"],
  style: ["whisper"],
  englishAccent: [
    "american accent", "australian accent", "british accent", "chinese accent", "canadian accent",
    "indian accent", "korean accent", "portuguese accent", "russian accent", "japanese accent",
  ],
  chineseDialect: ["河南话", "陕西话", "四川话", "贵州话", "云南话", "桂林话", "济南话", "石家庄话", "甘肃话", "宁夏话", "青岛话", "东北话"],
};

function Slider({ label, value, min, max, step, onChange }: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className={LABEL}>{label} <span className="ml-1 text-white/40">{value.toFixed(step < 1 ? 2 : 0)}</span></label>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-[#5b8cff]"
      />
    </div>
  );
}

function DesignSelect({ label, value, options, onChange, note }: {
  label: string; value: string; options: string[]; onChange: (v: string) => void; note?: string;
}) {
  return (
    <div>
      <label className={LABEL}>{label}{note && <span className="ml-1 text-white/30">{note}</span>}</label>
      <select className={INPUT} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">No preference</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

export function VoiceTab() {
  const [cfg, setCfg] = useState<VoiceConfig | null>(null);
  const [status, setStatus] = useState<string>("");
  const [sttTestStatus, setSttTestStatus] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [sttTestDetail, setSttTestDetail] = useState<string>("");
  const [sttModels, setSttModels] = useState<string[]>([]);
  const [sttModelsLoading, setSttModelsLoading] = useState(false);
  const [omniVoices, setOmniVoices] = useState<string[]>([]);
  const [omniVoicesLoading, setOmniVoicesLoading] = useState(false);
  const [languages, setLanguages] = useState<{ id: string; name: string }[]>([]);
  const [voiceSource, setVoiceSource] = useState<VoiceSource>("alias");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [previewing, setPreviewing] = useState<"idle" | "fetching" | "playing">("idle");
  const [previewError, setPreviewError] = useState<string>("");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/voice").then((r) => r.json()) as { config?: VoiceConfig };
    if (res.config) {
      setCfg(res.config);
      const ov = res.config.omnivoice;
      // Prefer the persisted source; fall back to deriving it for pre-existing
      // configs saved before voiceSource was stored.
      if (ov.voiceSource) setVoiceSource(ov.voiceSource);
      else if (ov.refAudioPath) setVoiceSource("clone");
      else setVoiceSource("alias");
    }
  }, []);

  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  const fetchSttModels = useCallback(async (url?: string) => {
    setSttModelsLoading(true);
    try {
      const res = await fetch("/api/voice/models?service=stt").then((r) => r.json()) as { models: string[]; error?: string };
      setSttModels(res.models ?? []);
    } catch {
      setSttModels([]);
    } finally {
      setSttModelsLoading(false);
    }
    void url; // url param reserved for future per-url fetching
  }, []);

  // Fetch STT models once on mount
  useEffect(() => {
    const id = setTimeout(() => void fetchSttModels(), 0);
    return () => clearTimeout(id);
  }, [fetchSttModels]);

  const fetchOmniVoices = useCallback(async () => {
    setOmniVoicesLoading(true);
    try {
      const res = await fetch("/api/voice/voices").then((r) => r.json()) as { voices?: string[] };
      setOmniVoices(Array.isArray(res.voices) ? res.voices : []);
    } catch {
      setOmniVoices([]);
    } finally {
      setOmniVoicesLoading(false);
    }
  }, []);

  // Fetch Omnivoice voices once on mount
  useEffect(() => {
    const id = setTimeout(() => void fetchOmniVoices(), 0);
    return () => clearTimeout(id);
  }, [fetchOmniVoices]);

  const fetchLanguages = useCallback(async () => {
    try {
      const res = await fetch("/api/voice/languages").then((r) => r.json()) as { languages?: { id: string; name: string }[] };
      setLanguages(Array.isArray(res.languages) ? res.languages : []);
    } catch {
      setLanguages([]);
    }
  }, []);

  useEffect(() => {
    const id = setTimeout(() => void fetchLanguages(), 0);
    return () => clearTimeout(id);
  }, [fetchLanguages]);

  const patchConfig = useCallback(async (patch: Partial<VoiceConfig>) => {
    setStatus("Saving…");
    try {
      const res = await fetch("/api/voice", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patch }),
      }).then((r) => r.json()) as { config?: VoiceConfig; error?: string };
      if (res.error) { setStatus(`Error: ${res.error}`); return; }
      if (res.config) setCfg(res.config);
      setStatus("Saved");
      setTimeout(() => setStatus(""), 2000);
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`);
    }
  }, []);

  const save = useCallback((patch: Partial<VoiceConfig>) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void patchConfig(patch), 600);
  }, [patchConfig]);

  // Flush any pending debounced save immediately (returns when persisted) so
  // an action that depends on server-side config — like Preview — sees the
  // current selection instead of stale config.
  const flushSave = useCallback(async (current: VoiceConfig) => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    await patchConfig({ omnivoice: current.omnivoice, openai: current.openai, ttsProvider: current.ttsProvider });
  }, [patchConfig]);

  const update = useCallback(<K extends keyof VoiceConfig>(key: K, value: VoiceConfig[K]) => {
    setCfg((prev) => {
      if (!prev) return prev;
      const next = { ...prev, [key]: value };
      save({ [key]: value } as Partial<VoiceConfig>);
      return next;
    });
  }, [save]);

  const updateOpenAI = useCallback(<K extends keyof VoiceConfig["openai"]>(key: K, value: VoiceConfig["openai"][K]) => {
    setCfg((prev) => {
      if (!prev) return prev;
      const next = { ...prev, openai: { ...prev.openai, [key]: value } };
      save({ openai: next.openai });
      return next;
    });
  }, [save]);

  const updateOmnivoice = useCallback(<K extends keyof OmnivoiceTTSConfig>(key: K, value: OmnivoiceTTSConfig[K]) => {
    setCfg((prev) => {
      if (!prev) return prev;
      const next = { ...prev, omnivoice: { ...prev.omnivoice, [key]: value } };
      save({ omnivoice: next.omnivoice });
      return next;
    });
  }, [save]);

  const testStt = useCallback(async () => {
    if (!cfg) return;
    setSttTestStatus("testing");
    setSttTestDetail("");
    try {
      const res = await fetch("/api/voice/test?service=stt");
      const data = await res.json() as { ok: boolean; detail?: string; error?: string };
      setSttTestStatus(data.ok ? "ok" : "error");
      setSttTestDetail(data.detail ?? data.error ?? "");
      if (data.ok) void fetchSttModels();
    } catch (e) {
      setSttTestStatus("error");
      setSttTestDetail((e as Error).message);
    }
    setTimeout(() => { setSttTestStatus("idle"); setSttTestDetail(""); }, 8000);
  }, [cfg, fetchSttModels]);

  const previewVoice = useCallback(async () => {
    if (!cfg || previewing !== "idle") return;
    setPreviewError("");
    setPreviewing("fetching");

    // Stop any currently-playing preview
    previewAudioRef.current?.pause();
    previewAudioRef.current = null;

    try {
      // Persist the current selection first — the TTS route reads server-side
      // config, so without this a just-changed voice would preview stale.
      await flushSave(cfg);

      const res = await fetch("/api/voice/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Hello! I am your BOS voice assistant. How can I help you today?" }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => `HTTP ${res.status}`);
        // Try to parse JSON error from the route
        let msg = body;
        try { msg = (JSON.parse(body) as { error?: string }).error ?? body; } catch { /* raw text */ }
        throw new Error(msg);
      }

      const blob = await res.blob();
      // A header-only response (a few dozen bytes, no audio frames) means the
      // model generated nothing — e.g. an unsupported voice-design instruct.
      if (blob.size < 512) throw new Error("TTS returned no audio — the voice settings may be unsupported by this Omnivoice model. Try different voice-design attributes.");

      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      previewAudioRef.current = audio;

      const cleanup = () => { URL.revokeObjectURL(url); setPreviewing("idle"); };
      audio.onended = cleanup;
      audio.onerror = () => { cleanup(); setPreviewError("Audio playback failed — browser could not decode the audio"); };

      setPreviewing("playing");
      await audio.play().catch((e: Error) => {
        cleanup();
        setPreviewError(`Playback blocked: ${e.message}`);
      });
    } catch (e) {
      setPreviewError((e as Error).message);
      setPreviewing("idle");
    }
  }, [cfg, previewing, flushSave]);

  if (!cfg) return <p className="text-xs text-white/40">Loading…</p>;

  return (
    <div className="space-y-6 pb-4">

      {/* Services — STT */}
      <section>
        <h4 className={SECTION_HEAD}>Speech Recognition (STT)</h4>
        <div className="space-y-3">
          <div>
            <label className={LABEL}>Speaches URL</label>
            <div className="flex gap-2">
              <input className={INPUT} value={cfg.sttUrl} onChange={(e) => update("sttUrl", e.target.value)} placeholder="http://wizzo.akhbar.lan:8082" />
              <button
                className={`${BTN} shrink-0 ${sttTestStatus === "ok" ? "text-emerald-400" : sttTestStatus === "error" ? "text-rose-400" : ""}`}
                onClick={() => void testStt()}
                disabled={sttTestStatus === "testing"}
              >
                {sttTestStatus === "testing" ? "Testing…" : sttTestStatus === "ok" ? "✓ OK" : sttTestStatus === "error" ? "✗ Error" : "Test"}
              </button>
            </div>
            {sttTestDetail && (
              <p className={`mt-1 text-xs ${sttTestStatus === "error" ? "text-rose-400" : "text-white/40"}`}>
                {sttTestDetail}
              </p>
            )}
          </div>
          <div>
            <label className={LABEL}>
              STT Model
              {sttModelsLoading && <span className="ml-2 text-white/30">Loading…</span>}
              {!sttModelsLoading && sttModels.length === 0 && (
                <span className="ml-2 text-white/30">(enter manually — start Speaches and click Test to populate)</span>
              )}
            </label>
            {sttModels.length > 0 ? (
              <div className="flex gap-2">
                <select
                  className={INPUT}
                  value={sttModels.includes(cfg.sttModel) ? cfg.sttModel : ""}
                  onChange={(e) => { if (e.target.value) update("sttModel", e.target.value); }}
                >
                  {!sttModels.includes(cfg.sttModel) && (
                    <option value="" disabled>{cfg.sttModel} (not in list)</option>
                  )}
                  {sttModels.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                <button
                  className={BTN + " shrink-0"}
                  title="Refresh model list"
                  onClick={() => void fetchSttModels()}
                  disabled={sttModelsLoading}
                >
                  ↻
                </button>
              </div>
            ) : (
              <input
                className={INPUT}
                value={cfg.sttModel}
                onChange={(e) => update("sttModel", e.target.value)}
                placeholder="Systran/faster-distil-whisper-small.en"
              />
            )}
          </div>
          <div>
            <label className={LABEL}>Language</label>
            <input className={INPUT} value={cfg.language} onChange={(e) => update("language", e.target.value)} placeholder="en" />
          </div>
        </div>
      </section>

      {/* VAD */}
      <section>
        <h4 className={SECTION_HEAD}>Voice Detection (VAD)</h4>
        <div className="space-y-3">
          <div>
            <Slider label="Speech threshold" value={cfg.vadThreshold} min={0.1} max={0.95} step={0.05} onChange={(v) => update("vadThreshold", v)} />
            <p className="mt-1 text-[11px] text-white/35">
              Silero speech probability required to count as speech. Higher = stricter —
              fewer false triggers from ambient noise (keyboard, fans, music). 0.6–0.8 works well in noisy rooms.
            </p>
          </div>
          <div>
            <label className={LABEL}>Silence threshold <span className="text-white/40">{cfg.minSilenceMs}ms</span></label>
            <input type="range" min={200} max={2000} step={50} value={cfg.minSilenceMs} onChange={(e) => update("minSilenceMs", parseInt(e.target.value))} className="w-full accent-[#5b8cff]" />
          </div>
        </div>
      </section>

      {/* Speech Synthesis */}
      <section>
        <h4 className={SECTION_HEAD}>Speech Synthesis (TTS)</h4>
        <div className="space-y-3">
          <div>
            <label className={LABEL}>Provider</label>
            <select
              className={INPUT}
              value={cfg.ttsProvider}
              onChange={(e) => update("ttsProvider", e.target.value as VoiceConfig["ttsProvider"])}
            >
              <option value="omnivoice">Omnivoice (native)</option>
              <option value="openai-compatible">OpenAI Compatible</option>
            </select>
          </div>

          {cfg.ttsProvider === "openai-compatible" && (
            <div className="space-y-3 rounded-lg border border-white/10 p-3">
              <div>
                <label className={LABEL}>API URL</label>
                <input className={INPUT} value={cfg.openai.url} onChange={(e) => updateOpenAI("url", e.target.value)} />
              </div>
              <div>
                <label className={LABEL}>API Key</label>
                <input type="password" className={INPUT} value={cfg.openai.apiKey} onChange={(e) => updateOpenAI("apiKey", e.target.value)} placeholder="sk-… (leave empty for self-hosted)" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={LABEL}>Model</label>
                  <input className={INPUT} value={cfg.openai.model} onChange={(e) => updateOpenAI("model", e.target.value)} />
                </div>
                <div>
                  <label className={LABEL}>Voice</label>
                  <input className={INPUT} value={cfg.openai.voice} onChange={(e) => updateOpenAI("voice", e.target.value)} />
                </div>
              </div>
              <Slider label="Speed" value={cfg.openai.speed} min={0.25} max={4.0} step={0.05} onChange={(v) => updateOpenAI("speed", v)} />
              <div>
                <label className={LABEL}>Format</label>
                <select className={INPUT} value={cfg.openai.responseFormat} onChange={(e) => updateOpenAI("responseFormat", e.target.value as VoiceConfig["openai"]["responseFormat"])}>
                  {["mp3", "wav", "opus", "aac", "flac"].map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>
            </div>
          )}

          {cfg.ttsProvider === "omnivoice" && (
            <div className="space-y-3 rounded-lg border border-white/10 p-3">
              <div>
                <label className={LABEL}>Omnivoice URL</label>
                <input className={INPUT} value={cfg.omnivoice.url} onChange={(e) => updateOmnivoice("url", e.target.value)} />
              </div>

              <div>
                <label className={LABEL}>Voice source</label>
                <div className="flex gap-4">
                  {(["alias", "design", "clone"] as VoiceSource[]).map((s) => (
                    <label key={s} className="flex cursor-pointer items-center gap-1.5 text-xs text-white/70">
                      <input type="radio" value={s} checked={voiceSource === s} onChange={() => { setVoiceSource(s); updateOmnivoice("voiceSource", s); }} className="accent-[#5b8cff]" />
                      {s === "alias" ? "Voice alias" : s === "design" ? "Voice design" : "Clone"}
                    </label>
                  ))}
                </div>
              </div>

              {voiceSource === "alias" && (
                <div>
                  <label className={LABEL}>
                    Voice
                    {omniVoicesLoading && <span className="ml-2 text-white/30">Loading…</span>}
                    {!omniVoicesLoading && omniVoices.length === 0 && (
                      <span className="ml-2 text-white/30">(enter manually — Omnivoice unreachable)</span>
                    )}
                  </label>
                  {omniVoices.length > 0 ? (
                    <div className="flex gap-2">
                      <select
                        className={INPUT}
                        value={omniVoices.includes(cfg.omnivoice.voice) ? cfg.omnivoice.voice : ""}
                        onChange={(e) => { if (e.target.value) updateOmnivoice("voice", e.target.value); }}
                      >
                        {!omniVoices.includes(cfg.omnivoice.voice) && (
                          <option value="" disabled>{cfg.omnivoice.voice || "Select a voice"}{cfg.omnivoice.voice ? " (not in list)" : ""}</option>
                        )}
                        {omniVoices.map((v) => (
                          <option key={v} value={v}>{v}</option>
                        ))}
                      </select>
                      <button
                        className={BTN + " shrink-0"}
                        title="Refresh voice list"
                        onClick={() => void fetchOmniVoices()}
                        disabled={omniVoicesLoading}
                      >
                        ↻
                      </button>
                    </div>
                  ) : (
                    <input className={INPUT} value={cfg.omnivoice.voice} onChange={(e) => updateOmnivoice("voice", e.target.value)} placeholder="nova" />
                  )}
                </div>
              )}

              {voiceSource === "design" && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <DesignSelect label="Gender" value={cfg.omnivoice.designGender} options={DESIGN_OPTIONS.gender} onChange={(v) => updateOmnivoice("designGender", v)} />
                    <DesignSelect label="Age" value={cfg.omnivoice.designAge} options={DESIGN_OPTIONS.age} onChange={(v) => updateOmnivoice("designAge", v)} />
                    <DesignSelect label="Pitch" value={cfg.omnivoice.designPitch} options={DESIGN_OPTIONS.pitch} onChange={(v) => updateOmnivoice("designPitch", v)} />
                    <DesignSelect label="Style" value={cfg.omnivoice.designStyle} options={DESIGN_OPTIONS.style} onChange={(v) => updateOmnivoice("designStyle", v)} />
                    <DesignSelect label="English accent" value={cfg.omnivoice.designEnglishAccent} options={DESIGN_OPTIONS.englishAccent} onChange={(v) => updateOmnivoice("designEnglishAccent", v)} note="(English only)" />
                    <DesignSelect label="Chinese dialect" value={cfg.omnivoice.designChineseDialect} options={DESIGN_OPTIONS.chineseDialect} onChange={(v) => updateOmnivoice("designChineseDialect", v)} note="(Chinese only)" />
                  </div>
                  <p className="text-[11px] text-white/35">
                    Combine attributes to design a voice. This Omnivoice model only accepts these
                    predefined attributes — free-form descriptions aren&apos;t supported.
                  </p>
                </div>
              )}

              {voiceSource === "clone" && (
                <div className="space-y-2">
                  <div>
                    <label className={LABEL}>Reference audio path (server path to WAV)</label>
                    <input className={INPUT} value={cfg.omnivoice.refAudioPath} onChange={(e) => updateOmnivoice("refAudioPath", e.target.value)} placeholder="/app/data/voice-ref/my-voice.wav" />
                  </div>
                  <div>
                    <label className={LABEL}>Reference transcript (optional, improves quality)</label>
                    <textarea className={INPUT + " resize-none"} rows={2} value={cfg.omnivoice.refText} onChange={(e) => updateOmnivoice("refText", e.target.value)} />
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={LABEL}>Language</label>
                  {languages.length > 0 ? (
                    <select className={INPUT} value={cfg.omnivoice.language} onChange={(e) => updateOmnivoice("language", e.target.value)}>
                      <option value="">Auto</option>
                      {languages.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.id})</option>)}
                    </select>
                  ) : (
                    <input className={INPUT} value={cfg.omnivoice.language} onChange={(e) => updateOmnivoice("language", e.target.value)} placeholder="Auto (leave blank)" />
                  )}
                </div>
                <div>
                  <label className={LABEL}>Format</label>
                  <select className={INPUT} value={cfg.omnivoice.format} onChange={(e) => updateOmnivoice("format", e.target.value as OmnivoiceTTSConfig["format"])}>
                    {["mp3", "wav", "flac", "ogg"].map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>
              </div>

              <button
                className="text-xs text-white/40 hover:text-white/60"
                onClick={() => setShowAdvanced((v) => !v)}
              >
                {showAdvanced ? "▲ Hide generation & audio settings" : "▼ Generation & audio settings"}
              </button>

              {showAdvanced && (
                <div className="space-y-4 rounded-md border border-white/5 p-3">
                  {/* Generation Settings */}
                  <div>
                    <p className={SUBHEAD}>Generation Settings</p>
                    <div className="grid grid-cols-2 gap-3">
                      <Slider label="Speed" value={cfg.omnivoice.speed} min={0.5} max={1.5} step={0.05} onChange={(v) => updateOmnivoice("speed", v)} />
                      <Slider label="Steps" value={cfg.omnivoice.numStep} min={4} max={64} step={1} onChange={(v) => updateOmnivoice("numStep", Math.round(v))} />
                      <Slider label="Guidance scale" value={cfg.omnivoice.guidanceScale} min={0} max={4} step={0.1} onChange={(v) => updateOmnivoice("guidanceScale", v)} />
                    </div>
                    <div className="mt-2 flex flex-wrap gap-4">
                      <label className="flex cursor-pointer items-center gap-1.5 text-xs text-white/70">
                        <input type="checkbox" checked={cfg.omnivoice.denoise} onChange={(e) => updateOmnivoice("denoise", e.target.checked)} className="accent-[#5b8cff]" />
                        Denoise
                      </label>
                      <label className="flex cursor-pointer items-center gap-1.5 text-xs text-white/70">
                        <input type="checkbox" checked={cfg.omnivoice.preprocessPrompt} onChange={(e) => updateOmnivoice("preprocessPrompt", e.target.checked)} className="accent-[#5b8cff]" />
                        Preprocess prompt
                      </label>
                      <label className="flex cursor-pointer items-center gap-1.5 text-xs text-white/70">
                        <input type="checkbox" checked={cfg.omnivoice.postprocessOutput} onChange={(e) => updateOmnivoice("postprocessOutput", e.target.checked)} className="accent-[#5b8cff]" />
                        Postprocess output
                      </label>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-3">
                      <div>
                        <label className={LABEL}>Pad duration (s)</label>
                        <input type="number" step={0.05} min={0} className={INPUT} value={cfg.omnivoice.padDuration} onChange={(e) => updateOmnivoice("padDuration", parseFloat(e.target.value) || 0)} />
                      </div>
                      <div>
                        <label className={LABEL}>Fade duration (s)</label>
                        <input type="number" step={0.05} min={0} className={INPUT} value={cfg.omnivoice.fadeDuration} onChange={(e) => updateOmnivoice("fadeDuration", parseFloat(e.target.value) || 0)} />
                      </div>
                    </div>
                  </div>

                  {/* Advanced Controls (seed = voice identity) */}
                  <div>
                    <p className={SUBHEAD}>Advanced Controls</p>
                    <div className="mb-2">
                      <label className={LABEL}>Voice seed <span className="ml-1 text-white/30">(each seed = a distinct voice)</span></label>
                      <div className="flex gap-2">
                        <input type="number" className={INPUT} value={cfg.omnivoice.seed ?? ""} onChange={(e) => updateOmnivoice("seed", e.target.value ? parseInt(e.target.value) : null)} placeholder="random" disabled={cfg.omnivoice.randomizeSeed} min={0} max={4294967295} />
                        <button
                          className={BTN + " shrink-0"}
                          title="Roll a new random voice"
                          disabled={cfg.omnivoice.randomizeSeed}
                          onClick={() => updateOmnivoice("seed", Math.floor(Math.random() * 4294967295))}
                        >
                          🎲
                        </button>
                        <label className="flex shrink-0 cursor-pointer items-center gap-1 text-xs text-white/60">
                          <input type="checkbox" checked={cfg.omnivoice.randomizeSeed} onChange={(e) => updateOmnivoice("randomizeSeed", e.target.checked)} className="accent-[#5b8cff]" />
                          Randomize
                        </label>
                      </div>
                      {cfg.omnivoice.randomizeSeed && (
                        <p className="mt-1 text-[11px] text-amber-300/70">Randomize gives a different voice on every utterance — turn off for a consistent voice.</p>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <Slider label="T-shift" value={cfg.omnivoice.tShift} min={0.01} max={1} step={0.01} onChange={(v) => updateOmnivoice("tShift", v)} />
                      <Slider label="Layer penalty" value={cfg.omnivoice.layerPenaltyFactor} min={0} max={10} step={0.1} onChange={(v) => updateOmnivoice("layerPenaltyFactor", v)} />
                      <Slider label="Position temp." value={cfg.omnivoice.positionTemperature} min={0} max={10} step={0.1} onChange={(v) => updateOmnivoice("positionTemperature", v)} />
                      <Slider label="Class temp." value={cfg.omnivoice.classTemperature} min={0} max={2} step={0.05} onChange={(v) => updateOmnivoice("classTemperature", v)} />
                    </div>
                  </div>

                  {/* Audio Controls */}
                  <div>
                    <p className={SUBHEAD}>Audio Controls</p>
                    <div className="grid grid-cols-2 gap-3">
                      <Slider label="Pitch (semitones)" value={cfg.omnivoice.pitchSemitones} min={-12} max={12} step={0.5} onChange={(v) => updateOmnivoice("pitchSemitones", v)} />
                      <Slider label="Tempo" value={cfg.omnivoice.tempo} min={0.5} max={2} step={0.05} onChange={(v) => updateOmnivoice("tempo", v)} />
                      <Slider label="Volume" value={cfg.omnivoice.volume} min={0} max={2} step={0.05} onChange={(v) => updateOmnivoice("volume", v)} />
                    </div>
                    <label className="mt-2 flex cursor-pointer items-center gap-1.5 text-xs text-white/70">
                      <input type="checkbox" checked={cfg.omnivoice.normalize} onChange={(e) => updateOmnivoice("normalize", e.target.checked)} className="accent-[#5b8cff]" />
                      Loudness normalize
                    </label>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="space-y-1">
            <button
              className={BTN_PRIMARY}
              onClick={() => void previewVoice()}
              disabled={previewing !== "idle"}
            >
              {previewing === "fetching" ? "⏳ Synthesising…" : previewing === "playing" ? "▶ Playing…" : "▶ Preview voice"}
            </button>
            {previewError && (
              <p className="text-xs text-rose-400">{previewError}</p>
            )}
          </div>
        </div>
      </section>

      {/* Activation */}
      <section>
        <h4 className={SECTION_HEAD}>Activation</h4>
        <div className="space-y-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-white/80">
            <input type="checkbox" checked={cfg.enabled} onChange={(e) => update("enabled", e.target.checked)} className="h-4 w-4 accent-[#5b8cff]" />
            Enable voice mode
          </label>
          <div>
            <label className={LABEL}>Activation mode</label>
            <div className="flex gap-4">
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-white/70">
                <input type="radio" value="button" checked={cfg.activationMode === "button"} onChange={() => update("activationMode", "button")} className="accent-[#5b8cff]" />
                Push to talk
              </label>
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-white/70">
                <input type="radio" value="wake-word" checked={cfg.activationMode === "wake-word"} onChange={() => update("activationMode", "wake-word")} className="accent-[#5b8cff]" />
                Always on (wake word)
              </label>
            </div>
          </div>
          {cfg.activationMode === "wake-word" && (
            <>
              <div>
                <label className={LABEL}>Wake word</label>
                <input className={INPUT} value={cfg.wakeWord} onChange={(e) => update("wakeWord", e.target.value)} placeholder="hey bos" />
              </div>
              <div>
                <label className={LABEL}>
                  Awake window <span className="text-white/40">{((cfg.awakeTimeoutMs ?? 5000) / 1000).toFixed(0)}s</span>
                </label>
                <input
                  type="range"
                  min={2000}
                  max={30000}
                  step={1000}
                  value={cfg.awakeTimeoutMs ?? 5000}
                  onChange={(e) => update("awakeTimeoutMs", parseInt(e.target.value))}
                  className="w-full accent-[#5b8cff]"
                />
                <p className="mt-1 text-[11px] text-white/35">
                  How long the agent keeps listening without the wake word after a conversation turn.
                </p>
              </div>
            </>
          )}
          <label className="flex cursor-pointer items-center gap-2 text-sm text-white/80">
            <input type="checkbox" checked={cfg.speakReplies !== false} onChange={(e) => update("speakReplies", e.target.checked)} className="h-4 w-4 accent-[#5b8cff]" />
            Speak replies aloud
          </label>
          <div>
            <label className={LABEL}>
              Interruption grace period <span className="text-white/40">{(cfg.interruptGraceMs / 1000).toFixed(2)}s</span>
            </label>
            <input
              type="range"
              min={0}
              max={5000}
              step={250}
              value={cfg.interruptGraceMs}
              onChange={(e) => update("interruptGraceMs", parseInt(e.target.value))}
              className="w-full accent-[#5b8cff]"
            />
            <p className="mt-1 text-[11px] text-white/35">
              Interrupting the agent within this window after it starts speaking amends your previous
              message and resubmits it. Interrupting later sends your words as a new message instead.
            </p>
          </div>
        </div>
      </section>

      {status && (
        <p className={`text-xs ${status.startsWith("Saving") ? "text-white/50" : "text-rose-400"}`}>{status}</p>
      )}
    </div>
  );
}
