import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
