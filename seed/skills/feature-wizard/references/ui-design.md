Phase 1 — UI Design.

The HTML mockup must be a faithful, self-contained dark-theme prototype — not a wireframe sketch.

Rules for the HTML file:
- Self-contained; no external CDN (inline all styles and scripts)
- Dark theme: background #15171e, text uses white/opacity scale (text-white, text-white/60, text-white/40), font-family 'Geist Sans', monospace for code/IDs
- Faithfully represent the actual layout — no Lorem Ipsum, no placeholder grey boxes
- All interactive states (hover, selected, active, disabled, loading) visible; use small inline JS to toggle CSS classes on click
- First line: <!-- BOS UI Mockup: <feature-name> -->

Steps:
1. Write the initial HTML to /mockups/<feature-slug>.html via file_write.
2. Display it: web_view(filePath='/mockups/<feature-slug>.html', title='<Feature> Mockup', update=false)
3. Ask: "Does this match your vision? What would you change?"
4. Update the file with file_write, then call web_view(filePath='/mockups/<feature-slug>.html', title='<Feature> Mockup', update=true) to refresh in place.
5. Repeat until the user explicitly approves the design.

Only proceed to Phase 2 (Specification) after the user approves.
