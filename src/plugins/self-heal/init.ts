import { registerPlugin } from "@/lib/plugins/registry";
import selfHealPlugin from "./index";

// Register the self-heal trigger plugin at module load time, the same way the
// compaction and memory plugins do. Importing this module registers; it does
// NOT initialize — src/instrumentation.ts's activation pass handles that, so a
// user who deactivates the plugin in Settings keeps it deactivated.

registerPlugin(selfHealPlugin);
