import { ClerkLoaded, ClerkLoading, SignUp } from "@clerk/nextjs";
import { ClerkAuthFallback } from "@/components/auth/ClerkAuthFallback";

export function ClerkSignUpPanel() {
  return (
    <div className="auth-panel-enter w-full min-w-0">
      <h2 className="sr-only">Create a TraceBase account</h2>
      <ClerkLoading>
        <ClerkAuthFallback label="Preparing secure sign-up" />
      </ClerkLoading>

      <ClerkLoaded>
        <SignUp path="/sign-up" routing="path" signInUrl="/login" fallback={<ClerkAuthFallback label="Preparing secure sign-up" />} />
      </ClerkLoaded>
    </div>
  );
}
