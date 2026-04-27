import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { ui } from "@clerk/ui";
import clerkUiPackage from "@clerk/ui/package.json";
import { Geist, Geist_Mono, Newsreader } from "next/font/google";
import { AppProviders } from "@/components/providers/AppProviders";
import { clerkAppearance } from "@/lib/clerk";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const heroSerif = Newsreader({
  variable: "--font-hero-serif",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "tracebase.ink — Every run, written in ink.",
  description:
    "Reasoning runtime for autonomous agents. Remembers past solutions, catches doom-loops, trims redundant tool calls, folds long contexts. Drop-in — no agent rewrites.",
  keywords: [
    "AI agents",
    "reasoning runtime",
    "agent memory",
    "loop detection",
    "tool supervision",
    "context compression",
    "MCP",
  ],
  openGraph: {
    title: "tracebase.ink",
    description: "Reasoning runtime for autonomous agents. Every run, written in ink.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const clerkProviderProps = {
    appearance: clerkAppearance,
    ui,
    __internal_clerkUIVersion: clerkUiPackage.version,
  } as unknown as React.ComponentProps<typeof ClerkProvider>;

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${heroSerif.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <ClerkProvider {...clerkProviderProps}>
          <AppProviders>{children}</AppProviders>
        </ClerkProvider>
      </body>
    </html>
  );
}
