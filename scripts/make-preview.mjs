/*
  Builds a copy of dist/ that works when served from a subdirectory with no
  server rewriting URLs, which is what a published preview gives us.

  The real site is deployed at a domain root, so it links to "/shop/" and
  loads "/_astro/style.css". Neither resolves inside a preview sandbox: there
  is no server to map a directory URL onto its index.html, and a leading slash
  points at the host root rather than at our files.

  So every absolute path becomes a relative one, corrected for how deep the
  page sits, and every directory URL gets its index.html spelled out.

  Nothing here touches dist/ or the source. It writes preview/ and that
  directory is ignored by git. This is a viewing aid, not part of the build.
*/

import { readFile, writeFile, mkdir, readdir, copyFile } from "node:fs/promises";
import { join, dirname, relative, extname } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "dist");
const OUT = join(ROOT, "preview", "site");

/* Files that only mean something to a real deployment. */
const SKIP = new Set(["robots.txt", "sitemap-index.xml", "sitemap-0.xml"]);

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/**
 * Turn one absolute path from the deployed site into a relative one that
 * works from a page sitting `depth` directories down.
 */
function rewrite(absolute, depth) {
  const prefix = depth === 0 ? "" : "../".repeat(depth);

  // Keep any fragment or query aside so it survives onto the end.
  const marker = absolute.search(/[#?]/);
  const tail = marker === -1 ? "" : absolute.slice(marker);
  let path = (marker === -1 ? absolute : absolute.slice(0, marker)).slice(1);

  if (path === "") return `${prefix}index.html${tail}`;

  // A directory URL, whether or not it carries a trailing slash. The site is
  // built with directory-style URLs, so "/story" and "/story/" are both a
  // folder with an index.html in it, and a server used to resolve that. The
  // absence of a file extension is what marks it as a directory.
  const last = path.split("/").pop() ?? "";
  if (path.endsWith("/")) return `${prefix}${path}index.html${tail}`;
  if (!last.includes(".")) return `${prefix}${path}/index.html${tail}`;

  return `${prefix}${path}${tail}`;
}

/** Rewrite every absolute URL inside one attribute value. */
function rewriteAttr(value, depth) {
  // srcset carries several URLs, each optionally followed by a descriptor.
  if (value.includes(",") && /\s+\d+[wx]/.test(value)) {
    return value
      .split(",")
      .map((part) => {
        const trimmed = part.trim();
        const [url, ...rest] = trimmed.split(/\s+/);
        if (!url?.startsWith("/")) return trimmed;
        return [rewrite(url, depth), ...rest].join(" ");
      })
      .join(", ");
  }
  return value.startsWith("/") ? rewrite(value, depth) : value;
}

let pages = 0;
let assets = 0;

for await (const file of walk(SRC)) {
  const rel = relative(SRC, file);
  if (SKIP.has(rel)) continue;

  const dest = join(OUT, rel);
  await mkdir(dirname(dest), { recursive: true });

  const ext = extname(file);

  if (ext === ".html") {
    const depth = rel.split("/").length - 1;
    let html = await readFile(file, "utf8");

    // href and src on any element.
    html = html.replace(
      /\b(href|src)="(\/[^"]*)"/g,
      (_, attr, value) => `${attr}="${rewriteAttr(value, depth)}"`,
    );
    /*
      Astro's islands carry their own module URLs on the <astro-island>
      element rather than in a src attribute, and the client runtime fetches
      them from there. Miss these and the page renders but nothing hydrates:
      on the closed site that is the waiting list form, which is the only
      thing a visitor can currently do.
    */
    html = html.replace(
      /\b(component-url|renderer-url)="(\/[^"]*)"/g,
      (_, attr, value) => `${attr}="${rewriteAttr(value, depth)}"`,
    );
    // srcset and imagesrcset.
    html = html.replace(
      /\b(srcset|imagesrcset)="([^"]*)"/g,
      (_, attr, value) => `${attr}="${rewriteAttr(value, depth)}"`,
    );
    // url() inside any inline style block.
    html = html.replace(/url\((\/[^)]+)\)/g, (_, value) => `url(${rewrite(value, depth)})`);

    await writeFile(dest, html);
    pages += 1;
  } else if (ext === ".css") {
    const depth = rel.split("/").length - 1;
    let css = await readFile(file, "utf8");
    css = css.replace(/url\((\/[^)"']+)\)/g, (_, value) => `url(${rewrite(value, depth)})`);
    await writeFile(dest, css);
    assets += 1;
  } else {
    await copyFile(file, dest);
    assets += 1;
  }
}

console.log(`preview/site: ${pages} page(s), ${assets} asset(s)`);
