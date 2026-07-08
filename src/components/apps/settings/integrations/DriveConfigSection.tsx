"use client";

import { Info } from "lucide-react";

/**
 * Informational card rendered above the scope toggles on the Drive service
 * config page. Explains the two scope choices so users understand which
 * one to grant.
 */
export function DriveConfigSection() {
  return (
    <section className="rounded-lg border border-violet-400/20 bg-violet-500/[0.06] p-3.5">
      <div className="flex items-start gap-2.5">
        <Info size={14} className="mt-0.5 shrink-0 text-violet-300" />
        <div className="space-y-1.5 text-[12px] leading-relaxed text-white/80">
          <p className="font-medium text-white/90">Drive access levels</p>
          <ul className="space-y-1 text-[11.5px] text-white/70">
            <li>
              <span className="font-mono text-white/90">drive.readonly</span> — see every
              file in your Drive. Broader but simpler.
            </li>
            <li>
              <span className="font-mono text-white/90">drive.file</span> — access only
              files this app opens or creates. Safer, but you must open a file explicitly
              before the assistant can see it.
            </li>
          </ul>
          <p className="text-[11px] text-white/50">
            Grant only what you need — you can toggle scopes off later without disconnecting.
          </p>
        </div>
      </div>
    </section>
  );
}
