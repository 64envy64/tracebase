import Image from "next/image";
import Link from "next/link";

type AuthPageShellProps = {
  children: React.ReactNode;
  description?: string;
  title: string;
};

export function AuthPageShell({ children, description, title }: AuthPageShellProps) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-[#090909] px-4 py-10 sm:px-6 sm:py-12">
      <div
        className="auth-plate auth-plate--clerk grid w-full max-w-[900px] grid-cols-1 overflow-hidden rounded-2xl border border-white/[0.1] bg-[#121212] lg:min-h-[min(520px,calc(100svh-10rem))] lg:grid-cols-2 lg:items-stretch lg:shadow-none"
      >
        <section
          className="auth-visual-enter relative isolate min-h-[220px] w-full overflow-hidden aspect-[4/3] sm:aspect-[5/4] lg:aspect-auto lg:h-full lg:min-h-0"
          aria-labelledby="auth-intro-heading"
        >
          <Image
            src="/login.png"
            alt=""
            fill
            priority
            className="object-cover object-center"
            sizes="(max-width: 1024px) 100vw, 450px"
          />

          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/78 via-black/12 to-black/20" />

          <div className="absolute inset-x-0 bottom-0 z-10 p-6 sm:p-7 lg:p-8">
            <p className="mb-3 text-[10px] font-light tracking-[0.02em] text-white/55">Painting by Jennifer Branch</p>
            <h1
              id="auth-intro-heading"
              className="max-w-[16ch] text-[clamp(1.85rem,4.2vw,3rem)] font-normal leading-[1.05] tracking-tight text-white"
            >
              Stop agents from solving the same problem twice.
            </h1>
          </div>
        </section>

        <section className="flex min-h-0 w-full flex-col border-t border-white/[0.08] bg-[#161616] lg:h-full lg:min-h-0 lg:border-l lg:border-t-0">
          <div className="flex min-h-0 flex-1 flex-col justify-center px-6 py-8 sm:px-8 sm:py-10">
            <header className="mb-8 text-center lg:mb-9">
              <h2 className="text-[1.85rem] font-normal leading-[1.02] tracking-tight text-white sm:text-[2.05rem]">
                {title}
              </h2>
              {description ? (
                <p className="mx-auto mt-3 max-w-[28ch] text-[13px] leading-relaxed text-white/65">{description}</p>
              ) : null}
            </header>

            <div className="auth-clerk-host mx-auto w-full min-w-0 max-w-[400px]">{children}</div>
          </div>
        </section>
      </div>

      <footer className="mt-10 flex shrink-0 justify-center sm:mt-12">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-[12px] font-medium tracking-tight text-white/62 transition-colors duration-200 hover:text-white"
        >
          <Image src="/logo.svg" alt="TraceBase" width={16} height={16} className="h-4 w-4" />
          <span>TraceBase</span>
        </Link>
      </footer>
    </div>
  );
}
