"use client";

import { useCallback, useEffect, useState } from "react";
import { UserCircle } from "lucide-react";

interface ProfileMeta {
  id: string;
  name: string;
}

export function ProfileSelector() {
  const [profiles, setProfiles] = useState<ProfileMeta[]>([]);
  const [active, setActive] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/assistant/profile").then((r) => r.json());
    setProfiles(res.profiles ?? []);
    setActive(res.active ?? "");
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onChange = async (id: string) => {
    setActive(id);
    await fetch("/api/assistant/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: id }),
    });
  };

  return (
    <label className="flex items-center gap-1.5 text-xs text-white/60" title="Active personality profile">
      <UserCircle size={14} className="text-white/50" />
      <select
        value={active}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-white/10 bg-black/30 px-1.5 py-1 text-xs text-white/85 outline-none focus:border-white/30"
      >
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
    </label>
  );
}
