import { execSync } from "child_process";

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_DASHBOARD_VERSION: (() => {
      try {
        return execSync("git log -1 --format=%cd --date=format:%y.%m%d", { encoding: "utf8" }).trim();
      } catch {
        return "";
      }
    })(),
  },
};

export default nextConfig;
