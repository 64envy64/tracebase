import { dark } from "@clerk/ui/themes";

export const clerkAppearance = {
  theme: dark,
  options: {
    unsafe_disableDevelopmentModeWarnings: true,
  },
  variables: {
    colorPrimary: "#b1ff6d",
    colorBackground: "#161616",
    colorForeground: "#f4f3ef",
    colorMutedForeground: "rgba(244, 243, 239, 0.68)",
    colorInput: "#141414",
    colorInputForeground: "#f4f3ef",
    colorNeutral: "#ffffff",
    colorDanger: "#f2c572",
    colorSuccess: "#bff5cf",
    borderRadius: "0.95rem",
    fontFamily: "var(--font-geist-sans)",
    fontFamilyButtons: "var(--font-geist-sans)",
  },
  elements: {
    rootBox: "w-full",
    cardBox: "mx-auto w-full",
    card: "w-full border-0 bg-transparent p-0 shadow-none ring-0",
    header: "hidden",
    headerTitle: "hidden",
    headerSubtitle: "hidden",
    footer: "mt-4 rounded-xl border border-white/8 bg-[#2a2a2a] px-1 py-4",
    footerActionText: "!text-white/78",
    footerActionLink: "font-medium !text-[var(--accent)] hover:!text-[#d4ffaf]",
    footerPageLink: "!text-white/92 hover:!text-white",
    pageScrollBox: "p-0",
  },
} as const;
