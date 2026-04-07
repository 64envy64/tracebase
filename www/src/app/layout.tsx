import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "TraceBase — The reasoning reuse layer for AI agents",
  description:
    "Every successful agent run captures a reasoning trace. Every future run draws from it, so agents get more reliable and cheaper over time.",
  keywords: ["AI agents", "reasoning", "institutional memory", "LLM", "token optimization", "MCP"],
  openGraph: {
    title: "TraceBase",
    description: "The reasoning reuse layer for AI agents",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
