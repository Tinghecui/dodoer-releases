import type { NextConfig } from "next"
import createNextIntlPlugin from "next-intl/plugin"
import packageJson from "./package.json"

const isProd = process.env.NODE_ENV === "production"
const internalHost = process.env.TAURI_DEV_HOST || "localhost"
// Development assets must use the same port as the development server.
const devPort = process.env.PORT || "3000"
const withNextIntl = createNextIntlPlugin({
  requestConfig: "./src/i18n/request.ts",
  experimental: {
    messages: {
      path: "./src/i18n/messages",
      format: "json",
      locales: [
        "en",
        "zh-CN",
        "zh-TW",
        "ja",
        "ko",
        "es",
        "de",
        "fr",
        "pt",
        "ar",
      ],
      precompile: true,
    },
  },
})

const nextConfig: NextConfig = {
  output: "export",
  // The build type-checks tsconfig.json minus the test files; that file says
  // why.
  typescript: {
    tsconfigPath: "tsconfig.build.json",
  },
  // Development-only pages (`page.gallery.tsx`, e.g. the activity timeline
  // gallery) are routes only when CODEG_GALLERY=1, so release builds never
  // ship them.
  ...(process.env.CODEG_GALLERY === "1"
    ? { pageExtensions: ["gallery.tsx", "tsx", "ts", "jsx", "js"] }
    : {}),
  env: {
    // Compared with the server's version (web-version-notice, web-transport).
    CODEG_APP_VERSION: packageJson.version,
    // The service worker's caches are keyed to the release; see
    // serviceWorkerUrl() in src/lib/service-worker.ts. package.json stays at
    // the upstream base version, so a Cowork release passes its tag
    // (cowork-release-build.sh) and every release turns the caches over.
    CODEG_RELEASE_VERSION: process.env.COWORK_VERSION ?? "",
  },
  images: {
    unoptimized: true,
  },
  assetPrefix: isProd ? undefined : `http://${internalHost}:${devPort}`,
}

export default withNextIntl(nextConfig)
