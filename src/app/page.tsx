import { getSettings } from "@/os/settings";
import { BUILTIN_APPS } from "@/os/apps";
import { listInstalledManifests } from "@/lib/apps/store";
import { OSProvider } from "@/store/os-provider";
import { CopilotProvider } from "@/components/agent/CopilotProvider";
import { Desktop } from "@/components/desktop/Desktop";

// The OS reads live settings on every request, so render dynamically.
export const dynamic = "force-dynamic";

export default async function Page() {
  const [settings, installed] = await Promise.all([getSettings(), listInstalledManifests()]);
  const apps = [...BUILTIN_APPS, ...installed];
  return (
    <OSProvider settings={settings} apps={apps}>
      <CopilotProvider>
        <Desktop />
      </CopilotProvider>
    </OSProvider>
  );
}
