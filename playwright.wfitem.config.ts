import base from "./playwright.config";

const URL = "http://localhost:3056";

export default {
  ...base,
  testDir: "./specs/user-specs/workflow-manager/001-workflow-manager-service-tools/e2e",
  projects: [{ name: "chromium" }],
  use: { ...base.use, baseURL: URL },
  webServer: {
    ...base.webServer,
    url: URL,
    reuseExistingServer: true,
  },
};
