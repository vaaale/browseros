import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

// Voice output is ONE setting with three values (036 FR-001..FR-006), driven by
// the speaker and video buttons beside the microphone, and useVoice is the ONE
// producer of speech (033 §9a). Both properties are regression tests for real
// bugs: a second passive TTS player disagreed with useVoice about whether TTS was
// on, so replies were spoken with the setting off — and synthesized twice when
// both agreed it was on.
const script = (turns: unknown[]) => `@@e2e ${JSON.stringify({ turns })}`;

type OutputMode = "off" | "audio" | "avatar";

const REPLY = "First sentence here. Second sentence here.";

async function setOutput(request: APIRequestContext, voiceOutput: OutputMode): Promise<void> {
  const res = await request.patch("/api/voice", { data: { patch: { voiceOutput } } });
  expect(res.ok()).toBeTruthy();
}

/** Stub the TTS route (no synth backend needed) and record every text it is
 *  asked to speak, so duplicates are visible. */
async function captureTTS(page: Page): Promise<string[]> {
  const spoken: string[] = [];
  await page.route("**/api/voice/tts", async (route) => {
    const body = route.request().postDataJSON() as { text?: string };
    spoken.push(body.text ?? "");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, durationMs: 10, audioUrl: null }),
    });
  });
  return spoken;
}

async function openAssistantOnFreshConversation(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByText("Assistant", { exact: true }).first().dblclick({ timeout: 20000 });
  await expect(page.getByTestId("assistant-v2")).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("chat-textarea")).toBeVisible({ timeout: 15000 });
  await page.getByTitle(/New .*conversation/i).first().click();
  await page.waitForTimeout(400);
}

async function runScriptedReply(page: Page, turn: Record<string, unknown> = {}): Promise<void> {
  await page.getByTestId("chat-textarea").fill(script([{ text: REPLY, ...turn }]));
  await page.getByTestId("chat-send-button").click();
  await expect(page.getByTestId("chat-stop-button")).toHaveCount(0, { timeout: 60000 });
  await expect(page.getByTestId("assistant-message").last()).toContainText("Second sentence", { timeout: 10000 });
}

async function readOutput(request: APIRequestContext): Promise<OutputMode> {
  const { config } = await request.get("/api/voice").then((r) => r.json()) as {
    config: { voiceOutput: OutputMode };
  };
  return config.voiceOutput;
}

test.describe("Voice — the speaker and video toggles own output", () => {
  // The toggles are server-side config, so these tests would fight over it.
  test.describe.configure({ mode: "serial" });

  let restore: OutputMode;

  test.beforeAll(async ({ request }) => {
    restore = await readOutput(request);
  });

  test.afterAll(async ({ request }) => {
    await setOutput(request, restore);
  });

  test("speaker off: a reply is never synthesized", async ({ page, request }) => {
    await setOutput(request, "off");
    const spoken = await captureTTS(page);
    await openAssistantOnFreshConversation(page);

    const speaker = page.getByTestId("voice-speaker-toggle");
    await expect(speaker).toHaveAttribute("aria-pressed", "false");

    await runScriptedReply(page);
    await page.waitForTimeout(1500); // give a stray producer time to fire
    expect(spoken).toEqual([]);
  });

  test("speaker on: every sentence is synthesized exactly once", async ({ page, request }) => {
    await setOutput(request, "off");
    const spoken = await captureTTS(page);
    await openAssistantOnFreshConversation(page);

    await page.getByTestId("voice-speaker-toggle").click();
    await expect(page.getByTestId("voice-speaker-toggle")).toHaveAttribute("aria-pressed", "true");

    await runScriptedReply(page);
    await expect.poll(() => spoken.length, { timeout: 15000 }).toBeGreaterThan(0);
    await page.waitForTimeout(1500); // let a duplicate arrive if one is coming

    // Nothing spoken twice, and the whole reply spoken once.
    expect(new Set(spoken).size).toBe(spoken.length);
    expect(spoken.join(" ").replace(/\s+/g, " ").trim()).toBe(REPLY);
  });

  // The path above delivers the reply in one delta. A real model streams it, so
  // sentences leave for TTS while the run is still going — and the finalized
  // message must not then repeat them.
  test("streamed reply: sentences are spoken as they arrive, and only once", async ({ page, request }) => {
    await setOutput(request, "audio");
    const spoken = await captureTTS(page);
    await openAssistantOnFreshConversation(page);
    await expect(page.getByTestId("voice-speaker-toggle")).toHaveAttribute("aria-pressed", "true");

    await runScriptedReply(page, { deltas: 12, delayMs: 60 });
    await expect.poll(() => spoken.length, { timeout: 15000 }).toBe(2);
    await page.waitForTimeout(1500);

    expect(spoken).toEqual(["First sentence here.", "Second sentence here."]);
  });

  test("video on opens the face and turns audio on; off leaves audio on", async ({ page, request }) => {
    await setOutput(request, "off");
    await captureTTS(page);
    await openAssistantOnFreshConversation(page);

    const video = page.getByTestId("voice-video-toggle");
    // Only rendered when an engine declares a surface (FR-006).
    if (await video.count() === 0) test.skip(true, "no voice engine declares a presence surface");

    await video.click();
    await expect(page.getByTestId("window-presence")).toBeVisible({ timeout: 15000 });
    // Video implies audio: the speaker reads as on, and there is no state where a
    // face is up with output off (FR-002/FR-003).
    await expect(page.getByTestId("voice-speaker-toggle")).toHaveAttribute("aria-pressed", "true");
    expect(await readOutput(request)).toBe("avatar");

    await video.click();
    await expect(page.getByTestId("window-presence")).toHaveCount(0, { timeout: 10000 });
    expect(await readOutput(request)).toBe("audio");
    await expect(page.getByTestId("voice-speaker-toggle")).toHaveAttribute("aria-pressed", "true");
  });

  test("speaker off while the face is up takes the face down too", async ({ page, request }) => {
    await setOutput(request, "off");
    await openAssistantOnFreshConversation(page);
    const video = page.getByTestId("voice-video-toggle");
    if (await video.count() === 0) test.skip(true, "no voice engine declares a presence surface");

    await video.click();
    await expect(page.getByTestId("window-presence")).toBeVisible({ timeout: 15000 });

    await page.getByTestId("voice-speaker-toggle").click();
    await expect(page.getByTestId("window-presence")).toHaveCount(0, { timeout: 10000 });
    expect(await readOutput(request)).toBe("off");
  });

  test("closing the presence window falls back to audio (FR-004)", async ({ page, request }) => {
    await setOutput(request, "off");
    await openAssistantOnFreshConversation(page);
    const video = page.getByTestId("voice-video-toggle");
    if (await video.count() === 0) test.skip(true, "no voice engine declares a presence surface");

    await video.click();
    const win = page.getByTestId("window-presence");
    await expect(win).toBeVisible({ timeout: 15000 });

    await win.getByLabel("Close").click();
    await expect(win).toHaveCount(0);
    await expect.poll(() => readOutput(request), { timeout: 10000 }).toBe("audio");
    // And it must not immediately reopen itself.
    await page.waitForTimeout(1000);
    await expect(win).toHaveCount(0);
  });

  test("a face that never renders does not swallow the reply (FR-013/SC-003)", async ({ page, request }) => {
    await setOutput(request, "avatar");
    const spoken = await captureTTS(page);
    await openAssistantOnFreshConversation(page);
    if (await page.getByTestId("voice-video-toggle").count() === 0) {
      test.skip(true, "no voice engine declares a presence surface");
    }

    // With no avatar server reachable the surface can't play, so no presence
    // lease is ever taken and audio has to come back to the browser.
    await runScriptedReply(page);
    await expect.poll(() => spoken.length, { timeout: 15000 }).toBeGreaterThan(0);
  });

  test("a fresh load never restores the face (FR-005)", async ({ page, request }) => {
    await setOutput(request, "avatar");
    await page.goto("/");
    await expect(page.getByTestId("desktop")).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("window-presence")).toHaveCount(0);
    await expect.poll(() => readOutput(request), { timeout: 10000 }).toBe("audio");
  });
});
