import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/LoginForm";
import { MainContainer } from "@/components/layout/MainContainer";
import { SiteHeader } from "@/components/layout/SiteHeader";
import { Eyebrow } from "@/components/ui/Eyebrow";

export const metadata: Metadata = {
  title: "TraceBase Login",
  description: "Sign in to access the TraceBase dashboard.",
};

const LOGIN_NAV = [
  { href: "/", label: "Home" },
  { href: "/whitepaper", label: "Whitepaper" },
  { href: "https://github.com/64envy64/tracebase", label: "GitHub", external: true },
] as const;

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<{ next?: string | string[] }>;
}) {
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const nextPathRaw = resolvedSearchParams?.next;
  const nextPath =
    typeof nextPathRaw === "string" && nextPathRaw.startsWith("/")
      ? nextPathRaw
      : "/dashboard";

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader navItems={LOGIN_NAV} />

      <MainContainer className="flex flex-1 flex-col justify-center">
        <div className="grid w-full gap-px lg:grid-cols-[minmax(0,1.15fr)_minmax(280px,380px)]" style={{ background: "var(--border)" }}>
          <section
            className="p-8 sm:p-10"
            style={{ background: "var(--bg)" }}
            aria-labelledby="login-intro-heading"
          >
            <Eyebrow>Sign in</Eyebrow>
            <h1
              id="login-intro-heading"
              className="mt-6 max-w-2xl text-[36px] font-extralight leading-[1.08] tracking-tight sm:text-[44px]"
            >
              Dashboard access
            </h1>
            <p
              className="mt-5 max-w-xl text-sm font-light leading-relaxed"
              style={{ color: "var(--text-secondary)" }}
            >
              Shared memory, promoted traces, scope control, reuse metrics, and the operational
              layer around your reasoning system.
            </p>

            <dl
              className="mt-10 grid gap-3 border-t pt-8 sm:grid-cols-3"
              style={{ borderColor: "var(--border)" }}
            >
              {[
                { value: "12.6k", label: "org traces" },
                { value: "38%", label: "recall rate" },
                { value: "81%", label: "helpful reuse" },
              ].map((stat) => (
                <div
                  key={stat.label}
                  className="rounded-sm border px-4 py-4"
                  style={{ borderColor: "var(--border)", background: "var(--surface)" }}
                >
                  <dt className="sr-only">{stat.label}</dt>
                  <dd className="m-0">
                    <p className="text-2xl font-extralight tabular-nums">{stat.value}</p>
                    <p
                      className="mt-2 text-xs font-light uppercase tracking-[0.16em]"
                      style={{ color: "var(--text-tertiary)" }}
                    >
                      {stat.label}
                    </p>
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="p-6 sm:p-8" style={{ background: "var(--bg)" }} aria-labelledby="login-form-heading">
            <header className="mb-8">
              <p
                className="text-[11px] font-mono uppercase tracking-[0.18em]"
                style={{ color: "var(--text-tertiary)" }}
              >
                Access
              </p>
              <h2 id="login-form-heading" className="mt-3 text-xl font-light tracking-tight">
                Admin login
              </h2>
            </header>

            <LoginForm nextPath={nextPath} />
          </section>
        </div>
      </MainContainer>
    </div>
  );
}
