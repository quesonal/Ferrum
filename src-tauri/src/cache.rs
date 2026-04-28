use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 缓存条目
struct CacheEntry {
    data: Vec<u8>,
    last_accessed: Instant,
}

/// 简单的 LRU 缓存，用于缓存转码后的图片
pub struct TranscodeCache {
    entries: Mutex<HashMap<String, CacheEntry>>,
    max_size: usize,
    ttl: Duration,
}

impl TranscodeCache {
    pub fn new(max_size: usize, ttl_seconds: u64) -> Self {
        Self {
            entries: Mutex::new(HashMap::with_capacity(max_size)),
            max_size,
            ttl: Duration::from_secs(ttl_seconds),
        }
    }

    /// 获取缓存的图片数据
    pub fn get(&self, path: &str) -> Option<Vec<u8>> {
        let mut entries = self.entries.lock().expect("cache mutex poisoned");

        if let Some(entry) = entries.get_mut(path) {
            // 检查是否过期
            if entry.last_accessed.elapsed() > self.ttl {
                entries.remove(path);
                return None;
            }

            entry.last_accessed = Instant::now();
            return Some(entry.data.clone());
        }

        None
    }

    /// 添加图片到缓存
    pub fn put(&self, path: String, data: Vec<u8>) {
        let mut entries = self.entries.lock().expect("cache mutex poisoned");

        // 如果缓存已满，移除最旧的条目
        if entries.len() >= self.max_size && !entries.contains_key(&path) {
            if let Some(oldest_key) = entries
                .iter()
                .min_by_key(|(_, v)| v.last_accessed)
                .map(|(k, _)| k.clone())
            {
                entries.remove(&oldest_key);
            }
        }

        entries.insert(path, CacheEntry {
            data,
            last_accessed: Instant::now(),
        });
    }

    /// 清空缓存
    pub fn clear(&self) {
        let mut entries = self.entries.lock().expect("cache mutex poisoned");
        entries.clear();
    }
}

/// 全局转码缓存实例（最多缓存 20 张图片，每张存活 5 分钟）
use once_cell::sync::Lazy;
pub static TRANSCODE_CACHE: Lazy<TranscodeCache> =
    Lazy::new(|| TranscodeCache::new(20, 300));
