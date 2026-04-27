"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Reveal-once IntersectionObserver hook. Returns a ref + inView bool.
 * Once the element has entered the viewport, it stays `true` — so reveal
 * animations don't replay on scroll-back.
 */
export function useInView<T extends HTMLElement = HTMLDivElement>(
  options: IntersectionObserverInit = { threshold: 0.25, rootMargin: "0px 0px -10% 0px" },
): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  // If IntersectionObserver is unavailable (very old browser / test env),
  // initialise `true` so content is still visible without animation.
  const [inView, setInView] = useState<boolean>(
    () => typeof window !== "undefined" && typeof IntersectionObserver === "undefined",
  );

  useEffect(() => {
    const el = ref.current;
    if (!el || inView) return;
    if (typeof IntersectionObserver === "undefined") return;

    const obs = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          setInView(true);
          obs.disconnect();
          break;
        }
      }
    }, options);
    obs.observe(el);
    return () => obs.disconnect();
  }, [inView, options]);

  return [ref, inView];
}
