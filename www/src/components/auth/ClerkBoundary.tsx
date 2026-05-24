import type { ReactNode } from "react";
import { ClerkProvider } from "@clerk/nextjs";
import { ui } from "@clerk/ui";
import clerkUiPackage from "@clerk/ui/package.json";
import { clerkAppearance } from "@/lib/clerk";

export function ClerkBoundary({ children }: { children: ReactNode }) {
  const clerkProviderProps = {
    appearance: clerkAppearance,
    signInUrl: "/login",
    signUpUrl: "/sign-up",
    signInFallbackRedirectUrl: "/dashboard",
    signUpFallbackRedirectUrl: "/dashboard",
    ui,
    __internal_clerkUIVersion: clerkUiPackage.version,
  } as unknown as React.ComponentProps<typeof ClerkProvider>;

  return <ClerkProvider {...clerkProviderProps}>{children}</ClerkProvider>;
}
