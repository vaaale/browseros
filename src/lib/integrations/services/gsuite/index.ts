// Side-effect module: registers the GSuite manifest with the integrations
// registry at import time. The parent barrel `src/lib/integrations/index.ts`
// imports this file so any consumer of the barrel triggers registration.

import { registerIntegration } from "../../registry";
import { GSUITE_MANIFEST } from "./manifest";

registerIntegration(GSUITE_MANIFEST);

export { GSUITE_MANIFEST, GMAIL_SCOPES } from "./manifest";
