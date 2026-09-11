import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const at = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/*
  The Netlify functions and the tests both import from `src/lib` through the
  same aliases the rest of the codebase uses, so the aliases have to be
  declared here as well as in tsconfig.json. Vite matches these as prefixes,
  so the specific ones are listed before the bare "@".
*/
export default defineConfig({
  resolve: {
    alias: {
      "@lib": at("./src/lib"),
      "@config": at("./src/config"),
      "@components": at("./src/components"),
      "@islands": at("./src/islands"),
      "@layouts": at("./src/layouts"),
      "@": at("./src"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    /*
      Every test that cares about time passes its own clock in. Nothing here
      depends on when it is run, apart from Stripe's own signature tolerance,
      which is deliberately exercised with a real recent timestamp.
    */
    restoreMocks: true,
    clearMocks: true,
  },
});
