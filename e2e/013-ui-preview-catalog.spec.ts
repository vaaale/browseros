import { test, expect } from "./fixtures";

// Regression test for BOS's custom dark-themed A2UI catalog
// (src/apps/ui-preview/catalog.tsx). Pushes a HANDCRAFTED operations envelope
// (not LLM-generated, so this is deterministic) exercising every basic-catalog
// component name so a future library upgrade or schema mismatch surfaces here
// instead of only in a live design session. Asserts no "Catalog not found" /
// processMessages error ever reaches the console.

const script = (turns: unknown[]) => `@@e2e ${JSON.stringify({ turns })}`;

const CATALOG_ID = "https://a2ui.org/specification/v0_9/basic_catalog.json";

const operations = [
  { version: "v0.9", createSurface: { surfaceId: "smoke-surface", catalogId: CATALOG_ID } },
  {
    version: "v0.9",
    updateComponents: {
      surfaceId: "smoke-surface",
      components: [
        { id: "root", component: "Column", children: ["heading", "actions", "card", "divider", "tabs"] },
        { id: "heading", component: "Text", text: "Design smoke test", variant: "h1" },
        { id: "actions", component: "Row", children: ["btnPrimary", "btnDefault", "btnBorderless"] },
        { id: "btnPrimary", component: "Button", variant: "primary", action: { name: "noop" }, child: "btnPrimaryLabel" },
        { id: "btnPrimaryLabel", component: "Text", text: "Save" },
        { id: "btnDefault", component: "Button", action: { name: "noop" }, child: "btnDefaultLabel" },
        { id: "btnDefaultLabel", component: "Text", text: "Cancel" },
        { id: "btnBorderless", component: "Button", variant: "borderless", action: { name: "noop" }, child: "btnBorderlessLabel" },
        { id: "btnBorderlessLabel", component: "Text", text: "Skip" },
        { id: "card", component: "Card", child: "cardBody" },
        {
          id: "cardBody",
          component: "Column",
          children: ["field", "check", "slider", "choices", "date"],
        },
        { id: "field", component: "TextField", label: "Name", value: "" },
        { id: "check", component: "CheckBox", label: "Subscribe to updates", value: true },
        { id: "slider", component: "Slider", label: "Volume", min: 0, max: 100, value: 40 },
        {
          id: "choices",
          component: "ChoicePicker",
          label: "Tags",
          displayStyle: "chips",
          value: ["b"],
          options: [
            { value: "a", label: "Alpha" },
            { value: "b", label: "Beta" },
            { value: "c", label: "Gamma" },
          ],
        },
        { id: "date", component: "DateTimeInput", label: "Due date", enableDate: true, enableTime: false, value: "2026-07-11" },
        { id: "divider", component: "Divider", axis: "horizontal" },
        { id: "tabs", component: "Tabs", tabs: [{ title: "One", child: "tabOne" }, { title: "Two", child: "tabTwo" }] },
        { id: "tabOne", component: "Text", text: "First tab content", variant: "caption" },
        { id: "tabTwo", component: "Text", text: "Second tab content", variant: "caption" },
      ],
    },
  },
];

test.describe("UI Preview catalog rendering", () => {
  test("renders every basic-catalog component via BOS's custom catalog without error", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warning") consoleErrors.push(msg.text());
    });

    await page.getByText("Assistant", { exact: true }).first().dblclick({ timeout: 20000 });
    await expect(page.getByTestId("assistant-v2")).toBeVisible({ timeout: 20000 });
    const textarea = page.getByTestId("chat-textarea");
    await expect(textarea).toBeVisible({ timeout: 15000 });

    // Push the handcrafted envelope through ui_preview_generate's `@@e2e`
    // deterministic bypass (see src/lib/a2ui/service.ts) so this stays an
    // LLM-free catalog-rendering smoke test now that raw operations no longer
    // have their own tool.
    await textarea.fill(
      script([
        { text: "opening UI Preview", tools: [{ name: "ui_preview_open", args: {} }] },
        { text: "rendering the smoke test", tools: [{ name: "ui_preview_generate", args: { description: `@@e2e ${JSON.stringify({ operations })}` } }] },
        { text: "Done." },
      ]),
    );
    await page.getByTestId("chat-send-button").click();

    const win = page.getByTestId("window-ui-preview");
    await expect(win).toBeVisible({ timeout: 20000 });
    await expect(win.getByText("Design smoke test")).toBeVisible({ timeout: 10000 });
    await expect(win.getByText("First tab content")).toBeVisible();

    expect(consoleErrors.some((e) => /catalog not found|processmessages error/i.test(e))).toBe(false);
  });
});
