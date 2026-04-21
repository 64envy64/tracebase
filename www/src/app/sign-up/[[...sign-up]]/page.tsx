import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { AuthPageShell } from "@/components/auth/AuthPageShell";
import { ClerkSignUpPanel } from "@/components/auth/ClerkSignUpPanel";

export const metadata: Metadata = {
  title: "TraceBase Sign Up",
  description: "Create your TraceBase account and continue to the protected dashboard.",
};

export default async function SignUpPage() {
  const { userId } = await auth();

  if (userId) {
    redirect("/dashboard");
  }

  return (
    <AuthPageShell
      title="Create account"
      description="Set up your TraceBase workspace account."
    >
      <ClerkSignUpPanel />
    </AuthPageShell>
  );
}
