import type { NextConfig } from 'next';

/**
 * Security headers. The CSP is deliberately strict: the AI never returns
 * executable code, so we do not need `unsafe-eval` in production. Next's dev
 * server and React refresh do need it, so it is relaxed only for `next dev`.
 */
const isDev = process.env.NODE_ENV !== 'production';

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : " 'wasm-unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  /**
   * Standalone output keeps the container image small — Next traces exactly the
   * files the server needs instead of shipping node_modules. It is opt-in
   * because `next start` does not serve a standalone build, and that is how the
   * app runs locally and in the end-to-end suite. The Dockerfile sets it.
   */
  ...(process.env.BUILD_STANDALONE === 'true' ? { output: 'standalone' as const } : {}),
  outputFileTracingIncludes: {
    '/api/**': ['./node_modules/web-ifc/*.wasm'],
  },
  serverExternalPackages: ['pino'],
  experimental: {
    optimizePackageImports: ['lucide-react'],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
