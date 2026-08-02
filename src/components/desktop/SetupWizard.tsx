"use client";

import { useEffect, useState } from "react";
import { PROVIDERS, type ProviderType } from "@/lib/agent/provider-meta";
import { WizardShell } from "./setup-wizard/WizardShell";
import { Step1AiProvider } from "./setup-wizard/Step1AiProvider";
import { Step2DevHarness } from "./setup-wizard/Step2DevHarness";
import { Step3DataIsolation } from "./setup-wizard/Step3DataIsolation";
import { Step4GitRepos } from "./setup-wizard/Step4GitRepos";
import { Step5Marketplace } from "./setup-wizard/Step5Marketplace";
import { Step6SettingUp } from "./setup-wizard/Step6SettingUp";
import type { WizardStep, Step4Values, MarketplaceRow } from "./setup-wizard/wizard-types";

const DEFAULT_REPOS: Step4Values = {
  bosSource: { url: "https://github.com/vaaale/browseros.git", branch: "main" },
  bosSpecs: { url: "https://github.com/vaaale/bos-specs.git", branch: "master" },
  userApps: { url: "", branch: "" },
};

const DEFAULT_MARKETPLACES: MarketplaceRow[] = [
  { name: "BOS Central marketplace", url: "https://github.com/vaaale/bos-marketplace.git", checked: true },
  { name: "Claude Superskills", url: "https://github.com/ericgandrade/claude-superskills.git", checked: false },
  { name: "Anthropic Skills", url: "https://github.com/anthropics/skills.git", checked: false },
];

export function SetupWizard() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<WizardStep>(1);

  // Step 1
  const [provider, setProvider] = useState<ProviderType>("anthropic");
  const [model, setModel] = useState(PROVIDERS.anthropic.defaultModel);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [availableModels, setAvailableModels] = useState<string[]>([]);

  // Step 4
  const [repos, setRepos] = useState<Step4Values>(DEFAULT_REPOS);

  // Step 5
  const [marketplaces, setMarketplaces] = useState<MarketplaceRow[]>(DEFAULT_MARKETPLACES);

  useEffect(() => {
    fetch("/api/system/setup")
      .then((r) => r.json())
      .then((d: { firstRun?: boolean }) => setOpen(!!d.firstRun))
      .catch(() => {});
  }, []);

  const canNext = step === 1 ? !!provider : true;

  const handleBack = () => setStep((s) => (Math.max(1, s - 1) as WizardStep));
  const handleNext = () => setStep((s) => (Math.min(6, s + 1) as WizardStep));

  if (!open) return null;

  return (
    <WizardShell step={step} canNext={canNext} onBack={handleBack} onNext={handleNext}>
      {step === 1 && (
        <Step1AiProvider
          provider={provider}
          model={model}
          baseUrl={baseUrl}
          apiKey={apiKey}
          availableModels={availableModels}
          onProvider={setProvider}
          onModel={setModel}
          onBaseUrl={setBaseUrl}
          onApiKey={setApiKey}
          onAvailableModels={setAvailableModels}
        />
      )}
      {step === 2 && <Step2DevHarness />}
      {step === 3 && <Step3DataIsolation />}
      {step === 4 && <Step4GitRepos repos={repos} onChange={setRepos} />}
      {step === 5 && <Step5Marketplace marketplaces={marketplaces} onChange={setMarketplaces} />}
      {step === 6 && (
        <Step6SettingUp
          provider={provider}
          model={model}
          baseUrl={baseUrl}
          apiKey={apiKey}
          repos={repos}
          marketplaces={marketplaces}
          onComplete={() => setOpen(false)}
        />
      )}
    </WizardShell>
  );
}
