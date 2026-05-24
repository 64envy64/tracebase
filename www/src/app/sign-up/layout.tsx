import type { ReactNode } from "react";
import { ClerkBoundary } from "@/components/auth/ClerkBoundary";

export default function SignUpLayout({ children }: { children: ReactNode }) {
  return <ClerkBoundary>{children}</ClerkBoundary>;
}
