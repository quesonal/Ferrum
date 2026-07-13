import { createI18n } from 'vue-i18n'
import en from './locales/en.json'
import zhCN from './locales/zh-CN.json'

function detectLanguage(): string {
  const cached = localStorage.getItem('app_config_cache')
  if (cached) {
    try {
      const cfg = JSON.parse(cached)
      if (cfg.language && ['en', 'zh-CN'].includes(cfg.language)) {
        return cfg.language
      }
    } catch { /* ignore */ }
  }

  const navLang = navigator.language
  if (navLang.startsWith('zh')) return 'zh-CN'
  return 'en'
}

const i18n = createI18n({
  legacy: false,
  locale: detectLanguage(),
  fallbackLocale: 'en',
  messages: {
    en,
    'zh-CN': zhCN,
  },
})

export default i18n
