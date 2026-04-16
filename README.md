# Ferrum

一款基于 **Tauri + Vue 3 + TypeScript** 构建的高性能本地图像查看器，致力于提供流畅的浏览体验。

## 特性

- **广泛的图像格式支持**
  - 原生格式：JPG、PNG、GIF、WebP 等
  - **TODO** 转码格式：TGA、TIFF、DDS、JXL、EXR 等
  - **TODO** RAW 相机格式：RW2、ARW、NEF、CR2、CR3、DNG、ORF、RAF
- **双模式浏览**
  - **库模式**：树形文件夹侧边栏 + 平铺图像网格，快速定位和管理大量图片
  - **单图模式**：全屏查看，支持缩放、拖拽、适应窗口
- **高效交互**
  - 自定义无边框窗口，支持鼠标拖拽移动
  - 可自定义鼠标按键绑定（左键、右键、中键、侧键、滚轮）
  - 键盘快捷键支持
  - 拖放文件直接打开
- **实用功能**
  - 单实例运行：新文件自动在已有实例中打开
  - 窗口位置和大小自动记忆
  - RGB 直方图显示
  - 深色/浅色主题切换

## 开发状态

| 功能 | 状态 |
|------|------|
| 核心图像查看 | ✅ 可用 |
| 库浏览（树形 + 平铺） | ✅ 可用 |
| RAW 格式支持 | ⬜ TODO |
| **MFT 快速扫描** | 🚧 **正在开发中** |

> **MFT（Master File Table）快速扫描**：计划通过读取 NTFS MFT 实现超大规模文件夹的秒级扫描，目前相关模块处于积极开发阶段。
>
> **Everything 模式**：使用 VoidTools [Everything](https://www.voidtools.com/) 搜索引擎可实现近乎瞬时的文件发现。如需使用该模式，请先安装 Everything 并确保其正在运行。

## 编译

### 环境要求

- [Node.js](https://nodejs.org/) (建议 LTS)
- [Rust](https://www.rust-lang.org/tools/install)

### 安装依赖

```bash
npm install
```

### 开发运行

```bash
# 同时启动 Vite 开发服务器和 Tauri
npm run tauri dev
```

### 构建发布版

```bash
# 构建生产环境安装包
npm run tauri build

# build without bundle
tauri build --no-bundle
```

## 技术栈

- **前端**：Vue 3 + TypeScript + Vite + Pinia + UnoCSS
- **后端**：Rust + Tauri v2

## 许可证

MIT
