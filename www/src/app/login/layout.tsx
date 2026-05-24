import type { ReactNode } from "react";
import { ClerkBoundary } from "@/components/auth/ClerkBoundary";

export default function LoginLayout({ children }: { children: ReactNode }) {
  return <ClerkBoundary>{children}</ClerkBoundary>;
}
