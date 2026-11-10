/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship raw TypeScript.
  transpilePackages: ['@goodfor/briefs', '@goodfor/contracts', '@goodfor/db', '@goodfor/scoring'],
  experimental: {
    // .env.local and the workspace packages live above apps/dashboard.
    externalDir: true,
  },
  // The Claude-Design UI (public/intelligence.html) is THE product UI. The old
  // Next pages are superseded; send the root there so it is the default.
  async redirects() {
    return [{ source: '/', destination: '/intelligence.html', permanent: false }]
  },
  // The UI is a static file, so browsers cache it aggressively and users get a
  // stale app after a deploy. It is the product shell, not an asset — always
  // revalidate.
  async headers() {
    return [
      {
        source: '/intelligence.html',
        headers: [{ key: 'Cache-Control', value: 'no-store, must-revalidate' }],
      },
      { source: '/support.js', headers: [{ key: 'Cache-Control', value: 'no-store, must-revalidate' }] },
    ]
  },
  webpack: (config) => {
    // The workspace packages use ESM-correct ".js" specifiers that point at
    // ".ts" sources. tsx and Node resolve these; webpack does not without help.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    }
    return config
  },
}

export default nextConfig
