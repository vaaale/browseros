import { registerPlugin } from "@/lib/plugins/registry";
import compactionPlugin from "./index";

// Register the default compaction plugin at module load time.
// This runs when the init module is imported (lazy — only when plugins load).

registerPlugin(compactionPlugin);
