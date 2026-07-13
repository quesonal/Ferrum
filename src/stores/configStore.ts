import {defineStore} from 'pinia';
import {ref, watch} from 'vue';
import {loadConfig as loadConfigCmd, saveConfig as saveConfigCmd} from '../api/commands';
import {takeAppConfig} from '../api/windowEnv';

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
    Zoom = 'zoom',
    ShowExif = 'show_exif',
    FitWindow = 'fit_window',
}

export enum AppTheme {
    Dark = 'dark',
    Light = 'light',
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

    show_control_bar: boolean;
    show_histogram: boolean;
    theme: AppTheme;
    language: string;
    mouse_left: MouseAction;
    mouse_right: MouseAction;
    mouse_middle: MouseAction;
    mouse_xbutton1: MouseAction;
    mouse_xbutton2: MouseAction;
    mouse_wheel_up: MouseAction;
    mouse_wheel_down: MouseAction;
    scan_mode: ScanMode;
    scan_folders: string[];
    delete_confirm: boolean;
}

let syncCacheTimer: number | null = null;

export const useConfigStore = defineStore('config', () => {
    const config = ref<AppConfig>({
        background_color: '#ffffff',

        show_control_bar: true,
        show_histogram: false,
        theme: AppTheme.Light,
        language: 'en',
        mouse_left: MouseAction.None,
        mouse_right: MouseAction.None,
        mouse_middle: MouseAction.FullScreen,
        mouse_xbutton1: MouseAction.PrevImage,
        mouse_xbutton2: MouseAction.NextImage,
        mouse_wheel_up: MouseAction.Zoom,
        mouse_wheel_down: MouseAction.Zoom,
        scan_mode: ScanMode.Auto,
        scan_folders: [],
        delete_confirm: true,
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
        if (syncCacheTimer !== null) {
            clearTimeout(syncCacheTimer);
        }
        syncCacheTimer = window.setTimeout(() => {
            // 镜像一份配置到本地存储，仅供 index.html 快速读取
            localStorage.setItem('app_config_cache', JSON.stringify({
                theme: cfg.theme,
                background_color: cfg.background_color,
                language: cfg.language
            }));
            syncCacheTimer = null;
        }, 500);
    };

    const loadConfig = async () => {
        const fromGlobal = takeAppConfig();
        if (fromGlobal) {
            config.value = fromGlobal;
            applyTheme(config.value.theme);
            return;
        }

        try {
            const loaded = await loadConfigCmd();
            config.value = loaded;
            applyTheme(loaded.theme);
            syncToCache(loaded);
        } catch (e) {
            console.error('Failed to load config:', e);
        }
    };

    const saveConfig = async () => {
        try {
            await saveConfigCmd(config.value);
            syncToCache(config.value);
        } catch (e) {
            console.error('Failed to save config:', e);
        }
    };

    const setLanguage = async (lang: string) => {
        config.value.language = lang;
        await saveConfig();
    };

    return {
        config,
        loadConfig,
        saveConfig,
        setLanguage
    };
});