use crate::cache::TRANSCODE_CACHE;
use crate::formats;
use std::fs::File;
use std::io::{BufReader, Cursor};
use std::path::Path;
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

// `img_protocol_handler` is profiled with `#[tracing::instrument]` so the
// whole request shows up in Perfetto. Child spans are added by hand around
// the heaviest sub-phases so image-switch flame graphs can tell apart:
//   - url_parse           (<1ms typical)
//   - decode_extension    (<1ms)
//   - native_read_file    (fs::read, big chunk of native-format latency)
//   - transcode_decode    (image::load for TIFF/DDS/JXL/EXR/RAW)
//   - transcode_resize    (>4096px images only)
//   - transcode_encode    (WebP write, dominant for transcoded formats)
//   - cache_get / cache_put  (moka operations)
// invoked from JS via `convertFileSrc(path, 'img')`.
#[tracing::instrument(
    name = "img_protocol_handler",
    level = "info",
    skip_all,
    fields(
        method = %request.method(),
        url_full = %request.uri(),
        bytes = tracing::field::Empty,
        cache = tracing::field::Empty,
        ext_kind = tracing::field::Empty,
    )
)]
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

    // 2. URL parse + extension
    let url_str = request.uri().to_string();
    let url = {
        let _s = tracing::info_span!("img_proto::url_parse").entered();
        match Url::parse(&url_str) {
            Ok(u) => u,
            Err(e) => {
                eprintln!("[Protocol] URL parse error: {}", e);
                return error_response(StatusCode::BAD_REQUEST, "Invalid URL".into());
            }
        }
    };

    // 3. 路径解码
    let path_str = url.path().trim_start_matches('/');
    let decoded_path = match urlencoding::decode(path_str) {
        Ok(p) => p.into_owned(),
        Err(e) => return error_response(StatusCode::BAD_REQUEST, format!("Decode error: {}", e)),
    };

    // 防止空字节注入
    if decoded_path.contains('\0') {
        return error_response(StatusCode::BAD_REQUEST, "Invalid path".into());
    }

    // 4. 文件存在性 + 扩展名
    let file_path = Path::new(&decoded_path);
    if !file_path.is_file() {
        return error_response(StatusCode::NOT_FOUND, "Not a file".into());
    }

    let ext = {
        let _s = tracing::info_span!("img_proto::decode_extension").entered();
        file_path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase()
    };

    // 5. 构建响应头
    let response_builder = Response::builder()
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, "public, max-age=3600");

    // 6. native 路径（jpg/png/gif/webp/avif/svg/ico/bmp）
    if !formats::needs_transcode(&ext) {
        tracing::Span::current().record("ext_kind", "native");
        let mime = mime_guess::from_path(file_path).first_or_octet_stream();

        let data = {
            let _s = tracing::info_span!("img_proto::native_read_file").entered();
            match std::fs::read(file_path) {
                Ok(d) => d,
                Err(e) => {
                    return error_response(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
                }
            }
        };
        tracing::Span::current().record("bytes", data.len());
        return response_builder
            .header(header::CONTENT_TYPE, mime.as_ref())
            .body(data)
            .unwrap();
    }

    // 7. transcode 路径 (TIFF/DDS/JXL/EXR/RAW)
    tracing::Span::current().record("ext_kind", "transcode");
    let cache_key = decoded_path.to_string();

    // 先检查缓存
    if let Some(cached_data) = {
        let _s = tracing::info_span!("img_proto::cache_get").entered();
        TRANSCODE_CACHE.get(&cache_key)
    } {
        tracing::Span::current().record("cache", "HIT");
        tracing::Span::current().record("bytes", cached_data.len());
        return response_builder
            .header(header::CONTENT_TYPE, "image/webp")
            .header("X-Cache", "HIT")
            .body(cached_data)
            .unwrap();
    }

    // 缓存未命中，执行完整转码
    let transcode_result: anyhow::Result<Vec<u8>> = (|| {
        let (mut img, _fmt) = {
            let _s = tracing::info_span!("img_proto::transcode_decode").entered();
            let file = File::open(file_path)?;
            let reader = BufReader::new(file);
            let fmt = image::ImageFormat::from_path(file_path).unwrap_or(image::ImageFormat::Jpeg);
            let img = image::load(reader, fmt)?;
            (img, fmt)
        };

        // 限制最大分辨率
        const MAX_DIMENSION: u32 = 4096;
        let (width, height) = (img.width(), img.height());
        if width > MAX_DIMENSION || height > MAX_DIMENSION {
            img = {
                let _s = tracing::info_span!("img_proto::transcode_resize").entered();
                img.resize(
                    MAX_DIMENSION,
                    MAX_DIMENSION,
                    image::imageops::FilterType::Triangle, // 三角滤波器更快
                )
            };
        }

        let mut buffer = Cursor::new(Vec::new());
        let data = {
            let _s = tracing::info_span!("img_proto::transcode_encode").entered();
            img.write_to(&mut buffer, image::ImageFormat::WebP)?;
            buffer.into_inner()
        };
        Ok(data)
    })();

    match transcode_result {
        Ok(data) => {
            tracing::Span::current().record("cache", "MISS");
            tracing::Span::current().record("bytes", data.len());
            // 存入缓存
            {
                let _s = tracing::info_span!("img_proto::cache_put").entered();
                TRANSCODE_CACHE.put(cache_key, data.clone());
            }

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
