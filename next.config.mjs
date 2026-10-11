/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    config.module.rules.push({
      test: /\.(ttf|html)$/i,
      type: 'asset/resource'
    });
    return config;
  },
  experimental: {
    serverMinification: false, // the server minification unfortunately breaks the selector class names
    // Load Playwright from node_modules at run time. Webpack turns its
    // require.resolve() into a number, and `next build` then fails in Docker.
    serverComponentsExternalPackages: ["rebrowser-playwright-core", "ghost-cursor-playwright", "@playwright/browser-chromium"],
  },
};  

export default nextConfig;
