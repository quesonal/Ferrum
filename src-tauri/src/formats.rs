use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::HashSet;

// 使用 HashSet 提供 O(1) 的查找性能
pub static NATIVE: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    [
        "jpg", "jpeg", "png", "gif", "webp", "avif", "svg", "ico", "bmp",
    ]
    .into()
});

pub static TRANSCODE: Lazy<HashSet<&'static str>> =
    Lazy::new(|| ["tga", "tiff", "tif", "dds", "jxl", "qoi", "exr"].into());

pub static RAW: Lazy<HashSet<&'static str>> =
    Lazy::new(|| ["rw2", "arw", "nef", "cr2", "cr3", "dng", "orf", "raf"].into());

#[derive(Serialize)]
pub struct ImageSupport {
    pub native: Vec<&'static str>,
    pub transcode: Vec<&'static str>,
    pub raw: Vec<&'static str>,
    pub all: Vec<&'static str>,
}

pub fn is_supported(ext: &str) -> bool {
    let ext = ext.to_lowercase();
    NATIVE.contains(ext.as_str()) || TRANSCODE.contains(ext.as_str()) || RAW.contains(ext.as_str())
}

pub fn needs_transcode(ext: &str) -> bool {
    let ext = ext.to_lowercase();
    TRANSCODE.contains(ext.as_str()) || RAW.contains(ext.as_str())
}

// 仅在前端请求时构建 Vec，避免初始化时进行不必要的内存分配
pub fn get_support_list() -> ImageSupport {
    let mut all = Vec::with_capacity(NATIVE.len() + TRANSCODE.len() + RAW.len());
    all.extend(NATIVE.iter());
    all.extend(TRANSCODE.iter());
    all.extend(RAW.iter());

    // 如果需要排序
    all.sort();

    ImageSupport {
        native: NATIVE.iter().cloned().collect(),
        transcode: TRANSCODE.iter().cloned().collect(),
        raw: RAW.iter().cloned().collect(),
        all,
    }
}
