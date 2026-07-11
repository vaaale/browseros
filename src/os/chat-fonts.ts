// Chat text font options — shared by Settings → Appearance (the picker) and the
// Assistant chat (which applies the choice as CSS variables). Framework-free so
// both client components can import it. `css` values are full font stacks; the
// Geist vars are provided by the root layout.

export interface ChatFontOption {
  id: string;
  label: string;
  css: string;
}

export const CHAT_FONTS: ChatFontOption[] = [
  { id: "system", label: "System sans", css: "var(--font-geist-sans), system-ui, sans-serif" },
  { id: "sans", label: "Grotesk / Helvetica", css: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
  { id: "serif", label: "Serif", css: "Georgia, 'Times New Roman', serif" },
  { id: "mono", label: "Monospace", css: "var(--font-geist-mono), ui-monospace, monospace" },
];

/** Resolve a font id to its CSS font stack (falls back to the first option). */
export function chatFontCss(id: string): string {
  return CHAT_FONTS.find((f) => f.id === id)?.css ?? CHAT_FONTS[0].css;
}

/** Selectable "normal" chat text sizes, in px. */
export const CHAT_FONT_SIZES = [12, 13, 14, 15, 16, 18, 20];
