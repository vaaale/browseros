import { getSettings } from "@/os/settings";
import { BUILTIN_APPS } from "@/os/apps";
import { listInstalledManifests } from "@/lib/apps/store";
import { OSProvider } from "@/store/os-provider";
import { Desktop } from "@/components/desktop/Desktop";
import { LoggingInit } from "@/components/LoggingInit";

// The OS reads live settings on every request, so render dynamically.
export const dynamic = "force-dynamic";

export default async function Page() {
  const [settings, installed] = await Promise.all([getSettings(), listInstalledManifests()]);
  const apps = [...BUILTIN_APPS, ...installed];
  return (
    <OSProvider settings={settings} apps={apps}>
      {/* No global CopilotKit provider: each chat surface (the Assistant app, the
          Build Studio embed) mounts its OWN provider so they have independent
          agents, threads, and conversation groups (012-embeddable-assistant). */}
      <LoggingInit />
      <Desktop />
    </OSProvider>
  );
}
