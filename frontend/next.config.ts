import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      // Vendor analytics now lives inside the Analytics tab. These paths were
      // never routes in this app, but they are the shapes a bookmark or an
      // external link would plausibly take, so they land somewhere useful
      // instead of on a 404.
      {
        source: "/vendors",
        destination: "/app?tab=analytics&section=vendors",
        permanent: false,
      },
      {
        source: "/app/vendors",
        destination: "/app?tab=analytics&section=vendors",
        permanent: false,
      },
      {
        source: "/analytics",
        destination: "/app?tab=analytics",
        permanent: false,
      },
    ];
  },
  webpack: (config) => {
    // pdfjs-dist optionally references the Node `canvas` package. Statement
    // PDF rendering only runs in the browser, so stub it out for client builds.
    config.resolve.alias = {
      ...config.resolve.alias,
      canvas: false,
    };
    return config;
  },
};

export default nextConfig;
