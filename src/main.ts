import { createApp } from "vue";
import App from "./App.vue";
import {createPinia} from "pinia";
import router from "./router";
import i18n from './i18n'

import './style.css'
import './styles/hidpi.css'
import 'virtual:uno.css'

import { perfMark, perfBegin, perfEnd } from "./perf";

// Phase 3c/3d — single-writer navigation. The legacy dual-write
// fallback registered in 3b is gone and the per-store `currentImageId`
// refs are computed mirrors of `useNavigationStore().currentImageId`.
// `useNavigationStore().setCurrent(id)` is the only path that should
// mutate `currentImageId` from here on. See `src/types/navigation.md`
// for the ownership map.

perfMark("main_entry", { url: location.href });

const pinia = createPinia()
perfBegin("vue_create");
const app = createApp(App).use(pinia).use(router).use(i18n);
perfEnd("vue_create");

perfBegin("vue_mount");
app.mount("#app");
perfEnd("vue_mount");

perfMark("main_done", { mounted: true });