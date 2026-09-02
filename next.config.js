/** @type {import('next').NextConfig} */
const nextConfig = {
  // Electron loads the app either from the Next dev server (development) or
  // from a static export (production packaging).
  output: process.env.NEXT_BUILD_TARGET === "export" ? "export" : undefined,
  reactStrictMode: true,
};

module.exports = nextConfig;
