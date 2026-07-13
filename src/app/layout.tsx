import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "BrowserOS",
  description: "An agentic operating system in your browser.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        {/* Material Symbols icon font — backs the `material-symbols-outlined`
            class used by the UI Preview A2UI catalog's Icon component
            (src/apps/ui-preview/catalog.tsx). Without it, Icon ligatures like
            "check" render as raw text instead of a glyph. `display=block` hides
            the text until the glyph font loads, avoiding a flash of the raw
            ligature name. This is the App Router root layout (the global head),
            so the no-page-custom-font rule — which targets the pages/ router —
            does not apply. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* `display=block` is deliberate for an icon font (a swap/optional
            fallback would flash the raw ligature text, e.g. "check"); the
            no-page-custom-font rule targets the pages/ router, not this App
            Router root-layout head. Both Next heuristics are wrong here. */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font, @next/next/google-font-display */}
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=block" />
      </head>
      <body className="h-full overflow-hidden bg-black text-white" suppressHydrationWarning>{children}</body>
    </html>
  );
}
