import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
  },
  images: {
    // External hosts allowed for `next/image`. Clerk serves all
    // avatar / org-logo URLs from img.clerk.com; the legacy
    // images.clerk.dev domain is still in circulation for older
    // user records, so we whitelist both.
    remotePatterns: [
      { protocol: "https", hostname: "img.clerk.com" },
      { protocol: "https", hostname: "images.clerk.dev" },
    ],
  },
};

export default nextConfig;
