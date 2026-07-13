# Ferrum

一款基于 **Tauri + Vue 3 + TypeScript** 构建的高性能本地图像查看器，
兼顾广泛格式支持与本地化的图像库管理。

## 特性

### 图像格式

- **原生格式**：JPG、PNG、GIF、WebP、AVIF 等
- **转码格式**：TGA、TIFF、DDS、JXL、EXR 等（按需实时转码为 WebP 预览）
- **RAW 相机格式**：🚧 暂未实现（计划中：RW2、ARW、NEF、CR2、CR3、DNG、ORF、RAF）

### 浏览模式

- **库模式**：树形文件夹侧栏 + 平铺图像网格；预生成 WebP 预览，快速切换
- **单图模式**：全屏查看，A/B 双槽热切换；长按方向键自动快翻（fast/slow 状态机 + 节流）

### 图像库

- Rust 索引引擎 `index_vault`（桶文件预览 + 直读 `pread` / `NtReadFile`，不经 SQLite）
- 三种已实现扫描模式：Auto / Everything / WalkDir
- 🚧 **MFT（NTFS Master File Table）扫描暂未实现**，正在开发中；目标是通过直读 MFT 实现超大规模文件夹的秒级扫描
- 元数据缓存（SQLite WAL + sea-orm）：EXIF + RGB 直方图，库模式下切换图片亚 10ms 出图
- 启动时后台回填历史图片的元数据

### 标签系统

- 用户自定义标签，图片多标签归属（FK CASCADE）
- 侧栏点击标签过滤网格；图片查看时可附加 / 移除标签

### 删除与回收

- `Del` 删除到回收站（可恢复），`Shift+Del` 永久删除
- 可关闭删除前确认对话框

### 交互

- 自定义无边框窗口（TitleBar 组件）
- 7 个鼠标动作可绑定：左 / 右 / 中 / 侧键 ×2 / 滚轮上下
- 键盘快捷键、拖放打开、单实例运行（新文件复用已有窗口）
- 窗口位置 / 尺寸自动记忆、深色 / 浅色主题、中英双语

## 技术栈

**前端**：Vue 3 · TypeScript · Vite · Pinia · UnoCSS（Tailwind + Iconify）· vue-i18n
**后端**：Rust · Tauri v2 · sea-orm · SQLite WAL
**外部 crate**：`index_vault`（扫描 + 桶文件预览 + 库 DB）

## 编译

### 环境要求

- Node.js（LTS）
- Rust toolchain
- Windows / macOS / Linux

### 常用命令

```bash
npm install                # 安装依赖
npm run tauri dev          # 同时启动 Vite dev server 与 Tauri（推荐）
npm run dev                # 仅启动前端 Vite

npm run tauri build        # 构建生产安装包
npm run tauri build -- --no-bundle   # 仅编译不打包
```

### 性能分析（flamegraph）

```bash
npm run flamegraph:dev     # dev 构建 + tracing
npm run flamegraph:build   # release 构建 + 启用 flamegraph feature
npm run flamegraph:run     # 运行 release binary，采集 profile
npm run flamegraph:open    # 打开 Perfetto UI 查看
```

## 架构概览

```
src/                     前端（Vue 3）
├── App.vue              根组件；提供 triggerReady / showConfirm；全局挂载对话框
├── router/              vue-router 配置 + 守卫（按 route 参数 hydrate 各 store）
├── components/          ImageViewer / FlatImageGrid / FolderSidebar /
│                        SettingsModal / ConfirmDialog / TitleBar / 等
├── composables/         usePanZoom（缩放/拖拽数学）· useMouseActions（鼠标派发）
├── stores/              configStore / imageStore（含原始数据 + FIFO 预览缓存）/
│                        libraryStore / tagStore
└── locales/             i18n（en.json / zh-CN.json）

src-tauri/src/           后端（Rust + Tauri v2）
├── commands.rs          Tauri command 入口
├── library.rs           library_* command + LibraryState
├── meta_cache.rs        元数据缓存读写（histogram / EXIF / tag CRUD）
├── migration.rs         sea-orm Migrator（5 表初始化）
└── entity/              sea-orm 实体

preview_manager/index_vault/   外部 crate：扫描 + 桶文件预览 + 库 DB
```

预览缓存采用「**原始 Uint8Array + FIFO（size=10）**」策略，命中时按需
`createObjectURL`，避免 blob URL 撤销后被复用导致的 `ERR_FILE_NOT_FOUND`
（详见 `docs/PREVIEW_CACHE_DESIGN_2026-07-06.md`）。

## 开发说明

- 配置文件 `config.toml` 位于 Tauri `app_config_dir`，字段统一 snake_case
- 新增 `AppConfig` 字段需同步三处：Rust `AppConfig` 结构体 + `Default` impl、
  TS `AppConfig` 接口 + 初始 ref、（如有 UI 暴露）`SettingsModal.vue`
- 用户可见字符串统一走 vue-i18n，新增键需同步 `en.json` / `zh-CN.json`
- 对话框使用 `<Teleport to="body">` + `fixed inset-x-0 top-8 bottom-0`，
  避开 TitleBar；详见 `SettingsModal.vue` / `ConfirmDialog.vue` 规范写法

## 许可证

MIT