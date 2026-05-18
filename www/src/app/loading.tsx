import { InkPreloader } from "@/components/landing/brand/InkPreloader";

/**
 * App Router root-level loading state. Next.js wraps every route in a
 * Suspense boundary that falls back to this component while async work
 * resolves (server components, generateMetadata, etc.). Using our own
 * brand-native preloader keeps the navigation between landing → docs →
 * dashboard feeling cohesive — no flash of unstyled content, no white
 * spinner.
 */
export default function Loading() {
  return <InkPreloader mode="fullscreen" />;
}
