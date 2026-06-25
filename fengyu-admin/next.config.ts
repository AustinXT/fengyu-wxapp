import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  output: 'standalone',
  // 代码保护(L1)：显式关闭客户端 source map，避免把可还原成 TS 源码的映射
  // 随生产 bundle 一起交付到客户服务器。默认即 false，这里显式声明以记录意图、
  // 防后续误开；服务端 .map 由 docker/Dockerfile.admin 构建期兜底删除。
  productionBrowserSourceMaps: false,
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
