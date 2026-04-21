import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { AuthPageShell } from "@/components/auth/AuthPageShell";
import { ClerkSignInPanel } from "@/components/auth/ClerkSignInPanel";

export const metadata: Metadata = {
  title: "TraceBase Login",
  description: "Secure sign in and account creation for the TraceBase dashboard.",
};

export default async function LoginPage() {
  const { userId } = await auth();

  if (userId) {
    redirect("/dashboard");
  }

  return (
    <AuthPageShell
      title="Welcome back"
      description="Continue to TraceBase with your workspace account."
    >
      <ClerkSignInPanel />
    </AuthPageShell>
  );
}
