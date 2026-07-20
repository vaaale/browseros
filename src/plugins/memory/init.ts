import { registerPlugin } from "@/lib/plugins/registry";
import memoryPlugin from "./index";

// Register the default memory plugin at module load time.
registerPlugin(memoryPlugin);
