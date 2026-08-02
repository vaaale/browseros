export type WizardStep = 1 | 2 | 3 | 4 | 5 | 6;

export interface Step4Values {
  bosSource: { url: string; branch: string };
  bosSpecs: { url: string; branch: string };
  userApps: { url: string; branch: string };
}

export interface MarketplaceRow {
  name: string;
  url: string;
  checked: boolean;
}

export type OperationStatus = "pending" | "running" | "ok" | "failed";

export interface SetupOperation {
  id: string;
  label: string;
  status: OperationStatus;
  error?: string;
}
