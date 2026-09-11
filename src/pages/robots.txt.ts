/**
 * robots.txt
 *
 * Generated rather than dropped in public/, so the sitemap URL is built from
 * the same PUBLIC_SITE_URL the rest of the site is built from. A robots file
 * pointing at the wrong host is the sort of thing nobody notices for months.
 *
 * The site wants to be crawled: it is a new bakery that nobody has heard of.
 * Two things are kept out.
 *
 *   /order/  Per customer order status pages. They are already noindex and
 *            no-store in netlify.toml, and they are excluded from the sitemap
 *            in astro.config.mjs. This is the third fence around the same
 *            field, and it is the cheapest of the three.
 *   /admin   Hakop's back office, Phase 2. It does not exist yet, and listing
 *            it now means it is never crawled even once by accident.
 *
 * Disallow is not a security control. It is a request, and a crawler that
 * ignores it is not stopped by this file. The real protection on both paths
 * is that they are signed or authenticated, not that they are listed here.
 *
 * Note that /p/ (the label QR landing pages) is deliberately NOT disallowed.
 * Somebody searching for what is in an Armenian gata should be able to find
 * the ingredient and allergen text, and those pages are the plainest
 * statement of it on the site.
 */
import type { APIRoute } from "astro";
import { site } from "@config/site";

/** Built from configuration so a preview deploy points at its own sitemap. */
const sitemapUrl = new URL("/sitemap-index.xml", site.url).href;

const body = `# ${site.url}
# Crawl the shop, the story and the label pages. Skip the two paths that are
# private to a customer or to Hakop.

User-agent: *
Allow: /
Disallow: /order/
Disallow: /admin
Disallow: /admin/

Sitemap: ${sitemapUrl}
`;

export const GET: APIRoute = () =>
  new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      /* Short, because this file changes when the site's shape changes and a
         day old copy in a CDN is plenty of caching for a text file. */
      "Cache-Control": "public, max-age=86400",
    },
  });
