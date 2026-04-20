"use client";

import { GlobalLoadingProvider } from "@/components/providers/GlobalLoadingProvider";

export function AppProviders({ children }: { children: React.ReactNode }) {
  return <GlobalLoadingProvider>{children}</GlobalLoadingProvider>;
}
