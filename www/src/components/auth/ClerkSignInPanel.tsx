import { ClerkLoaded, ClerkLoading, SignIn } from "@clerk/nextjs";
import { ClerkAuthFallback } from "@/components/auth/ClerkAuthFallback";

export function ClerkSignInPanel() {
  return (
    <div className="auth-panel-enter w-full min-w-0">
      <h2 className="sr-only">Sign in to TraceBase</h2>
      <ClerkLoading>
        <ClerkAuthFallback label="Preparing secure sign-in" />
      </ClerkLoading>

      <ClerkLoaded>
        <SignIn
          path="/login"
          routing="path"
          signUpUrl="/sign-up"
          fallback={<ClerkAuthFallback label="Preparing secure sign-in" />}
        />
      </ClerkLoaded>
    </div>
  );
}
