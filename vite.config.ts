import {defineConfig} from "vite";
import UnoCSS from 'unocss/vite';
import vue from "@vitejs/plugin-vue";
import {presetIcons, presetWind3} from "unocss";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    vue(),
    UnoCSS({
      presets: [
        presetWind3(),
        presetIcons(), // 必须包含这个
      ],
    }),
  ],
  build: {
    target: 'modules',
    minify: 'esbuild' as const,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: () => 'everything.js'
      }
    },
    // HiDPI 优化：确保 CSS 中的像素单位正确处理
    cssTarget: 'chrome80'
  },
  css: {
    // 支持 CSS 变量和 HiDPI 相关特性
    devSourcemap: true
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
        protocol: "ws",
        host,
        port: 1421,
      }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
