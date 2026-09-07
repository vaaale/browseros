import type { AppManifest } from "@/os/types";

const manifest: AppManifest = {
  id: "html-viewer",
  name: "HTML Preview",
  icon: "Code2",
  defaultWidth: 900,
  defaultHeight: 640,
  builtin: true,
  hidden: true,
  // 036-file-type-handlers: web_view IS the default HTML renderer. Declaring it
  // here rather than special-casing it in the Files app is the whole point —
  // "double-click an .html file opens a rendered preview" falls out of the
  // generic registry. `url: "raw"` hands this component the file's bytes URL,
  // which its <iframe src> already knows how to render (no code change).
  fileHandlers: [
    {
      type: "text/html",
      capabilities: ["render"],
      label: "Web View",
      default: true,
      paramShape: { url: "raw", title: "basename" },
    },
  ],
};

export default manifest;
