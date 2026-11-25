import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native SQLite driver must stay a server-side external dependency.
  serverExternalPackages: ["better-sqlite3"],
  poweredByHeader: false,
};

export default nextConfig;
