import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['postgres'],
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "636c-cloud1-3gpht4b01ff88838-1406056527.tcb.qcloud.la",
      },
    ],
  },
  webpack: (config) => {
    config.resolve.alias['@db'] = path.resolve(__dirname, '../db/schema');
    return config;
  },
};

export default nextConfig;
