import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The browser proxy uses path-based URLs (/api/proxy/https/host/path/). A
  // trailing-slash redirect would strip the slash and break relative URL
  // resolution inside proxied pages, so disable that redirect.
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
