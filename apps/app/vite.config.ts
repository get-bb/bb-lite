import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin, type UserConfig } from "vite";
import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const appDir = dirname(fileURLToPath(import.meta.url));

function fontPreload(): Plugin {
  return {
    name: "bb:font-preload",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler: (_html, ctx) =>
        Object.keys(ctx.bundle ?? {})
          .filter((name) =>
            /\/inter-latin-wght-normal-[\w-]+\.woff2$/.test(name),
          )
          .map((name) => ({
            tag: "link",
            attrs: {
              rel: "preload",
              as: "font",
              type: "font/woff2",
              crossorigin: true,
              href: `/${name}`,
            },
            injectTo: "head",
          })),
    },
  };
}

export const sharedViteConfig = {
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    fontPreload(),
  ],
  cacheDir: "node_modules/.vite/app",
  build: {
    reportCompressedSize: false,
    rolldownOptions: {
      output: {
        advancedChunks: {
          groups: [
            {
              name: "boot-vendor",
              test: /node_modules/,
              tags: ["$initial"],
              priority: 2,
              minSize: 12 * 1024,
            },
            {
              name: "boot-app",
              tags: ["$initial"],
              priority: 1,
              minSize: 12 * 1024,
            },
          ],
        },
      },
    },
  },
  optimizeDeps: {
    include: ["@xterm/addon-fit", "@xterm/addon-web-links", "@xterm/xterm"],
  },
  resolve: {
    conditions: ["source"],
    alias: [
      {
        find: /^\.\.\/\.\.\/lib\/portal-scope$/,
        replacement: resolve(
          appDir,
          "../../packages/app-kit/lib/portal-scope.ts",
        ),
      },
    ],
  },
} satisfies UserConfig;

export default defineConfig(sharedViteConfig);
