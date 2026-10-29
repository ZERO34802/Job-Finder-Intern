import type { Metadata } from "next";
import { Fraunces, IBM_Plex_Sans } from "next/font/google";
import { Nav } from "@/components/Nav";
import { ollamaStatus } from "@/lib/classify";
import "./globals.css";

const sans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-sans" });
const display = Fraunces({ subsets: ["latin"], weight: ["600"], variable: "--font-display" });

export const metadata: Metadata = {
  title: "Intern Finder",
  description: "Poll public ATS boards, classify titles, and track applications.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const ollama = await ollamaStatus();
  const store = process.env.STORE === "supabase" ? "Supabase" : "SQLite on this Mac";
  const classifier = ollama.ok ? ollama.model : `rules (${ollama.reason})`;
  const discord = process.env.DISCORD_WEBHOOK_URL ? "Discord on" : "Discord off";
  return (
    <html lang="en" className={`${sans.variable} ${display.variable}`}>
      <body>
        <div className="shell">
          <header className="top">
            <a className="brand" href="/">
              Intern Finder
            </a>
            <Nav />
          </header>
          {children}
          <p className="statusline">
            {store} · classifier {classifier} · {discord}
          </p>
        </div>
      </body>
    </html>
  );
}
