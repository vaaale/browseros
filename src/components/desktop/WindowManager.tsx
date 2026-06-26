"use client";

import { useOSStore } from "@/store/os-provider";
import { Window } from "./Window";

export function WindowManager() {
  const windows = useOSStore((s) => s.windows);
  return (
    <>
      {windows.map((win) => (
        <Window key={win.id} win={win} />
      ))}
    </>
  );
}
