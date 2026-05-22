import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { ui } from "@clerk/ui";
import clerkUiPackage from "@clerk/ui/package.json";
import { headers } from "next/headers";
import { Geist, Geist_Mono, Newsreader } from "next/font/google";
import { AppProviders } from "@/components/providers/AppProviders";
import { InkIntro } from "@/components/landing/brand/InkIntro";
import { clerkAppearance } from "@/lib/clerk";
import { isDemoModeFromEnv } from "@/lib/demo/demo-mode";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const heroSerif = Newsreader({
  variable: "--font-hero-serif",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "tracebase.ink - Agents that learn from every run.",
  description:
    "TraceBase turns solved work into reusable memory, so production agents carry what worked into the next task.",
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
    description: "Agents that learn from every run.",
    type: "website",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const requestHeaders = await headers();
  const demoMode = isDemoModeFromEnv() || requestHeaders.get("x-tracebase-demo") === "1";
  const clerkProviderProps = {
    appearance: clerkAppearance,
    signInUrl: "/login",
    signUpUrl: "/sign-up",
    signInFallbackRedirectUrl: "/dashboard",
    signUpFallbackRedirectUrl: "/dashboard",
    ui,
    __internal_clerkUIVersion: clerkUiPackage.version,
  } as unknown as React.ComponentProps<typeof ClerkProvider>;

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${heroSerif.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {demoMode ? null : <InkIntro />}
        {demoMode ? (
          <AppProviders>{children}</AppProviders>
        ) : (
          <ClerkProvider {...clerkProviderProps}>
            <AppProviders>{children}</AppProviders>
          </ClerkProvider>
        )}
      </body>
    </html>
  );
}
