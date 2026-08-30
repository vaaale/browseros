# Previewing content (`web_view`)

When the assistant wants to **show** you something rather than describe it, it uses
a tool called **`web_view`**. It opens a small preview window on your desktop — an
ordinary BOS window with a titlebar, close button, and resize handles — containing
a web page, an image, or a video.

You never call the tool yourself. You just ask ("show me that chart", "open the
mockup", "play the clip you found") and the window appears.

---

## What it can preview

- **HTML documents** — a mockup the assistant just wrote, a report, a page from
  your files. Shown in a sandboxed frame: the page can run its own scripts, but it
  cannot reach into BrowserOS.
- **Images** — `png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`, `avif`. Shown centered
  and scaled to fit the window, on a neutral dark background, so a wide chart or a
  tall screenshot is fully visible without cropping or scrolling.
- **Video** — `mp4`, `webm`, `mov`, `ogv`, `m4v`, `avi`. Shown as a player with the
  normal browser controls: play/pause, a seek bar, volume, and fullscreen.

The content can come from **your files** (any path in the Files app, such as
`/Pictures/chart.png`), from a **web address**, or be **generated on the spot** by
the assistant.

A web address doesn't have to *look* like a file to be recognised. Some servers
hand out media through a generic endpoint that names the file in the address's
parameters instead — `http://my-server:8188/view?filename=clip.mp4&type=output`.
Those are detected too, and the window is titled with the real filename
(`clip.mp4`) rather than the endpoint name.

Media from a web address is fetched **through BrowserOS** rather than by the
window directly. You won't notice — it's the same picture and the same player,
seek bar included — but it's what lets a clip from a plain `http://` machine on
your own network (a render box, a camera) play inside a BrowserOS page served
over `https://`, which browsers would otherwise refuse to show.

Resize the window and the image or video re-fits itself. Large videos stream as
they play rather than downloading in full first, so a long clip is playable
immediately.

---

## Playback options

For video, the assistant can set a few options when it opens the preview. Ask for
them in plain language — "loop it", "start it muted", "autoplay it".

| Option | What it does |
| --- | --- |
| **poster** | An image shown in the player before playback starts — a thumbnail or title frame instead of a black rectangle. |
| **autoplay** | Starts playing as soon as the window opens, without you pressing play. |
| **loop** | Restarts from the beginning each time the video ends. |
| **muted** | Starts with the audio off. You can unmute from the player's volume control. |

**About autoplay:** browsers only allow a video to start on its own if it is also
**muted** — that's a browser rule, not a BOS setting. So "autoplay and loop this
clip" works when it's muted; if the assistant asks for autoplay *with* sound, the
player simply waits for you to press play. Ask for "autoplay, muted" if you want
it to start by itself.

These options apply to video only; they're ignored for an image or an HTML page.

---

## Refreshing a preview in place

When the assistant is iterating — tweaking a mockup, regenerating a chart — it can
**reuse the existing preview window** instead of opening a new one each time. You'll
see the same window update rather than a pile of windows stacking up on your
desktop. The new version is always re-fetched, so you never see a stale image.

---

## When something can't be shown

- **The file isn't there** (wrong path, or a file that only exists on a feature
  branch the conversation isn't using) — no window opens. The assistant is told the
  preview failed and will say so, instead of claiming it showed you something.
- **The browser can't play it** (an unusual video codec, a damaged file, a web
  address that no longer works) — the window opens and shows a centered message,
  **"Could not load: *filename*"**, with a short note about why. If it's a video
  that won't play, converting it to `mp4` or `webm` usually fixes it.

---

## Related

- [Using the Assistant](./using-the-assistant.md) — the chat, panels, and how the
  assistant shows its work.
- [Files](../apps/files.md) — where the previewed files live.
