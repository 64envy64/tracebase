import type { ReactNode } from "react";
import { ClerkProvider } from "@clerk/nextjs";
import { clerkAppearance } from "@/lib/clerk";

export function ClerkBoundary({ children }: { children: ReactNode }) {
  const clerkProviderProps = {
    appearance: clerkAppearance,
    signInUrl: "/login",
    signUpUrl: "/sign-up",
    signInFallbackRedirectUrl: "/dashboard",
    signUpFallbackRedirectUrl: "/dashboard",
  } as unknown as React.ComponentProps<typeof ClerkProvider>;

  return <ClerkProvider {...clerkProviderProps}>{children}</ClerkProvider>;
}
