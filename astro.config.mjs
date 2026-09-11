import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import zeroJsRoutes from "./src/integrations/zero-js-routes.mjs";

const SITE = process.env.PUBLIC_SITE_URL || "https://hakopsbakery.com";

// https://astro.build/config
export default defineConfig({
  site: SITE,

  /*
    Static output on purpose. Every public page is plain HTML with no server
    round trip and no cold start. The four things that genuinely need a server
    (Stripe session creation, the Stripe webhook, the delivery zone check, and
    later the admin API) live in /netlify/functions and are called from the
    browser. See docs/DECISIONS.md.
  */
  output: "static",

  integrations: [
    react(),
    /*
      The label QR route is the one page on this site that must ship no script
      at all. Astro's prefetch runtime is a global "page" stage script with no
      per route switch, so it is stripped from /p/ after the build. See the file
      for the full reasoning, and scripts/check-html.mjs for the assertion that
      keeps it true.
    */
    zeroJsRoutes({ prefixes: ["/p/"] }),
    sitemap({
      filter: (page) =>
        // Order status pages are per customer and signed. Keep them out of
        // the sitemap and out of search results.
        !page.includes("/order/") && !page.includes("/admin"),
    }),
  ],

  vite: {
    plugins: [tailwindcss()],
    build: {
      // Ship one stylesheet rather than a cascade of small ones.
      cssCodeSplit: false,
    },
  },

  build: {
    // Directory style URLs, so /shop/gata/ rather than /shop/gata.html
    format: "directory",
    inlineStylesheets: "auto",
  },

  image: {
    // Photography is the centre of this site. Allow generous widths so the
    // srcset covers a 3x phone and a 2x desktop without upscaling.
    responsiveStyles: true,
  },

  prefetch: {
    prefetchAll: true,
    defaultStrategy: "hover",
  },

  experimental: {
    clientPrerender: true,
  },
});
