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
                }
                :root.light {
                  --ui-bg: #f3f3f3;
                  --ui-border: rgba(0,0,0,0.1);
                  --ui-text: #333333;
                  --ui-text-dim: #666666;
                  --ui-btn-hover: rgba(0,0,0,0.05);
                }
            `
        }
    ],
    shortcuts: {
        'win-btn': 'w-10 h-full flex items-center justify-center border-none bg-transparent text-ui-dim cursor-default transition-colors hover:bg-ui-hover hover:text-ui-text',
        'nav-btn': 'flex items-center justify-center w-10 h-10 rounded-full border-none bg-transparent text-ui-dim cursor-pointer transition-all hover:bg-ui-hover hover:text-ui-text active:scale-95',
    }
})