"use client";

import type { AppProps } from "./types";

// Renders a runtime-installed app served from the VFS at /apps/<id>/.
export function IframeApp({ params }: AppProps) {
  const url = typeof params?.url === "string" ? params.url : "about:blank";
  return (
    <iframe
      src={url}
      className="h-full w-full border-0 bg-white"
      sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
      title="Installed app"
    />
  );
}
