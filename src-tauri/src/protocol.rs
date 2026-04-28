use crate::cache::TRANSCODE_CACHE;
use crate::formats;
use std::fs::File;
use std::io::{BufReader, Cursor};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::Runtime;
use url::Url;

fn error_response(status: StatusCode, msg: String) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain")
        .body(msg.into_bytes())
        .unwrap()
}

pub fn img_protocol_handler<R: Runtime>(
    _ctx: &tauri::UriSchemeContext<'_, R>,
    request: &Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    // 1. CORS Pre-flight
    if request.method() == "OPTIONS" {
        return Response::builder()
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, OPTIONS")
            .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
            .status(StatusCode::NO_CONTENT)
            .body(Vec::new())
            .unwrap();
    }

    // 2. 解析 URL
    let url_str = request.uri().to_string();
    let url = match Url::parse(&url_str) {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[Protocol] URL parse error: {}", e);
            return error_response(StatusCode::BAD_REQUEST, "Invalid URL".into());
        }
    };

    // 3. 路径解码
    let path_str = url.path().trim_start_matches('/');
    let decoded_path = match urlencoding::decode(path_str) {
        Ok(p) => p,
        Err(e) => return error_response(StatusCode::BAD_REQUEST, format!("Decode error: {}", e)),
    };

    // 防止空字节注入
    if decoded_path.contains('\0') {
        return error_response(StatusCode::BAD_REQUEST, "Invalid path".into());
    }

    // 解析为规范化的绝对路径，防止路径穿越攻击
    let canonical_path = match std::fs::canonicalize(decoded_path.as_ref()) {
        Ok(p) => p,
        Err(_) => return error_response(StatusCode::NOT_FOUND, "File not found".into()),
    };

    // 验证是文件而非目录
    if !canonical_path.is_file() {
        return error_response(StatusCode::NOT_FOUND, "Not a file".into());
    }

    let ext = canonical_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();

    // 4. 构建响应头
    let response_builder = Response::builder()
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, "public, max-age=3600");

    // 5. 判断是否需要转码
    if !formats::needs_transcode(&ext) {
        let mime = mime_guess::from_path(&canonical_path).first_or_octet_stream();

        match std::fs::read(&canonical_path) {
            Ok(data) => return response_builder
                .header(header::CONTENT_TYPE, mime.as_ref())
                .body(data)
                .unwrap(),
            Err(e) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        }
    }

    // 6. 转码逻辑 (WebP) - 带缓存
    let cache_key = canonical_path.to_string_lossy().to_string();

    // 先检查缓存
    if let Some(cached_data) = TRANSCODE_CACHE.get(&cache_key) {
        return response_builder
            .header(header::CONTENT_TYPE, "image/webp")
            .header("X-Cache", "HIT")
            .body(cached_data)
            .unwrap();
    }

    // 缓存未命中，执行转码
    let transcode_result: anyhow::Result<Vec<u8>> = (|| {
        let file = File::open(&canonical_path)?;
        let reader = BufReader::new(file);

        // 使用流式解码减少内存占用
        let mut img = image::load(
            reader,
            image::ImageFormat::from_path(&canonical_path).unwrap_or(image::ImageFormat::Jpeg),
        )?;

        // 限制最大分辨率，避免超大图片导致性能问题
        const MAX_DIMENSION: u32 = 4096;
        let (width, height) = (img.width(), img.height());
        if width > MAX_DIMENSION || height > MAX_DIMENSION {
            img = img.resize(
                MAX_DIMENSION,
                MAX_DIMENSION,
                image::imageops::FilterType::Triangle, // 三角滤波器更快
            );
        }

        let mut buffer = Cursor::new(Vec::new());
        img.write_to(&mut buffer, image::ImageFormat::WebP)?;
        Ok(buffer.into_inner())
    })();

    match transcode_result {
        Ok(data) => {
            // 存入缓存
            TRANSCODE_CACHE.put(cache_key, data.clone());

            response_builder
                .header(header::CONTENT_TYPE, "image/webp")
                .header("X-Cache", "MISS")
                .body(data)
                .unwrap()
        }
        Err(e) => error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Transcode failed: {}", e),
        ),
    }
}
