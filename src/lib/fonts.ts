/**
 * Works out which font files to preload, by reading the generated stylesheet
 * rather than by keeping a hand written list next to it that goes stale the
 * first time anyone re-runs scripts/fetch-fonts.mjs.
 *
 * Only the Latin subset is preloaded. The Armenian subset is fetched on
 * demand by the browser when it actually meets Armenian text, which is the
 * whole reason the fonts are split by unicode-range.
 */
import fontCss from "../styles/fonts.css?raw";

function latinSubsetUrls(css: string): string[] {
  const urls = new Set<string>();
  // Each @font-face is preceded by a comment naming its subset.
  const blocks = css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g);
  for (const [, subset, body] of blocks) {
    if (subset !== "latin") continue;
    const url = /url\(([^)]+)\)/.exec(body ?? "");
    if (url?.[1]) urls.add(url[1]);
  }
  return [...urls];
}

export const preloadFonts: string[] = latinSubsetUrls(fontCss);
