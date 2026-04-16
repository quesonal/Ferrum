import { createApp } from "vue";
import App from "./App.vue";
import {createPinia} from "pinia";
import 'virtual:uno.css'

import './style.css'
import './styles/hidpi.css'

const pinia = createPinia()
createApp(App).use(pinia).mount("#app");
