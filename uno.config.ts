import {
    defineConfig,
    presetWind3,
    presetAttributify,
    presetIcons
} from 'unocss'

export default defineConfig({
    presets: [
        presetWind3(),
        presetAttributify(),
        presetIcons({
            // 这里的配置可选
            scale: 1.2, // 让图标大一点
            warn: true,  // 如果图标名字写错了，在终端报错提醒
            extraProperties: {
                'display': 'inline-block',
                'vertical-align': 'middle',
            },
        }),
    ],
    theme: {
        // 定义自定义颜色变量映射
        colors: {
            ui: {
                bg: 'var(--ui-bg)',
                text: 'var(--ui-text)',
                dim: 'var(--ui-text-dim)',
                border: 'var(--ui-border)',
                hover: 'var(--ui-btn-hover)',
                accent: 'var(--ui-accent)',
                'accent-hover': 'var(--ui-accent-hover)',
            }
        }
    },
    preflights: [
        {
            getCSS: () => `
                :root {
                  --ui-bg: #222222;
                  --ui-border: rgba(255,255,255,0.1);
                  --ui-text: #eeeeee;
                  --ui-text-dim: #999999;
                  --ui-btn-hover: rgba(255,255,255,0.1);

                  /* Accent (single source of truth for the app blue) */
                  --ui-accent: #007aff;
                  --ui-accent-hover: #3395ff;
                  --ui-accent-soft: rgba(0,122,255,0.25);

                  /* Frosted-glass card system (sidebar cards, thumbnail navigator) */
                  --glass-bg: rgba(35,35,35,0.45);
                  --glass-bg-hover: rgba(45,45,45,0.6);
                  --glass-border: rgba(255,255,255,0.08);
                  --glass-border-hover: rgba(255,255,255,0.2);
                  --glass-shadow: 0 4px 16px rgba(0,0,0,0.2);
                  --glass-shadow-hover: 0 8px 24px rgba(0,0,0,0.3);
                  --glass-highlight: inset 0 1px 0 rgba(255,255,255,0.08);
                  --glass-blur: 12px;
                  --glass-text: rgba(255,255,255,0.9);
                  --glass-text-dim: rgba(255,255,255,0.45);
                  --glass-fill: rgba(255,255,255,0.1);
                }
                :root.light {
                  --ui-bg: #f3f3f3;
                  --ui-border: rgba(0,0,0,0.1);
                  --ui-text: #333333;
                  --ui-text-dim: #666666;
                  --ui-btn-hover: rgba(0,0,0,0.05);

                  --ui-accent: #007aff;
                  --ui-accent-hover: #0062cc;
                  --ui-accent-soft: rgba(0,122,255,0.2);

                  --glass-bg: rgba(255,255,255,0.55);
                  --glass-bg-hover: rgba(255,255,255,0.72);
                  --glass-border: rgba(0,0,0,0.08);
                  --glass-border-hover: rgba(0,0,0,0.16);
                  --glass-shadow: 0 4px 16px rgba(0,0,0,0.1);
                  --glass-shadow-hover: 0 8px 24px rgba(0,0,0,0.15);
                  --glass-highlight: inset 0 1px 0 rgba(255,255,255,0.7);
                  --glass-blur: 12px;
                  --glass-text: rgba(0,0,0,0.85);
                  --glass-text-dim: rgba(0,0,0,0.5);
                  --glass-fill: rgba(0,0,0,0.06);
                }
            `
        }
    ],
    shortcuts: {
        'win-btn': 'w-10 h-full flex items-center justify-center border-none bg-transparent text-ui-dim cursor-default transition-colors hover:bg-ui-hover hover:text-ui-text',
        'nav-btn': 'flex items-center justify-center w-10 h-10 rounded-full border-none bg-transparent text-ui-dim cursor-pointer transition-all hover:bg-ui-hover hover:text-ui-text active:scale-95',
    }
})