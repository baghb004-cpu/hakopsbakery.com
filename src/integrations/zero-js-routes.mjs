/*
  Keeps named routes at literally zero JavaScript.

  WHY THIS EXISTS.

  astro.config.mjs turns prefetch on, which is right for the browsing path:
  somebody reading the gata page is probably going to the shop next, and
  prefetching on hover makes that feel instant. But Astro's prefetch runtime is
  a "page" stage script, which means it is pushed into settings.scripts once and
  emitted into every page in the build. Astro 7 has no per page and no per route
  way to turn it back off: `prefetch.prefetchAll` only decides which links are
  eligible once the runtime is already on the page, and setting `prefetch: false`
  would remove it from the whole site rather than from one route.

  The label QR route has a different requirement from the rest of the site. It
  is printed on the tray, and the person scanning it is standing in a kitchen on
  cellular trying to find out whether there are walnuts in the thing they are
  about to eat. The spec for that page is zero JavaScript, and "3 KB of a
  prefetch runtime that has nothing worth prefetching" is not zero.

  So the script is stripped from those routes after the build, which is the one
  place Astro does hand over the finished HTML.

  WHAT IT WILL AND WILL NOT REMOVE.

  It only removes a module script whose bundle actually contains the prefetch
  runtime, identified by content rather than by filename, so a chunk rename in a
  future Astro cannot make this silently strip the wrong script or silently stop
  working. Any other script on a matched page, an island bootstrap for instance,
  is left alone. If a matched route ever grows a real island, that island keeps
  working and the build log says the page is no longer zero JS.

  scripts/check-html.mjs asserts the result on the built output, so this cannot
  regress quietly.
*/

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/* Minified identifiers get mangled. These two option names are read off an
   object literal, so they survive minification and are a reliable marker. */
const PREFETCH_MARKERS = ["prefetchAll", "defaultStrategy"];

const SCRIPT_TAG = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>/gi;

/**
 * @param {object} options
 * @param {string[]} options.prefixes Route path prefixes to keep script free,
 *   for example ["/p/"]. Matched against the built pathname.
 */
export default function zeroJsRoutes({ prefixes = [] } = {}) {
  return {
    name: "hakops:zero-js-routes",
    hooks: {
      "astro:build:done": async ({ dir, logger }) => {
        const distDir = fileURLToPath(dir);
        const bundleCache = new Map();

        /** Is this emitted bundle the prefetch runtime? */
        const isPrefetchBundle = async (src) => {
          if (!src.startsWith("/")) return false;
          if (bundleCache.has(src)) return bundleCache.get(src);
          let verdict = false;
          try {
            const code = await readFile(join(distDir, src), "utf8");
            verdict = PREFETCH_MARKERS.every((marker) => code.includes(marker));
          } catch {
            verdict = false;
          }
          bundleCache.set(src, verdict);
          return verdict;
        };

        /* Walk dist rather than trusting the pages list, because a route can
           emit more than one file and the pathname shape differs by format. */
        async function* htmlFiles(current) {
          for (const entry of await readdir(current, { withFileTypes: true })) {
            const full = join(current, entry.name);
            if (entry.isDirectory()) yield* htmlFiles(full);
            else if (entry.name.endsWith(".html")) yield full;
          }
        }

        let stripped = 0;
        let leftWithScripts = 0;

        for await (const file of htmlFiles(distDir)) {
          const route =
            "/" +
            file
              .slice(distDir.length)
              .replace(/\\/g, "/")
              .replace(/^\/+/, "")
              .replace(/index\.html$/, "");
          if (!prefixes.some((prefix) => route.startsWith(prefix))) continue;

          const html = await readFile(file, "utf8");
          const removals = [];
          for (const match of html.matchAll(SCRIPT_TAG)) {
            if (await isPrefetchBundle(match[1])) removals.push(match[0]);
          }

          let next = html;
          for (const tag of removals) next = next.replace(tag, "");

          if (next !== html) {
            await writeFile(file, next, "utf8");
            stripped += removals.length;
          }

          /* Report honestly if the page is still not zero JS. */
          const remaining = [...next.matchAll(SCRIPT_TAG)].length;
          if (remaining > 0) {
            leftWithScripts += 1;
            logger.warn(`${route} still loads ${remaining} script file(s).`);
          }
        }

        if (stripped > 0) {
          logger.info(
            `Removed the prefetch runtime from ${stripped} page(s) under ${prefixes.join(", ")}.`,
          );
        }
        if (stripped === 0 && leftWithScripts === 0) {
          logger.info(`No prefetch runtime found on ${prefixes.join(", ")}; already script free.`);
        }
      },
    },
  };
}
