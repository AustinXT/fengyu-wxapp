import type { NextConfig } from "next"
import path from "path"

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.resolve(__dirname, ".."),
  productionBrowserSourceMaps: false,
  serverExternalPackages: ["postgres"],
  webpack: (config) => {
    config.resolve.alias["@db"] = path.resolve(__dirname, "../db/schema")
    return config
  },
}

export default nextConfig

