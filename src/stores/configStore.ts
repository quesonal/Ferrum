import {defineStore} from 'pinia';
import {ref, watch} from 'vue';
import {invoke} from '@tauri-apps/api/core';

export enum MouseAction {
    None = 'none',
    FullScreen = 'full_screen',
    Maximize = 'maximize',
    Minimize = 'minimize',
    Exit = 'exit',
    OpenFile = 'open_file',
    OpenFolder = 'open_folder',
    NextImage = 'next_image',
    PrevImage = 'prev_image',
    FirstImage = 'first_image',
    LastImage = 'last_image',
    Forward10 = 'forward_10',
    Backward10 = 'backward_10',
    ZoomIn = 'zoom_in',
    ZoomOut = 'zoom_out',
    ShowExif = 'show_exif',
    FitWindow = 'fit_window',
}

export enum AppTheme {
    Dark = 'dark',
    Light = 'light',
}

export enum FitMode {
    Contain = 'contain',
    Original = 'original',
}

export enum ScanMode {
    Auto = 'auto',
    Everything = 'everything',
    Mft = 'mft',
    WalkDir = 'walkdir',
}

// 2. 更新接口类型
export interface AppConfig {
    background_color: string;
    default_fit_mode: FitMode;
    show_control_bar: boolean;
    show_histogram: boolean;
    theme: AppTheme;
    mouse_left: MouseAction;
    mouse_right: MouseAction;
    mouse_middle: MouseAction;
    mouse_xbutton1: MouseAction;
    mouse_xbutton2: MouseAction;
    mouse_wheel_up: MouseAction;
    mouse_wheel_down: MouseAction;
    scan_mode: ScanMode;
    scan_folders: string[];
}

export const useConfigStore = defineStore('config', () => {
    const config = ref<AppConfig>({
        background_color: '#ffffff',
        default_fit_mode: FitMode.Contain,
        show_control_bar: true,
        show_histogram: false,
        theme: AppTheme.Light,
        mouse_left: MouseAction.None,
        mouse_right: MouseAction.None,
        mouse_middle: MouseAction.FullScreen,
        mouse_xbutton1: MouseAction.PrevImage,
        mouse_xbutton2: MouseAction.NextImage,
        mouse_wheel_up: MouseAction.ZoomIn,
        mouse_wheel_down: MouseAction.ZoomOut,
        scan_mode: ScanMode.Auto,
        scan_folders: [],
    });

    watch(() => config.value.theme, (newTheme) => {
        applyTheme(newTheme);
    });

    const applyTheme = (theme: AppTheme) => {
        const root = document.documentElement;
        if (theme === AppTheme.Light) {
            root.classList.add('light');
            root.classList.remove('dark');
        } else {
            root.classList.add('dark');
            root.classList.remove('light');
        }
    };

    const syncToCache = (cfg: AppConfig) => {
        // 镜像一份配置到本地存储，仅供 index.html 快速读取
        localStorage.setItem('app_config_cache', JSON.stringify({
            theme: cfg.theme,
            background_color: cfg.background_color
        }));
    };

    const loadConfig = async () => {
        if ((window as any).__APP_CONFIG__) {
            config.value = (window as any).__APP_CONFIG__;
            applyTheme(config.value.theme);
            (window as any).__APP_CONFIG__ = null;
            return;
        }

        try {
            const loaded = await invoke<AppConfig>('load_config_cmd');
            config.value = loaded;
            applyTheme(loaded.theme);
            syncToCache(loaded);
        } catch (e) {
            console.error('Failed to load config:', e);
        }
    };

    const saveConfig = async () => {
        try {
            await invoke('save_config_cmd', {config: config.value});
            syncToCache(config.value);
        } catch (e) {
            console.error('Failed to save config:', e);
        }
    };

    return {
        config,
        loadConfig,
        saveConfig
    };
});