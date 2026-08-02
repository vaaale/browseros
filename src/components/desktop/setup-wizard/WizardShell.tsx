"use client";

import { Sparkles } from "lucide-react";
import type { WizardStep } from "./wizard-types";

interface WizardShellProps {
  step: WizardStep;
  canNext: boolean;
  onBack: () => void;
  onNext: () => void;
  children: React.ReactNode;
}

const STEPS: { label: string; sub: string }[] = [
  { label: "1", sub: "AI Provider" },
  { label: "2", sub: "Dev Harness" },
  { label: "3", sub: "Data Isolation" },
  { label: "4", sub: "Repositories" },
  { label: "5", sub: "Marketplace" },
];

export function WizardShell({ step, canNext, onBack, onNext, children }: WizardShellProps) {
  const isSettingUp = step === 6;

  return (
    <div className="fixed inset-0 z-[200000] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="flex h-[92vh] max-h-[860px] w-[840px] max-w-[96vw] flex-col rounded-2xl border border-white/10 bg-[#15171e] shadow-2xl">

        {/* Header */}
        <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-6 py-4">
          <Sparkles size={16} className="text-violet-300" />
          <h2 className="text-sm font-semibold">
            {isSettingUp ? "Setting up BrowserOS…" : "Welcome to BrowserOS"}
          </h2>
          {!isSettingUp && (
            <span className="ml-auto text-xs text-white/40">Step {step} of 5</span>
          )}
        </div>

        {/* Step indicator — visible on steps 1–5 only */}
        {!isSettingUp && (
          <div className="flex shrink-0 items-center px-8 py-3 border-b border-white/10">
            {STEPS.map((s, i) => {
              const sNum = (i + 1) as WizardStep;
              const active = sNum === step;
              const done = sNum < step;
              return (
                <div key={sNum} className="flex items-center">
                  {i > 0 && (
                    <div className={`h-px w-12 ${done ? "bg-violet-500/50" : "bg-white/10"}`} />
                  )}
                  <div className="flex flex-col items-center gap-0.5">
                    <div className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold
                      ${active ? "bg-violet-500 text-white" : done ? "bg-violet-500/30 text-violet-300" : "bg-white/10 text-white/30"}`}>
                      {done ? "✓" : s.label}
                    </div>
                    <span className={`text-[9px] whitespace-nowrap ${active ? "text-white/70" : "text-white/30"}`}>
                      {s.sub}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto p-6 text-sm">
          {children}
        </div>

        {/* Footer nav — hidden on step 6 */}
        {!isSettingUp && (
          <div className="flex shrink-0 items-center justify-between border-t border-white/10 px-6 py-4">
            <button
              onClick={onBack}
              disabled={step === 1}
              className="rounded px-4 py-1.5 text-xs text-white/50 hover:bg-white/10 disabled:pointer-events-none disabled:opacity-30"
            >
              Back
            </button>
            <button
              onClick={onNext}
              disabled={!canNext}
              className="rounded bg-violet-500/30 px-5 py-1.5 text-xs font-medium text-violet-100 hover:bg-violet-500/40 disabled:pointer-events-none disabled:opacity-30"
            >
              {step === 5 ? "Finish & Set Up" : "Next →"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
