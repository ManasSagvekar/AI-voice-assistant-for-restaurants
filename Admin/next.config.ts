import type { NextConfig } from 'next';

const config: NextConfig = {
  // Served at /admin so it can share one address with the Voice-assistant (see ../../scripts/dev.mjs).
  basePath: '/admin',
  poweredByHeader: false,
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'same-origin' },
        { key: 'X-Robots-Tag', value: 'noindex' },
      ],
    }];
  },
};

export default config;
