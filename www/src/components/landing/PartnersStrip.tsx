import Image from "next/image";
import type { CSSProperties, ReactNode } from "react";
import { Reveal } from "./brand/Reveal";
import { INK } from "./brand/tokens";

/* ============================================================ */
/*  PartnersStrip — quiet single-row backer wall.                */
/*                                                                */
/*  Three logos, no eyebrow, no role labels: ISSAI · Daytona     */
/*  Startup Grid · Google Cloud for Startups. These three are    */
/*  real institutional affiliations we can point to.             */
/*                                                                */
/*  ISSAI ships as a black-on-white SVG; we invert via CSS so    */
/*  it reads on the ink background. Daytona ships in colour and  */
/*  Google's mark stays in its native multicolour — the row is   */
/*  intentionally NOT colour-normalised down to monochrome since */
/*  the affiliations are real and the brand marks carry weight. */
/* ============================================================ */

type LogoEntry = {
  id: string;
  alt: string;
  href: string;
  render: () => ReactNode;
};

const ISSAI_FILTER: CSSProperties = {
  // The ISSAI source SVG uses solid black fill. brightness(0) flattens it; the
  // invert(1) flips to white; opacity nudges it into the bone register so it
  // matches the neighbouring marks tonally.
  filter: "brightness(0) invert(1)",
  opacity: 0.92,
};

const LOGOS: readonly LogoEntry[] = [
  {
    id: "issai",
    alt: "ISSAI — Institute of Smart Systems & AI",
    href: "https://issai.nu.edu.kz",
    render: () => (
      <Image
        src="/partners/issai.svg"
        alt="ISSAI"
        width={252}
        height={90}
        className="h-[58px] w-auto md:h-[64px]"
        style={ISSAI_FILTER}
      />
    ),
  },
  {
    id: "daytona",
    alt: "Daytona Startup Grid",
    href: "https://www.daytona.io/startups",
    render: () => (
      <Image
        src="/partners/daytonapartner.png"
        alt="Daytona Startup Grid"
        width={252}
        height={54}
        className="h-[44px] w-auto md:h-[50px]"
      />
    ),
  },
  {
    id: "google-cloud-startups",
    alt: "Google Cloud for Startups",
    href: "https://cloud.google.com/startup",
    render: () => (
      <Image
        src="/partners/googlecloud.png"
        alt="Google Cloud for Startups"
        width={252}
        height={84}
        className="h-[52px] w-auto md:h-[58px]"
      />
    ),
  },
] as const;

/* ============================================================ */
/*  Section                                                       */
/* ============================================================ */

export function PartnersStrip() {
  return (
    <section
      aria-label="Backers"
      className="relative"
      style={{ background: INK.ink, color: INK.bone }}
    >
      <div className="mx-auto max-w-[1080px] px-5 sm:px-6">
        <div
          className="border-t border-b"
          style={{ borderColor: "rgba(232,217,184,0.08)" }}
        >
          <Reveal>
            <div className="flex flex-wrap items-center justify-center gap-x-16 gap-y-8 py-10 md:gap-x-24 md:py-14">
              {LOGOS.map((logo) => (
                <LogoCell key={logo.id} logo={logo} />
              ))}
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/* ============================================================ */
/*  LogoCell — anchor wrapper + opacity treatment.               */
/*  Slightly more visible than the prior pass (75%) since the    */
/*  logos are bigger and the row carries more page weight now.   */
/* ============================================================ */

function LogoCell({ logo }: { logo: LogoEntry }) {
  return (
    <a
      href={logo.href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={logo.alt}
      className="inline-flex items-center rounded-sm opacity-75 transition-opacity duration-200 hover:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
    >
      {logo.render()}
    </a>
  );
}
