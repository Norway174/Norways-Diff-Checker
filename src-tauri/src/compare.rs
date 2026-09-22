use base64::Engine;
use calamine::{open_workbook_auto, Reader};
use image::{DynamicImage, ImageBuffer, Rgba, RgbaImage};
use ocrs::{ImageSource, OcrEngine, OcrEngineParams, TextItem};
use pdfium_render::prelude::*;
use regex::Regex;
use rten::Model;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use similar::{ChangeTag, TextDiff};
use std::sync::{Arc, Mutex, OnceLock};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
use walkdir::WalkDir;

fn field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}
fn number(value: &Value, key: &str, default: f64) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(default)
}
fn input_path(value: &Value) -> Result<PathBuf, String> {
    let raw = field(value, "path");
    if raw.is_empty() {
        Err("An input file is missing.".into())
    } else {
        Ok(PathBuf::from(raw))
    }
}
fn read_input(input: &Value) -> Result<String, String> {
    if let Some(text) = input.get("text").and_then(Value::as_str) {
        return Ok(text.into());
    }
    let path = input_path(input)?;
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    if metadata.len() > 512 * 1024 * 1024 {
        return Err("Text input exceeds 512 MB.".into());
    }
    Ok(String::from_utf8_lossy(&fs::read(path).map_err(|e| e.to_string())?).to_string())
}
fn normalize(mut text: String, options: &Value) -> String {
    text = text.replace("\r\n", "\n");
    if let Some(rules) = options.get("ignoreRules").and_then(Value::as_array) {
        for rule in rules {
            let pattern = field(rule, "value");
            if pattern.is_empty() {
                continue;
            }
            let source = if bool_field(rule, "regex") {
                pattern.into()
            } else {
                regex::escape(pattern)
            };
            if let Ok(re) = Regex::new(&source) {
                text = re.replace_all(&text, "").to_string();
            }
        }
    }
    if bool_field(options, "ignoreWhitespace") {
        if let Ok(re) = Regex::new("[ \\t]+") {
            text = re.replace_all(&text, " ").to_string();
        }
    }
    if bool_field(options, "ignoreCase") {
        text = text.to_lowercase();
    }
    text
}
fn text_result(left_text: String, right_text: String, options: &Value) -> Value {
    let left = normalize(left_text.clone(), options);
    let right = normalize(right_text.clone(), options);
    let precision = field(options, "precision");
    let diff = if precision == "character" {
        TextDiff::from_chars(&left, &right)
    } else if precision == "word" {
        TextDiff::from_words(&left, &right)
    } else {
        TextDiff::from_lines(&left, &right)
    };
    let mut chunks: Vec<Value> = Vec::new();
    let (mut left_line, mut right_line, mut left_offset, mut right_offset) =
        (1usize, 1usize, 0usize, 0usize);
    for change in diff.iter_all_changes() {
        let tag = match change.tag() {
            ChangeTag::Delete => "removed",
            ChangeTag::Insert => "added",
            ChangeTag::Equal => "same",
        };
        let text = change.to_string();
        let trimmed = text.strip_suffix('\n').unwrap_or(&text);
        let lines: Vec<&str> = trimmed.split('\n').collect();
        let advance = if precision == "character" || precision == "word" {
            text.matches('\n').count()
        } else {
            lines.len()
        };
        let merge = chunks.last().map(|c| c["type"] == tag).unwrap_or(false);
        if merge {
            let chunk = chunks.last_mut().unwrap();
            let existing = chunk["text"].as_str().unwrap_or("").to_string() + &text;
            chunk["text"] = json!(existing);
            let t = existing.strip_suffix('\n').unwrap_or(&existing);
            chunk["lines"] = json!(t.split('\n').collect::<Vec<_>>());
        } else {
            chunks.push(json!({"type": tag, "text": text, "lines": lines, "leftLine": left_line, "rightLine": right_line,
                "leftOffset": left_offset, "rightOffset": right_offset}));
        }
        if tag != "added" {
            left_line += advance;
            left_offset += text.len();
        }
        if tag != "removed" {
            right_line += advance;
            right_offset += text.len();
        }
    }
    for i in 0..chunks.len() {
        if chunks[i]["type"] == "removed"
            && i + 1 < chunks.len()
            && chunks[i + 1]["type"] == "added"
        {
            let a = chunks[i]["text"].as_str().unwrap_or("").to_string();
            let b = chunks[i + 1]["text"].as_str().unwrap_or("").to_string();
            let character_diff = TextDiff::from_chars(&a, &b);
            let mut removed = Vec::new();
            let mut added = Vec::new();
            for change in character_diff.iter_all_changes() {
                let piece = change.to_string();
                if change.tag() != ChangeTag::Insert {
                    removed
                        .push(json!({"text": piece, "changed": change.tag() == ChangeTag::Delete}));
                }
                if change.tag() != ChangeTag::Delete {
                    added
                        .push(json!({"text": piece, "changed": change.tag() == ChangeTag::Insert}));
                }
            }
            chunks[i]["characterChanges"] = json!(removed);
            chunks[i + 1]["characterChanges"] = json!(added);
        }
    }
    let count = chunks.iter().filter(|c| c["type"] != "same").count();
    json!({"leftText": left_text, "rightText": right_text, "chunks": chunks, "count": count})
}
fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn folder_scan(
    root: &Path,
    patterns: &[String],
    cancelled: &AtomicBool,
) -> Result<BTreeMap<String, Value>, String> {
    let globs = globset::GlobSetBuilder::new();
    let mut builder = globs;
    for pattern in patterns {
        if let Ok(glob) = globset::Glob::new(pattern) {
            builder.add(glob);
        }
    }
    let excluded = builder.build().map_err(|e| e.to_string())?;
    let mut entries = BTreeMap::new();
    let visible = |entry: &walkdir::DirEntry| {
        let Ok(relative) = entry.path().strip_prefix(root) else {
            return false;
        };
        if relative.as_os_str().is_empty() {
            return true;
        }
        let relative = relative.to_string_lossy().replace('\\', "/");
        !excluded.is_match(&relative)
            && !patterns.iter().any(|pattern| {
                !pattern.contains('*')
                    && relative
                        .split('/')
                        .any(|segment| segment.eq_ignore_ascii_case(pattern))
            })
    };
    for entry in WalkDir::new(root)
        .follow_links(false)
        .max_depth(64)
        .into_iter()
        .filter_entry(visible)
    {
        if cancelled.load(Ordering::Relaxed) {
            return Err("Comparison cancelled.".into());
        }
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path() == root || entry.file_type().is_symlink() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0);
        entries.insert(relative.clone(), json!({"relative": relative, "directory": entry.file_type().is_dir(), "size": metadata.len(),
            "modified": modified, "path": entry.path().to_string_lossy()}));
        if entries.len() > 100_000 {
            return Err("Folder comparison exceeds 100,000 entries.".into());
        }
    }
    Ok(entries)
}
fn folder_result(
    request: &Value,
    cancelled: &AtomicBool,
    progress: &impl Fn(Value),
) -> Result<Value, String> {
    let left_root = input_path(&request["left"])?;
    let right_root = input_path(&request["right"])?;
    let patterns = request["options"]["exclusions"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| vec!["node_modules".into(), ".git".into()]);
    progress(json!({"value": 10, "phase": "Scanning left folder"}));
    let left = folder_scan(&left_root, &patterns, cancelled)?;
    progress(json!({"value": 40, "phase": "Scanning right folder"}));
    let right = folder_scan(&right_root, &patterns, cancelled)?;
    let names: BTreeSet<_> = left.keys().chain(right.keys()).cloned().collect();
    let mut entries = Vec::new();
    for (index, name) in names.iter().enumerate() {
        if cancelled.load(Ordering::Relaxed) {
            return Err("Comparison cancelled.".into());
        }
        let a = left.get(name);
        let b = right.get(name);
        let metadata_changed = match (a, b) {
            (Some(a), Some(b)) => {
                a["size"] != b["size"]
                    || (a["modified"].as_f64().unwrap_or(0.0)
                        - b["modified"].as_f64().unwrap_or(0.0))
                    .abs()
                        > 2000.0
            }
            _ => false,
        };
        let mut status = match (a, b) {
            (None, Some(_)) => "added",
            (Some(_), None) => "removed",
            (Some(a), Some(b)) if a["directory"] != b["directory"] || a["size"] != b["size"] => {
                "modified"
            }
            _ => "same",
        };
        let mut left_entry = a.cloned().unwrap_or(Value::Null);
        let mut right_entry = b.cloned().unwrap_or(Value::Null);
        if let (Some(a), Some(b)) = (a, b) {
            if a["directory"] == false && b["directory"] == false && a["size"] == b["size"] {
                let ah = hash_file(Path::new(field(a, "path")))?;
                let bh = hash_file(Path::new(field(b, "path")))?;
                left_entry["hash"] = json!(ah);
                right_entry["hash"] = json!(bh);
                if ah != bh {
                    status = "modified";
                }
            }
            if bool_field(&request["options"], "compareMetadata") && metadata_changed {
                status = "modified";
            }
        }
        entries.push(json!({"relative": name, "left": left_entry, "right": right_entry, "status": status,
            "metadataChanged": metadata_changed, "directory": a.or(b).map(|x| x["directory"].as_bool().unwrap_or(false)).unwrap_or(false)}));
        if index % 30 == 0 {
            progress(
                json!({"value": 40 + (55 * index / names.len().max(1)), "phase": "Comparing folders"}),
            );
        }
    }
    let count = entries.iter().filter(|e| e["status"] != "same").count();
    Ok(json!({"entries": entries, "count": count}))
}
fn encode_png(image: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut output = std::io::Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image.clone())
        .write_to(&mut output, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(output.into_inner())
}
fn data_url(bytes: &[u8]) -> String {
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}
fn save_asset(root: &Path, id: &str, name: &str, image: &RgbaImage) -> Result<String, String> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err("Invalid image asset ID.".into());
    }
    let dir = root.join("cache/comparison-assets").join(id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join(name), encode_png(image)?).map_err(|e| e.to_string())?;
    Ok(format!("http://ndc-asset.localhost/{id}/{name}"))
}
fn load_image(path: &Path) -> Result<DynamicImage, String> {
    if path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .eq_ignore_ascii_case("heic")
    {
        let decoded = heif_oxide::decode_file(path).map_err(|e| e.to_string())?;
        let image = RgbaImage::from_raw(decoded.width, decoded.height, decoded.to_rgba8())
            .ok_or("Invalid decoded HEIC dimensions")?;
        Ok(DynamicImage::ImageRgba8(image))
    } else {
        image::open(path).map_err(|e| e.to_string())
    }
}
fn pdfium(root: &Path) -> Result<Pdfium, String> {
    let library = root.join("dependencies/pdfium/pdfium.dll");
    if !library.exists() {
        return Err("PDFium is required for PDF features. Download it in Settings.".into());
    }
    Ok(Pdfium::new(
        Pdfium::bind_to_library(&library).map_err(|e| e.to_string())?,
    ))
}
fn render_pdf_page(
    root: &Path,
    path: &Path,
    page_number: usize,
    password: Option<&str>,
) -> Result<RgbaImage, String> {
    let engine = pdfium(root)?;
    let document = engine
        .load_pdf_from_file(path, password)
        .map_err(|e| e.to_string())?;
    let index = page_number
        .saturating_sub(1)
        .min(document.pages().len().saturating_sub(1) as usize);
    let page = document
        .pages()
        .get(index as i32)
        .map_err(|e| e.to_string())?;
    let config = PdfRenderConfig::new()
        .set_target_width(1800)
        .set_maximum_height(1800);
    let bitmap = page
        .render_with_config(&config)
        .map_err(|e| e.to_string())?;
    let rendered = bitmap.as_image().map_err(|e| e.to_string())?.to_rgba8();
    Ok(rendered)
}
fn ocr_cache() -> &'static Mutex<Option<Arc<OcrEngine>>> {
    static ENGINE: OnceLock<Mutex<Option<Arc<OcrEngine>>>> = OnceLock::new();
    ENGINE.get_or_init(|| Mutex::new(None))
}
pub(crate) fn clear_ocr_cache() {
    if let Ok(mut cached) = ocr_cache().lock() { *cached = None; }
}
fn ocr_engine(root: &Path) -> Result<Arc<OcrEngine>, String> {
    let dir = root.join("dependencies/ocr");
    let detection_path = dir.join("text-detection.rten");
    let recognition_path = dir.join("text-recognition.rten");
    if !detection_path.exists() || !recognition_path.exists() {
        return Err("OCR models are required for text recognition. Download them in Settings.".into());
    }
    let mut cached = ocr_cache().lock().map_err(|e| e.to_string())?;
    if let Some(engine) = cached.as_ref() { return Ok(engine.clone()); }
    let detection = Model::load_file(detection_path).map_err(|e| e.to_string())?;
    let recognition = Model::load_file(recognition_path).map_err(|e| e.to_string())?;
    let engine = Arc::new(OcrEngine::new(OcrEngineParams {
        detection_model: Some(detection),
        recognition_model: Some(recognition),
        ..Default::default()
    }).map_err(|e| e.to_string())?);
    *cached = Some(engine.clone());
    Ok(engine)
}
fn ocr_image(root: &Path, image: &RgbaImage) -> Result<(String, Vec<Value>), String> {
    let engine = ocr_engine(root)?;
    let rgb = DynamicImage::ImageRgba8(image.clone()).into_rgb8();
    let source =
        ImageSource::from_bytes(rgb.as_raw(), rgb.dimensions()).map_err(|e| e.to_string())?;
    let input = engine.prepare_input(source).map_err(|e| e.to_string())?;
    let detected = engine.detect_words(&input).map_err(|e| e.to_string())?;
    let lines = engine.find_text_lines(&input, &detected);
    let recognized = engine
        .recognize_text(&input, &lines)
        .map_err(|e| e.to_string())?;
    let mut text = Vec::new();
    let mut words = Vec::new();
    for line in recognized.into_iter().flatten() {
        text.push(line.to_string());
        for word in line.words() {
            let bounds = word.bounding_rect();
            words.push(json!({"text":word.to_string(),"x0":bounds.left(),"y0":bounds.top(),"x1":bounds.right(),"y1":bounds.bottom(),"confidence":100}));
        }
    }
    Ok((text.join("\n"), words))
}
fn image_shift(left: &RgbaImage, right: &RgbaImage) -> (i32, i32) {
    let a = DynamicImage::ImageRgba8(left.clone())
        .resize_exact(128, 128, image::imageops::FilterType::Triangle)
        .to_luma8();
    let b = DynamicImage::ImageRgba8(right.clone())
        .resize_exact(128, 128, image::imageops::FilterType::Triangle)
        .to_luma8();
    let mut best = (f64::MAX, 0, 0);
    for dy in (-12i32..=12).step_by(2) {
        for dx in (-12i32..=12).step_by(2) {
            let (mut error, mut samples) = (0u64, 0u64);
            for y in (12i32..116).step_by(3) {
                for x in (12i32..116).step_by(3) {
                    let rx = x - dx;
                    let ry = y - dy;
                    if (0..128).contains(&rx) && (0..128).contains(&ry) {
                        error += (a.get_pixel(x as u32, y as u32)[0] as i16
                            - b.get_pixel(rx as u32, ry as u32)[0] as i16)
                            .unsigned_abs() as u64;
                        samples += 1;
                    }
                }
            }
            let score = error as f64 / samples.max(1) as f64 + (dx.abs() + dy.abs()) as f64 * 0.06;
            if score < best.0 {
                best = (score, dx, dy);
            }
        }
    }
    (
        (best.1 as f64 * left.width().max(right.width()) as f64 / 128.0).round() as i32,
        (best.2 as f64 * left.height().max(right.height()) as f64 / 128.0).round() as i32,
    )
}
fn rotate_image(image: &RgbaImage, degrees: f64) -> RgbaImage {
    if degrees.abs() < 0.001 {
        return image.clone();
    }
    let radians = degrees.to_radians();
    let cos = radians.cos().abs();
    let sin = radians.sin().abs();
    let width = (image.width() as f64 * cos + image.height() as f64 * sin).ceil() as u32;
    let height = (image.width() as f64 * sin + image.height() as f64 * cos).ceil() as u32;
    let mut padded = ImageBuffer::from_pixel(width, height, Rgba([0, 0, 0, 0]));
    image::imageops::overlay(
        &mut padded,
        image,
        ((width - image.width()) / 2) as i64,
        ((height - image.height()) / 2) as i64,
    );
    imageproc::geometric_transformations::rotate_about_center(
        &padded,
        radians as f32,
        imageproc::geometric_transformations::Interpolation::Bilinear,
        imageproc::geometric_transformations::Border::Constant(Rgba([0, 0, 0, 0])),
    )
}
fn perspective_warp(
    image: &RgbaImage,
    horizontal: f64,
    vertical: f64,
) -> Result<RgbaImage, String> {
    if horizontal.abs() < 0.001 && vertical.abs() < 0.001 {
        return Ok(image.clone());
    }
    let (width, height) = image.dimensions();
    if width as u64 * height as u64 > 30_000_000 {
        return Err("Perspective adjustment supports images up to 30 million pixels.".into());
    }
    let hx = horizontal.clamp(-45.0, 45.0) * width as f64 / 100.0;
    let vy = vertical.clamp(-45.0, 45.0) * height as f64 / 100.0;
    let target = [
        (hx, vy),
        (width as f64 - 1.0 - hx, 0.0),
        (0.0, height as f64 - 1.0 - vy),
        (width as f64 - 1.0, height as f64 - 1.0),
    ];
    let source = [
        (0.0, 0.0),
        (width as f64 - 1.0, 0.0),
        (0.0, height as f64 - 1.0),
        (width as f64 - 1.0, height as f64 - 1.0),
    ];
    let mut equations = [[0.0f64; 9]; 8];
    for i in 0..4 {
        let (x, y) = target[i];
        let (u, v) = source[i];
        equations[2 * i] = [x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y, u];
        equations[2 * i + 1] = [0.0, 0.0, 0.0, x, y, 1.0, -v * x, -v * y, v];
    }
    for col in 0..8 {
        let mut pivot = col;
        for row in col + 1..8 {
            if equations[row][col].abs() > equations[pivot][col].abs() {
                pivot = row;
            }
        }
        if equations[pivot][col].abs() < 1e-9 {
            return Err("Perspective adjustment is too extreme.".into());
        }
        equations.swap(col, pivot);
        let divisor = equations[col][col];
        for item in col..9 {
            equations[col][item] /= divisor;
        }
        for row in 0..8 {
            if row == col {
                continue;
            }
            let factor = equations[row][col];
            for item in col..9 {
                equations[row][item] -= factor * equations[col][item];
            }
        }
    }
    let h = equations.map(|row| row[8]);
    let mut output = ImageBuffer::from_pixel(width, height, Rgba([0, 0, 0, 0]));
    for y in 0..height {
        for x in 0..width {
            let d = h[6] * x as f64 + h[7] * y as f64 + 1.0;
            let sx = (h[0] * x as f64 + h[1] * y as f64 + h[2]) / d;
            let sy = (h[3] * x as f64 + h[4] * y as f64 + h[5]) / d;
            if sx < 0.0
                || sy < 0.0
                || sx >= width.saturating_sub(1) as f64
                || sy >= height.saturating_sub(1) as f64
            {
                continue;
            }
            let x0 = sx.floor() as u32;
            let y0 = sy.floor() as u32;
            let fx = sx - x0 as f64;
            let fy = sy - y0 as f64;
            let a = image.get_pixel(x0, y0).0;
            let b = image.get_pixel(x0 + 1, y0).0;
            let c = image.get_pixel(x0, y0 + 1).0;
            let e = image.get_pixel(x0 + 1, y0 + 1).0;
            let mut pixel = [0u8; 4];
            for i in 0..4 {
                pixel[i] = (a[i] as f64 * (1.0 - fx) * (1.0 - fy)
                    + b[i] as f64 * fx * (1.0 - fy)
                    + c[i] as f64 * (1.0 - fx) * fy
                    + e[i] as f64 * fx * fy)
                    .round() as u8;
            }
            output.put_pixel(x, y, Rgba(pixel));
        }
    }
    Ok(output)
}
fn exif_details(path: &Path) -> Value {
    let Ok(file) = File::open(path) else {
        return json!({});
    };
    let Ok(exif) = exif::Reader::new().read_from_container(&mut std::io::BufReader::new(file))
    else {
        return json!({});
    };
    let mut map = serde_json::Map::new();
    for field in exif.fields() {
        map.insert(
            format!("{}", field.tag),
            json!(field.display_value().with_unit(&exif).to_string()),
        );
    }
    Value::Object(map)
}
pub fn preview(input: &Value, _root: &Path) -> Result<Value, String> {
    let path = input_path(input)?;
    if path
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .eq_ignore_ascii_case("pdf")
    {
        return Ok(Value::Null);
    }
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 256 * 1024 * 1024 {
        return Err("Image preview exceeds 256 MB.".into());
    }
    let image = load_image(&path)?;
    let thumb = image.thumbnail(1800, 1800).to_rgba8();
    Ok(json!(data_url(&encode_png(&thumb)?)))
}
fn image_result(
    request: &Value,
    root: &Path,
    cancelled: &AtomicBool,
    progress: &impl Fn(Value),
) -> Result<Value, String> {
    progress(json!({"value": 10, "phase": "Decoding images"}));
    let left_path = input_path(&request["left"])?;
    let right_path = input_path(&request["right"])?;
    let page = number(&request["options"], "page", 1.0).max(1.0) as usize;
    let left_source = if left_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .eq_ignore_ascii_case("pdf")
    {
        render_pdf_page(
            root,
            &left_path,
            page,
            request["options"]["password"].as_str(),
        )?
    } else {
        load_image(&left_path)?.to_rgba8()
    };
    let mut right_source = if right_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .eq_ignore_ascii_case("pdf")
    {
        render_pdf_page(
            root,
            &right_path,
            page,
            request["options"]["password"].as_str(),
        )?
    } else {
        load_image(&right_path)?.to_rgba8()
    };
    let options = &request["options"];
    if bool_field(options, "flipX") {
        image::imageops::flip_horizontal_in_place(&mut right_source);
    }
    if bool_field(options, "flipY") {
        image::imageops::flip_vertical_in_place(&mut right_source);
    }
    let scale = (number(options, "scale", 100.0) / 100.0).clamp(0.1, 4.0);
    if (scale - 1.0).abs() > f64::EPSILON {
        right_source = image::imageops::resize(
            &right_source,
            (right_source.width() as f64 * scale).round().max(1.0) as u32,
            (right_source.height() as f64 * scale).round().max(1.0) as u32,
            image::imageops::FilterType::Lanczos3,
        );
    }
    right_source = rotate_image(&right_source, number(options, "rotation", 0.0));
    right_source = perspective_warp(
        &right_source,
        number(options, "perspectiveX", 0.0),
        number(options, "perspectiveY", 0.0),
    )?;
    let automatic = if bool_field(options, "autoAlign") {
        image_shift(&left_source, &right_source)
    } else {
        (0, 0)
    };
    let offset_x = number(options, "offsetX", 0.0).round() as i32 + automatic.0;
    let offset_y = number(options, "offsetY", 0.0).round() as i32 + automatic.1;
    let left_x = 0.max(-offset_x) as u32;
    let left_y = 0.max(-offset_y) as u32;
    let right_x = (left_x as i32 + offset_x) as u32;
    let right_y = (left_y as i32 + offset_y) as u32;
    let width = (left_x + left_source.width()).max(right_x + right_source.width());
    let height = (left_y + left_source.height()).max(right_y + right_source.height());
    if width as u64 * height as u64 > 250_000_000 {
        return Err("Aligned image canvas exceeds 250 megapixels.".into());
    }
    let mut left = ImageBuffer::from_pixel(width, height, Rgba([0, 0, 0, 0]));
    let mut right = left.clone();
    image::imageops::overlay(&mut left, &left_source, left_x.into(), left_y.into());
    image::imageops::overlay(&mut right, &right_source, right_x.into(), right_y.into());
    progress(json!({"value": 50, "phase": "Comparing pixels"}));
    let threshold = number(options, "threshold", 24.0).clamp(0.0, 255.0) as i16;
    let mut diff = ImageBuffer::from_pixel(width, height, Rgba([0, 0, 0, 0]));
    let mut subtract = ImageBuffer::from_pixel(width, height, Rgba([0, 0, 0, 255]));
    let mut mask = vec![false; width as usize * height as usize];
    let mut changed = 0usize;
    let mut bounds = (width, height, 0u32, 0u32);
    for y in 0..height {
        for x in 0..width {
            if cancelled.load(Ordering::Relaxed) {
                return Err("Comparison cancelled.".into());
            }
            let a = left.get_pixel(x, y).0;
            let b = right.get_pixel(x, y).0;
            let delta = (0..4)
                .map(|i| (a[i] as i16 - b[i] as i16).abs())
                .max()
                .unwrap_or(0);
            subtract.put_pixel(
                x,
                y,
                Rgba([
                    (a[0] as i16 - b[0] as i16).unsigned_abs() as u8,
                    (a[1] as i16 - b[1] as i16).unsigned_abs() as u8,
                    (a[2] as i16 - b[2] as i16).unsigned_abs() as u8,
                    255,
                ]),
            );
            if delta > threshold {
                diff.put_pixel(x, y, Rgba([240, 75, 75, 255]));
                mask[(y * width + x) as usize] = true;
                changed += 1;
                bounds.0 = bounds.0.min(x);
                bounds.1 = bounds.1.min(y);
                bounds.2 = bounds.2.max(x);
                bounds.3 = bounds.3.max(y);
            }
        }
    }
    let mut regions: Vec<Value> = Vec::new();
    for start in 0..mask.len() {
        if !mask[start] {
            continue;
        }
        let mut queue = VecDeque::from([start]);
        mask[start] = false;
        let (mut x0, mut y0, mut x1, mut y1, mut area) = (width, height, 0u32, 0u32, 0usize);
        while let Some(index) = queue.pop_front() {
            let x = index as u32 % width;
            let y = index as u32 / width;
            area += 1;
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
            for next in [
                if x > 0 { Some(index - 1) } else { None },
                if x + 1 < width { Some(index + 1) } else { None },
                if y > 0 {
                    Some(index - width as usize)
                } else {
                    None
                },
                if y + 1 < height {
                    Some(index + width as usize)
                } else {
                    None
                },
            ]
            .into_iter()
            .flatten()
            {
                if mask[next] {
                    mask[next] = false;
                    queue.push_back(next);
                }
            }
        }
        if area >= number(options, "minRegionSize", 1.0).max(1.0) as usize {
            regions.push(json!({"x":x0,"y":y0,"width":x1-x0+1,"height":y1-y0+1,"pixels":area}));
        }
    }
    regions.sort_by_key(|r| std::cmp::Reverse(r["pixels"].as_u64().unwrap_or(0)));
    let gap = number(options, "regionGap", 0.0).clamp(0.0, 100.0) as u64;
    if gap > 0 && regions.len() <= 10_000 {
        let mut i = 0;
        while i < regions.len() {
            let mut j = i + 1;
            while j < regions.len() {
                let a = &regions[i];
                let b = &regions[j];
                let (ax, ay, aw, ah) = (
                    a["x"].as_u64().unwrap_or(0),
                    a["y"].as_u64().unwrap_or(0),
                    a["width"].as_u64().unwrap_or(0),
                    a["height"].as_u64().unwrap_or(0),
                );
                let (bx, by, bw, bh) = (
                    b["x"].as_u64().unwrap_or(0),
                    b["y"].as_u64().unwrap_or(0),
                    b["width"].as_u64().unwrap_or(0),
                    b["height"].as_u64().unwrap_or(0),
                );
                if ax <= bx + bw + gap
                    && bx <= ax + aw + gap
                    && ay <= by + bh + gap
                    && by <= ay + ah + gap
                {
                    let x = ax.min(bx);
                    let y = ay.min(by);
                    let w = (ax + aw).max(bx + bw) - x;
                    let h = (ay + ah).max(by + bh) - y;
                    let pixels = regions[i]["pixels"].as_u64().unwrap_or(0)
                        + regions[j]["pixels"].as_u64().unwrap_or(0);
                    regions[i] = json!({"x":x,"y":y,"width":w,"height":h,"pixels":pixels});
                    regions.remove(j);
                    i = 0;
                    break;
                } else {
                    j += 1;
                }
            }
            if j >= regions.len() {
                i += 1;
            }
        }
        regions.sort_by_key(|r| std::cmp::Reverse(r["pixels"].as_u64().unwrap_or(0)));
    }
    for region in regions.iter_mut().take(30) {
        let x = region["x"].as_u64().unwrap_or(0) as u32;
        let y = region["y"].as_u64().unwrap_or(0) as u32;
        let w = region["width"].as_u64().unwrap_or(1) as u32;
        let h = region["height"].as_u64().unwrap_or(1) as u32;
        let l = image::imageops::crop_imm(&left, x, y, w, h).to_image();
        let r = image::imageops::crop_imm(&right, x, y, w, h).to_image();
        region["previewLeft"] = json!(data_url(&encode_png(
            &DynamicImage::ImageRgba8(l).thumbnail(96, 64).to_rgba8()
        )?));
        region["previewRight"] = json!(data_url(&encode_png(
            &DynamicImage::ImageRgba8(r).thumbnail(96, 64).to_rgba8()
        )?));
    }
    let asset_id = field(request, "id");
    let left_data = save_asset(root, asset_id, "left.png", &left)?;
    let right_data = save_asset(root, asset_id, "right.png", &right)?;
    let source_left = save_asset(root, asset_id, "source-left.png", &left_source)?;
    let source_right = save_asset(root, asset_id, "source-right.png", &right_source)?;
    let diff_data = save_asset(root, asset_id, "diff.png", &diff)?;
    let subtract_data = save_asset(root, asset_id, "subtract.png", &subtract)?;
    let stat_left = fs::metadata(&left_path).map_err(|e| e.to_string())?;
    let stat_right = fs::metadata(&right_path).map_err(|e| e.to_string())?;
    let (left_ocr, left_words, right_ocr, right_words) = if bool_field(options, "ocr") {
        progress(json!({"value":85,"phase":"Reading text in images"}));
        let (lt, lw) = ocr_image(root, &left)?;
        let (rt, rw) = ocr_image(root, &right)?;
        (Some(lt), Some(lw), Some(rt), Some(rw))
    } else {
        (None, None, None, None)
    };
    let left_exif = exif_details(&left_path);
    let right_exif = exif_details(&right_path);
    Ok(
        json!({"assetId":asset_id,"leftData":left_data,"rightData":right_data,"displayLeftData":null,"displayRightData":null,
        "splitLeftData":source_left,"splitRightData":source_right,"splitLeftWidth":left_source.width(),"splitLeftHeight":left_source.height(),
        "splitRightWidth":right_source.width(),"splitRightHeight":right_source.height(),"diffData":diff_data,"subtractData":subtract_data,
        "width":width,"height":height,"changed":changed,"count":regions.len(),"alignment":{"offsetX":offset_x,"offsetY":offset_y,"automatic":{"x":automatic.0,"y":automatic.1}},
        "bounds": if changed>0 {json!({"x":bounds.0,"y":bounds.1,"width":bounds.2-bounds.0+1,"height":bounds.3-bounds.1+1})} else {Value::Null},
        "regions":regions,"leftExif":left_exif,"rightExif":right_exif,"leftOcr":left_ocr,"rightOcr":right_ocr,"leftOcrWords":left_words,"rightOcrWords":right_words,
        "leftDetails":{"width":left_source.width(),"height":left_source.height(),"bytes":stat_left.len(),"exif":left_exif},
        "rightDetails":{"width":right_source.width(),"height":right_source.height(),"bytes":stat_right.len(),"exif":right_exif}}),
    )
}

pub fn run(
    request: &Value,
    root: &Path,
    cancelled: &AtomicBool,
    progress: impl Fn(Value),
) -> Result<Value, String> {
    let result = match field(request, "type") {
        "text" => {
            progress(json!({"value":15,"phase":"Reading text"}));
            let left = read_input(&request["left"])?;
            let right = read_input(&request["right"])?;
            progress(json!({"value":70,"phase":"Finding changes"}));
            text_result(left, right, &request["options"])
        }
        "folders" => folder_result(request, cancelled, &progress)?,
        "images" => image_result(request, root, cancelled, &progress)?,
        "excel" => excel_result(request, &progress)?,
        "documents" => document_result(request, root, &progress)?,
        _ => return Err("Unknown comparison mode".into()),
    };
    progress(json!({"value":100,"phase":"Complete"}));
    Ok(result)
}

fn excel_result(request: &Value, progress: &impl Fn(Value)) -> Result<Value, String> {
    progress(json!({"value":10,"phase":"Reading spreadsheets"}));
    let (left_sheets, left_name, mut left_rows, left_cols) = read_spreadsheet(
        &input_path(&request["left"])?,
        field(&request["options"], "leftSheet"),
    )?;
    let (right_sheets, right_name, mut right_rows, right_cols) = read_spreadsheet(
        &input_path(&request["right"])?,
        field(&request["options"], "rightSheet"),
    )?;
    let options = &request["options"];
    let column_positions = if options["alignColumns"] != false {
        let headers = |rows: &Vec<Vec<Value>>, count: usize| {
            (0..count)
                .map(|c| {
                    rows.first()
                        .and_then(|r| r.get(c))
                        .map(|x| cell_display(x, options))
                        .unwrap_or_default()
                })
                .collect::<Vec<_>>()
        };
        align_keys(
            &headers(&left_rows, left_cols),
            &headers(&right_rows, right_cols),
        )
    } else {
        (0..left_cols.max(right_cols))
            .map(|c| {
                (
                    if c < left_cols { Some(c) } else { None },
                    if c < right_cols { Some(c) } else { None },
                )
            })
            .collect()
    };
    let align_columns = |rows: Vec<Vec<Value>>, left_side: bool| {
        rows.into_iter()
            .map(|row| {
                column_positions
                    .iter()
                    .map(|(l, r)| {
                        if let Some(c) = if left_side { l } else { r } {
                            row.get(*c).cloned().unwrap_or(Value::Null)
                        } else {
                            Value::Null
                        }
                    })
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>()
    };
    left_rows = align_columns(left_rows, true);
    right_rows = align_columns(right_rows, false);
    let mut left_sources: Vec<usize> = (1..=left_rows.len()).collect();
    let mut right_sources: Vec<usize> = (1..=right_rows.len()).collect();
    let sort_col = field(options, "sortColumn")
        .bytes()
        .fold(0usize, |n, b| {
            if b.is_ascii_alphabetic() {
                n * 26 + (b.to_ascii_uppercase() - b'A' + 1) as usize
            } else {
                n
            }
        })
        .saturating_sub(1);
    if !field(options, "sortColumn").is_empty() {
        let sort = |rows: &mut Vec<Vec<Value>>, sources: &mut Vec<usize>| {
            let mut paired: Vec<_> = rows.drain(..).zip(sources.drain(..)).collect();
            if paired.len() > 1 {
                let head = paired.remove(0);
                paired.sort_by(|a, b| {
                    cell_display(a.0.get(sort_col).unwrap_or(&Value::Null), options).cmp(
                        &cell_display(b.0.get(sort_col).unwrap_or(&Value::Null), options),
                    )
                });
                paired.insert(0, head);
            }
            for (row, source) in paired {
                rows.push(row);
                sources.push(source);
            }
        };
        sort(&mut left_rows, &mut left_sources);
        sort(&mut right_rows, &mut right_sources);
    }
    let row_positions = if options["alignRows"] != false {
        let key = |row: &Vec<Value>| {
            row.first()
                .map(|v| cell_display(v, options))
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| {
                    row.iter()
                        .map(|v| cell_display(v, options))
                        .collect::<Vec<_>>()
                        .join("\u{1}")
                })
        };
        align_keys(
            &left_rows.iter().map(key).collect::<Vec<_>>(),
            &right_rows.iter().map(key).collect::<Vec<_>>(),
        )
    } else {
        (0..left_rows.len().max(right_rows.len()))
            .map(|r| {
                (
                    if r < left_rows.len() { Some(r) } else { None },
                    if r < right_rows.len() { Some(r) } else { None },
                )
            })
            .collect()
    };
    let paired_left = row_positions
        .iter()
        .map(|(l, _)| {
            l.and_then(|i| left_rows.get(i).cloned())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>();
    let paired_right = row_positions
        .iter()
        .map(|(_, r)| {
            r.and_then(|i| right_rows.get(i).cloned())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>();
    let row_positions: Vec<Value> = row_positions
        .iter()
        .map(|(l, r)| json!({"left":l.map(|i|left_sources[i]),"right":r.map(|i|right_sources[i])}))
        .collect();
    let column_positions: Vec<Value> = column_positions
        .iter()
        .map(|(l, r)| json!({"left":l,"right":r}))
        .collect();
    left_rows = paired_left;
    right_rows = paired_right;
    let max_rows = left_rows.len().max(right_rows.len());
    let max_cols = column_positions.len();
    let mut changed = Vec::new();
    for row in 0..max_rows {
        for col in 0..max_cols {
            let a = left_rows.get(row).and_then(|r| r.get(col));
            let b = right_rows.get(row).and_then(|r| r.get(col));
            let av = a.and_then(|x| x["display"].as_str()).unwrap_or("");
            let bv = b.and_then(|x| x["display"].as_str()).unwrap_or("");
            if normalized_cell(&cell_display(a.unwrap_or(&Value::Null), options), options)
                != normalized_cell(&cell_display(b.unwrap_or(&Value::Null), options), options)
            {
                changed.push(json!({"row":row,"col":col,"left":av,"right":bv,
            "leftFormula":a.map(|x|field(x,"formula")).unwrap_or(""),"rightFormula":b.map(|x|field(x,"formula")).unwrap_or(""),
            "leftRow":row_positions[row]["left"],"rightRow":row_positions[row]["right"],
            "leftColumn":column_positions[col]["left"],"rightColumn":column_positions[col]["right"]}));
            }
        }
    }
    progress(json!({"value":90,"phase":"Comparing cells"}));
    Ok(
        json!({"leftSheets":left_sheets,"rightSheets":right_sheets,"leftName":left_name,"rightName":right_name,
        "leftRows":left_rows,"rightRows":right_rows,"rowPositions":row_positions,"columnPositions":column_positions,
        "count":changed.len(),"changed":changed,"details":[{"label":"Sheets","left":left_sheets.len(),"right":right_sheets.len()},
            {"label":"Rows","left":left_rows.len(),"right":right_rows.len()}]}),
    )
}
fn read_spreadsheet(
    path: &Path,
    preferred: &str,
) -> Result<(Vec<String>, String, Vec<Vec<Value>>, usize), String> {
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ["csv", "tsv", "txt"].contains(&extension.as_str()) {
        let bytes = fs::read(path).map_err(|e| e.to_string())?;
        if bytes.len() > 512 * 1024 * 1024 {
            return Err("Spreadsheet input exceeds 512 MB.".into());
        }
        let content = String::from_utf8_lossy(&bytes);
        let content = content.trim_start_matches('\u{feff}');
        let delimiter = if extension == "tsv" || extension == "txt" && content.contains('\t') {
            b'\t'
        } else {
            b','
        };
        let mut reader = csv::ReaderBuilder::new()
            .has_headers(false)
            .flexible(true)
            .delimiter(delimiter)
            .from_reader(content.as_bytes());
        let mut rows = Vec::new();
        let mut width = 0usize;
        for record in reader.records() {
            let record = record.map_err(|e| e.to_string())?;
            width = width.max(record.len());
            rows.push(
                record
                    .iter()
                    .map(|v| json!({"value":v,"display":v,"formula":""}))
                    .collect::<Vec<_>>(),
            );
            if rows.len() > 1_000_000 || rows.len() * width > 2_000_000 {
                return Err("Spreadsheet exceeds the 2,000,000-cell limit.".into());
            }
        }
        let name = "Sheet1".to_string();
        return Ok((vec![name.clone()], name, rows, width));
    }
    let mut book = open_workbook_auto(path).map_err(|e| e.to_string())?;
    let sheets = book.sheet_names().to_vec();
    let name = if preferred.is_empty() || !sheets.iter().any(|s| s == preferred) {
        sheets
            .first()
            .cloned()
            .ok_or("Spreadsheet contains no sheets")?
    } else {
        preferred.to_string()
    };
    let range = book.worksheet_range(&name).map_err(|e| e.to_string())?;
    if range.height() > 1_000_000
        || range.width() > 16_384
        || range.height() * range.width() > 2_000_000
    {
        return Err("Spreadsheet exceeds the 2,000,000-cell limit.".into());
    }
    let formulas = book.worksheet_formula(&name).ok();
    let start = range.start().unwrap_or((0, 0));
    let rows = range
        .rows()
        .enumerate()
        .map(|(r, row)| {
            row.iter()
                .enumerate()
                .map(|(c, cell)| {
                    let formula = formulas
                        .as_ref()
                        .and_then(|f| f.get_value((start.0 + r as u32, start.1 + c as u32)))
                        .cloned()
                        .unwrap_or_default();
                    json!({"value":cell.to_string(),"display":cell.to_string(),"formula":formula})
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    Ok((sheets, name, rows, range.width()))
}

fn normalized_cell(value: &str, options: &Value) -> String {
    let mut text = value.to_string();
    if ["US", "EU"].contains(&field(options, "dateOrder")) {
        let parts = text.split(['.', '/', '-']).collect::<Vec<_>>();
        if parts.len() == 3 && parts[2].len() == 4 {
            if let (Ok(first), Ok(second), Ok(year)) = (
                parts[0].parse::<u32>(),
                parts[1].parse::<u32>(),
                parts[2].parse::<u32>(),
            ) {
                let (month, day) = if field(options, "dateOrder") == "US" {
                    (first, second)
                } else {
                    (second, first)
                };
                if (1..=12).contains(&month) && (1..=31).contains(&day) {
                    text = format!("{year:04}-{month:02}-{day:02}");
                }
            }
        }
    }
    if bool_field(options, "ignoreWhitespace") {
        text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    }
    if bool_field(options, "ignoreCase") {
        text = text.to_lowercase();
    }
    text
}
fn cell_display(cell: &Value, options: &Value) -> String {
    let formula = field(cell, "formula");
    if bool_field(options, "formulas") && !formula.is_empty() {
        format!("={formula}")
    } else {
        field(cell, "display").to_string()
    }
}
fn align_keys(left: &[String], right: &[String]) -> Vec<(Option<usize>, Option<usize>)> {
    let hash_lines = |items: &[String]| {
        items
            .iter()
            .map(|item| format!("{:x}\n", Sha256::digest(item.as_bytes())))
            .collect::<String>()
    };
    let a = hash_lines(left);
    let b = hash_lines(right);
    let diff = TextDiff::from_lines(&a, &b);
    let mut result = Vec::new();
    let (mut l, mut r) = (0usize, 0usize);
    let mut pending_left = Vec::new();
    let mut pending_right = Vec::new();
    let flush = |output: &mut Vec<(Option<usize>, Option<usize>)>,
                 removed: &mut Vec<usize>,
                 added: &mut Vec<usize>| {
        let len = removed.len().max(added.len());
        for i in 0..len {
            output.push((removed.get(i).copied(), added.get(i).copied()));
        }
        removed.clear();
        added.clear();
    };
    for change in diff.iter_all_changes() {
        match change.tag() {
            ChangeTag::Equal => {
                flush(&mut result, &mut pending_left, &mut pending_right);
                result.push((Some(l), Some(r)));
                l += 1;
                r += 1;
            }
            ChangeTag::Delete => {
                pending_left.push(l);
                l += 1;
            }
            ChangeTag::Insert => {
                pending_right.push(r);
                r += 1;
            }
        }
    }
    flush(&mut result, &mut pending_left, &mut pending_right);
    result
}

fn document_text(root: &Path, path: &Path, side: &str, options: &Value) -> Result<String, String> {
    let extension = path
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if extension == "pdf" {
        let engine = pdfium(root)?;
        let document = engine
            .load_pdf_from_file(path, options["password"].as_str())
            .map_err(|e| e.to_string())?;
        if document.pages().len() > 2000 {
            return Err("PDF has more than 2,000 pages.".into());
        }
        let mut pages = Vec::new();
        for index in 0..document.pages().len() {
            let page = document.pages().get(index).map_err(|e| e.to_string())?;
            let mut text = page.text().map_err(|e| e.to_string())?.all();
            if text.trim().is_empty() && bool_field(options, "ocr") {
                let rendered = page
                    .render_with_config(&PdfRenderConfig::new().set_target_width(1800))
                    .map_err(|e| e.to_string())?;
                text = ocr_image(root, &rendered.as_image().map_err(|e| e.to_string())?.to_rgba8())?.0;
            }
            pages.push(text);
        }
        if side == "right" {
            if let Some(order) = options["rightPageOrder"].as_array() {
                let mut reordered = Vec::new();
                let mut used = BTreeSet::new();
                for item in order {
                    if let Some(index) = item
                        .as_u64()
                        .and_then(|i| i.checked_sub(1))
                        .map(|i| i as usize)
                    {
                        if index < pages.len() && used.insert(index) {
                            reordered.push(pages[index].clone());
                        }
                    }
                }
                for (index, page) in pages.iter().enumerate() {
                    if used.insert(index) {
                        reordered.push(page.clone());
                    }
                }
                pages = reordered;
            }
        }
        return Ok(pages.join("\n\n"));
    }
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut names: Vec<String> = (0..zip.len())
        .filter_map(|i| zip.by_index(i).ok().map(|f| f.name().to_string()))
        .collect();
    if extension == "docx" {
        names.retain(|n| n == "word/document.xml");
    } else {
        names.retain(|n| n.starts_with("ppt/slides/slide") && n.ends_with(".xml"));
        names.sort();
    }
    let mut text = String::new();
    for name in names {
        let mut file = zip.by_name(&name).map_err(|e| e.to_string())?;
        let mut xml = String::new();
        file.read_to_string(&mut xml).map_err(|e| e.to_string())?;
        let mut reader = quick_xml::Reader::from_str(&xml);
        loop {
            match reader.read_event() {
                Ok(quick_xml::events::Event::Text(t)) => {
                    text.push_str(
                        &quick_xml::escape::unescape(&t.decode().map_err(|e| e.to_string())?)
                            .map_err(|e| e.to_string())?,
                    );
                    text.push(' ');
                }
                Ok(quick_xml::events::Event::End(e))
                    if e.name().as_ref() == b"w:p" || e.name().as_ref() == b"a:p" =>
                {
                    text.push('\n')
                }
                Ok(quick_xml::events::Event::Eof) => break,
                Err(e) => return Err(e.to_string()),
                _ => {}
            }
        }
        text.push('\n');
    }
    if bool_field(options, "ocr") {
        let prefix = if extension == "docx" {
            "word/media/"
        } else {
            "ppt/media/"
        };
        let names = (0..zip.len())
            .filter_map(|i| zip.by_index(i).ok().map(|f| f.name().to_string()))
            .filter(|n| {
                n.starts_with(prefix)
                    && ["png", "jpg", "jpeg", "webp", "gif"]
                        .iter()
                        .any(|ext| n.to_ascii_lowercase().ends_with(ext))
            })
            .collect::<Vec<_>>();
        for (index, name) in names.iter().enumerate() {
            let mut bytes = Vec::new();
            zip.by_name(name)
                .map_err(|e| e.to_string())?
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            if let Ok(image) = image::load_from_memory(&bytes) {
                let found = ocr_image(root, &image.to_rgba8())?.0;
                if !found.trim().is_empty() {
                    text.push_str(&format!(
                        "\n\n[Embedded image {}: {}]\n{}",
                        index + 1,
                        name,
                        found
                    ));
                }
            }
        }
    }
    Ok(text)
}
fn document_result(
    request: &Value,
    root: &Path,
    progress: &impl Fn(Value),
) -> Result<Value, String> {
    progress(json!({"value":10,"phase":"Extracting documents"}));
    let left_path = input_path(&request["left"])?;
    let right_path = input_path(&request["right"])?;
    let left = document_text(root, &left_path, "left", &request["options"])?;
    let right = document_text(root, &right_path, "right", &request["options"])?;
    progress(json!({"value":75,"phase":"Finding document changes"}));
    let mut result = text_result(left, right, &request["options"]);
    result["leftName"] = request["left"]["name"].clone();
    result["rightName"] = request["right"]["name"].clone();
    let left_structure =
        document_structure(root, &left_path, request["options"]["password"].as_str())?;
    let right_structure =
        document_structure(root, &right_path, request["options"]["password"].as_str())?;
    let mut structural_changes = Vec::new();
    if left_structure["pageCount"] != right_structure["pageCount"] {
        structural_changes.push(json!({"kind":"pages","reference":"Document","left":left_structure["pageCount"],"right":right_structure["pageCount"]}));
    }
    let li = left_structure["images"]
        .as_array()
        .map(Vec::len)
        .unwrap_or(0);
    let ri = right_structure["images"]
        .as_array()
        .map(Vec::len)
        .unwrap_or(0);
    if li != ri {
        structural_changes
            .push(json!({"kind":"images","reference":"Document","left":li,"right":ri}));
    }
    for i in 0..li.min(ri) {
        if left_structure["images"][i]["hash"] != right_structure["images"][i]["hash"] {
            structural_changes.push(json!({"kind":"image","reference":format!("Image {}",i+1),"left":left_structure["images"][i]["name"],"right":right_structure["images"][i]["name"]}));
        }
    }
    if let (Some(lp), Some(rp)) = (
        left_structure["pages"].as_array(),
        right_structure["pages"].as_array(),
    ) {
        let locations = rp
            .iter()
            .enumerate()
            .map(|(index, page)| (field(page, "textHash"), index))
            .collect::<std::collections::HashMap<_, _>>();
        for i in 0..lp.len().min(rp.len()) {
            let a = &lp[i];
            let b = &rp[i];
            if a["width"] != b["width"] || a["height"] != b["height"] {
                structural_changes.push(json!({"kind":"layout","reference":format!("Page {}",i+1),
                    "left":format!("{} × {}",a["width"],a["height"]),"right":format!("{} × {}",b["width"],b["height"])}));
            }
            if let Some(&destination) = locations.get(field(a, "textHash")) {
                if destination != i && a["textHash"] != b["textHash"] {
                    structural_changes.push(json!({"kind":"moved page","reference":format!("Page {} → {}",i+1,destination+1)}));
                }
            }
        }
    }
    let lp = left_structure["paragraphs"].as_array();
    let rp = right_structure["paragraphs"].as_array();
    if let (Some(lp), Some(rp)) = (lp, rp) {
        for i in 0..lp.len().min(rp.len()) {
            if lp[i]["text"] == rp[i]["text"] && lp[i] != rp[i] {
                structural_changes.push(json!({"kind":"formatting","reference":format!("Paragraph {}",i+1),"left":lp[i],"right":rp[i]}));
            }
        }
    }
    if let (Some(lp), Some(rp)) = (lp, rp) {
        let locations = rp
            .iter()
            .enumerate()
            .filter_map(|(index, p)| p["text"].as_str().map(|s| (s, index)))
            .collect::<std::collections::HashMap<_, _>>();
        for (index, p) in lp.iter().enumerate() {
            let content = field(p, "text");
            if !content.is_empty() {
                if let Some(&destination) = locations.get(content) {
                    if destination != index
                        && rp
                            .get(index)
                            .map(|v| field(v, "text") != content)
                            .unwrap_or(true)
                    {
                        structural_changes.push(json!({"kind":"moved","reference":format!("Paragraph {} → {}",index+1,destination+1),"text":content}));
                    }
                }
            }
        }
    }
    result["leftStructure"] = left_structure;
    result["rightStructure"] = right_structure;
    result["structuralChanges"] = json!(structural_changes);
    result["pageImages"] = if field(&request["options"], "view") == "image" {
        let page = number(&request["options"], "page", 1.0).max(1.0) as usize;
        let right_page = if right_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .eq_ignore_ascii_case("pdf")
        {
            let count = result["rightStructure"]["pageCount"].as_u64().unwrap_or(0) as usize;
            let mut order = Vec::new();
            if let Some(selected) = request["options"]["rightPageOrder"].as_array() {
                for number in selected
                    .iter()
                    .filter_map(Value::as_u64)
                    .map(|n| n as usize)
                {
                    if number >= 1 && number <= count && !order.contains(&number) {
                        order.push(number);
                    }
                }
            }
            for number in 1..=count {
                if !order.contains(&number) {
                    order.push(number);
                }
            }
            order.get(page - 1).copied().unwrap_or(1)
        } else {
            page
        };
        let left = render_document_page(
            root,
            &left_path,
            page,
            request["options"]["password"].as_str(),
        )?;
        let right = render_document_page(
            root,
            &right_path,
            right_page,
            request["options"]["password"].as_str(),
        )?;
        json!({"left":data_url(&encode_png(&left)?),"right":data_url(&encode_png(&right)?)})
    } else {
        Value::Null
    };
    Ok(result)
}
fn render_document_page(
    root: &Path,
    path: &Path,
    page: usize,
    password: Option<&str>,
) -> Result<RgbaImage, String> {
    if path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .eq_ignore_ascii_case("pdf")
    {
        return render_pdf_page(root, path, page, password);
    }
    let office = root.join("dependencies/libreoffice/program/soffice.exe");
    if !office.exists() {
        return Err("LibreOffice is required to render Word and presentation pages. Download it in Settings.".into());
    }
    let work = root
        .join("cache/office-render")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let output = work.join(format!(
        "{}.pdf",
        path.file_stem().unwrap_or_default().to_string_lossy()
    ));
    let status = std::process::Command::new(&office)
        .args([
            "--headless",
            "--convert-to",
            "pdf",
            "--outdir",
            &work.to_string_lossy(),
            &path.to_string_lossy(),
        ])
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("Office conversion failed.".into());
    }
    let rendered = render_pdf_page(root, &output, page, password);
    let _ = fs::remove_dir_all(&work);
    rendered
}

fn document_structure(root: &Path, path: &Path, password: Option<&str>) -> Result<Value, String> {
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if extension == "pdf" {
        let engine = pdfium(root)?;
        let doc = engine
            .load_pdf_from_file(path, password)
            .map_err(|e| e.to_string())?;
        let mut details = Vec::new();
        for (index, page) in doc.pages().iter().enumerate() {
            let text = page.text().map_err(|e| e.to_string())?.all();
            details.push(json!({"number":index+1,"width":page.width().value.round() as i64,"height":page.height().value.round() as i64,
                "textHash":format!("{:x}",Sha256::digest(text.trim().as_bytes()))}));
        }
        return Ok(
            json!({"kind":"pdf","paragraphs":[],"images":[],"pageCount":details.len(),"pages":details}),
        );
    }
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut names = Vec::new();
    for i in 0..archive.len() {
        names.push(
            archive
                .by_index(i)
                .map_err(|e| e.to_string())?
                .name()
                .to_string(),
        );
    }
    let prefix = if extension == "docx" {
        "word/media/"
    } else {
        "ppt/media/"
    };
    let mut images = Vec::new();
    for name in names
        .iter()
        .filter(|n| n.starts_with(prefix) && !n[prefix.len()..].contains('/'))
    {
        let mut bytes = Vec::new();
        archive
            .by_name(name)
            .map_err(|e| e.to_string())?
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        images.push(json!({"name":Path::new(name).file_name().unwrap_or_default().to_string_lossy(),"hash":format!("{:x}",Sha256::digest(&bytes))}));
    }
    if extension == "pptx" {
        let count = names
            .iter()
            .filter(|n| n.starts_with("ppt/slides/slide") && n.ends_with(".xml"))
            .count();
        return Ok(json!({"kind":"pptx","paragraphs":[],"images":images,"pageCount":count}));
    }
    let mut xml = String::new();
    archive
        .by_name("word/document.xml")
        .map_err(|e| e.to_string())?
        .read_to_string(&mut xml)
        .map_err(|e| e.to_string())?;
    let mut reader = quick_xml::Reader::from_str(&xml);
    let mut paragraphs = Vec::new();
    let mut runs = Vec::new();
    let mut run_text = String::new();
    let (mut in_run, mut bold, mut italic) = (false, false, false);
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Start(e)) => match e.name().as_ref() {
                b"w:r" => {
                    in_run = true;
                    run_text.clear();
                    bold = false;
                    italic = false;
                }
                b"w:b" => bold = true,
                b"w:i" => italic = true,
                _ => {}
            },
            Ok(quick_xml::events::Event::Empty(e)) => match e.name().as_ref() {
                b"w:b" => bold = true,
                b"w:i" => italic = true,
                _ => {}
            },
            Ok(quick_xml::events::Event::Text(t)) if in_run => run_text.push_str(
                &quick_xml::escape::unescape(&t.decode().map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?,
            ),
            Ok(quick_xml::events::Event::End(e)) => match e.name().as_ref() {
                b"w:r" => {
                    runs.push(json!({"text":run_text,"bold":bold,"italic":italic,"color":null,"font":null,"size":null}));
                    in_run = false;
                }
                b"w:p" => {
                    let text = runs
                        .iter()
                        .map(|v: &Value| field(v, "text"))
                        .collect::<String>();
                    paragraphs.push(json!({"text":text,"style":null,"runs":runs}));
                    runs = Vec::new();
                }
                _ => {}
            },
            Ok(quick_xml::events::Event::Eof) => break,
            Err(e) => return Err(e.to_string()),
            _ => {}
        }
    }
    Ok(json!({"kind":"docx","paragraphs":paragraphs,"images":images,"pageCount":null}))
}

pub fn export(root: &Path, payload: &Value) -> Result<Value, String> {
    let kind = field(payload, "kind");
    let request = &payload["request"];
    let destination = field(payload, "destination");
    match kind {
        "text" => {
            let text = match field(request, "kind") {
                "original" => field(request, "leftText").to_string(),
                "changed" => field(request, "rightText").to_string(),
                _ => format!(
                    "--- {}\n+++ {}\n{}",
                    field(request, "leftName"),
                    field(request, "rightName"),
                    TextDiff::from_lines(field(request, "leftText"), field(request, "rightText"))
                        .unified_diff()
                        .to_string()
                ),
            };
            let text = if bool_field(request, "fenced") {
                format!("```diff\n{}\n```", text)
            } else {
                text
            };
            if bool_field(request, "toClipboard") {
                return Ok(json!(text));
            }
            fs::write(destination, text).map_err(|e| e.to_string())?;
        }
        "image" => {
            let bytes = image_view_png(
                root,
                &request["result"],
                &request["options"],
                bool_field(request, "flickerRight"),
            )?;
            if destination.is_empty() {
                return Ok(json!(
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                ));
            }
            fs::write(destination, bytes).map_err(|e| e.to_string())?;
        }
        "xlsx" => {
            let mut workbook = rust_xlsxwriter::Workbook::new();
            let sheet = workbook.add_worksheet();
            if let Some(rows) = request["rows"].as_array() {
                for (r, row) in rows.iter().enumerate() {
                    if let Some(object) = row.as_object() {
                        for (c, (_, value)) in object.iter().enumerate() {
                            sheet
                                .write_string(
                                    r as u32,
                                    c as u16,
                                    value.as_str().unwrap_or(&value.to_string()),
                                )
                                .map_err(|e| e.to_string())?;
                        }
                    }
                }
            }
            workbook.save(destination).map_err(|e| e.to_string())?;
        }
        "docx" => {
            let mut doc = docx_rs::Docx::new();
            let tracked = bool_field(request, "tracked");
            let date = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
            if let Some(chunks) = request["chunks"].as_array() {
                for chunk in chunks {
                    let kind = field(chunk, "type");
                    for line in field(chunk, "text").trim_end_matches('\n').split('\n') {
                        let content = if line.is_empty() { " " } else { line };
                        let paragraph = if tracked && kind == "added" {
                            docx_rs::Paragraph::new().add_insert(
                                docx_rs::Insert::new(docx_rs::Run::new().add_text(content))
                                    .author("Norways Diff Checker")
                                    .date(&date),
                            )
                        } else if tracked && kind == "removed" {
                            docx_rs::Paragraph::new().add_delete(
                                docx_rs::Delete::new()
                                    .add_run(docx_rs::Run::new().add_delete_text(content))
                                    .author("Norways Diff Checker")
                                    .date(&date),
                            )
                        } else {
                            let run = match kind {
                                "added" => docx_rs::Run::new()
                                    .add_text(content)
                                    .color("008540")
                                    .underline("single"),
                                "removed" => docx_rs::Run::new()
                                    .add_text(content)
                                    .color("B00020")
                                    .strike(),
                                _ => docx_rs::Run::new().add_text(content).color("222222"),
                            };
                            docx_rs::Paragraph::new().add_run(run)
                        };
                        doc = doc.add_paragraph(paragraph);
                    }
                }
            }
            let file = File::create(destination).map_err(|e| e.to_string())?;
            doc.build().pack(file).map_err(|e| e.to_string())?;
        }
        "pdf" => pdf_export(root, request, destination)?,
        _ => return Err("Unknown export format.".into()),
    }
    Ok(json!(destination))
}

fn decode_image(root: &Path, value: &str) -> Result<RgbaImage, String> {
    let bytes = if let Some(raw) = value.strip_prefix("data:image/png;base64,") {
        base64::engine::general_purpose::STANDARD
            .decode(raw)
            .map_err(|e| e.to_string())?
    } else {
        let path = value
            .strip_prefix("http://ndc-asset.localhost/")
            .ok_or("Invalid image asset")?;
        let mut parts = path.split('/');
        let id = parts.next().ok_or("Missing asset ID")?;
        let name = parts.next().ok_or("Missing asset name")?;
        if uuid::Uuid::parse_str(id).is_err()
            || !name.ends_with(".png")
            || !name
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'.')
            || parts.next().is_some()
        {
            return Err("Invalid image asset".into());
        }
        fs::read(root.join("cache/comparison-assets").join(id).join(name))
            .map_err(|e| e.to_string())?
    };
    Ok(image::load_from_memory(&bytes)
        .map_err(|e| e.to_string())?
        .to_rgba8())
}
fn image_view_png(
    root: &Path,
    result: &Value,
    options: &Value,
    flicker_right: bool,
) -> Result<Vec<u8>, String> {
    let view = field(options, "view");
    if view == "subtract" {
        return encode_png(&decode_image(root, field(result, "subtractData"))?);
    }
    if view == "flicker" {
        return encode_png(&decode_image(
            root,
            field(
                result,
                if flicker_right {
                    "rightData"
                } else {
                    "leftData"
                },
            ),
        )?);
    }
    if view == "split" {
        let left = decode_image(
            root,
            result["splitLeftData"]
                .as_str()
                .unwrap_or(field(result, "leftData")),
        )?;
        let right = decode_image(
            root,
            result["splitRightData"]
                .as_str()
                .unwrap_or(field(result, "rightData")),
        )?;
        let horizontal = field(options, "splitOrientation") == "horizontal";
        let width = if horizontal {
            left.width().max(right.width())
        } else {
            left.width() + right.width()
        };
        let height = if horizontal {
            left.height() + right.height()
        } else {
            left.height().max(right.height())
        };
        let mut canvas = ImageBuffer::from_pixel(width, height, Rgba([0, 0, 0, 0]));
        image::imageops::overlay(
            &mut canvas,
            &left,
            if horizontal {
                ((width - left.width()) / 2).into()
            } else {
                0
            },
            if horizontal {
                0
            } else {
                ((height - left.height()) / 2).into()
            },
        );
        image::imageops::overlay(
            &mut canvas,
            &right,
            if horizontal {
                ((width - right.width()) / 2).into()
            } else {
                left.width().into()
            },
            if horizontal {
                left.height().into()
            } else {
                ((height - right.height()) / 2).into()
            },
        );
        return encode_png(&canvas);
    }
    let mut left = decode_image(root, field(result, "leftData"))?;
    let right = decode_image(
        root,
        field(
            result,
            if view == "highlight" {
                "diffData"
            } else {
                "rightData"
            },
        ),
    )?;
    if left.dimensions() != right.dimensions() {
        return Err("Image layers have different sizes.".into());
    }
    let opacity = if view == "fade" {
        (number(options, "opacity", 50.0) / 100.0).clamp(0.0, 1.0)
    } else {
        1.0
    };
    let boundary = (left.width() as f64 * number(options, "opacity", 50.0) / 101.0).round() as u32;
    for y in 0..left.height() {
        for x in 0..left.width() {
            if view == "slider" && x >= boundary {
                continue;
            }
            let a = left.get_pixel(x, y).0;
            let b = right.get_pixel(x, y).0;
            if view == "slider" && bool_field(options, "sliderNoOverlap") {
                left.put_pixel(x, y, Rgba(b));
                continue;
            }
            let oa = b[3] as f64 / 255.0 * opacity;
            let ba = a[3] as f64 / 255.0;
            let alpha = oa + ba * (1.0 - oa);
            let mut out = [0u8; 4];
            if alpha > 0.0 {
                for i in 0..3 {
                    out[i] =
                        ((b[i] as f64 * oa + a[i] as f64 * ba * (1.0 - oa)) / alpha).round() as u8;
                }
                out[3] = (alpha * 255.0).round() as u8;
            }
            left.put_pixel(x, y, Rgba(out));
        }
    }
    encode_png(&left)
}

fn pdf_export(root: &Path, request: &Value, destination: &str) -> Result<(), String> {
    use lopdf::{
        content::{Content, Operation},
        dictionary, Document, Object, Stream,
    };
    let mut lines = Vec::new();
    lines.push(field(request, "title").to_string());
    lines.push(String::new());
    match field(request, "layout") {
        "side" => {
            let left: Vec<&str> = field(request, "leftText").lines().collect();
            let right: Vec<&str> = field(request, "rightText").lines().collect();
            lines.push("ORIGINAL                                      CHANGED".into());
            for i in 0..left.len().max(right.len()) {
                lines.push(format!(
                    "{:<55} {}",
                    left.get(i)
                        .unwrap_or(&"")
                        .chars()
                        .take(52)
                        .collect::<String>(),
                    right
                        .get(i)
                        .unwrap_or(&"")
                        .chars()
                        .take(52)
                        .collect::<String>()
                ));
            }
        }
        "redline" => {
            if let Some(chunks) = request["chunks"].as_array() {
                for chunk in chunks {
                    let prefix = match field(chunk, "type") {
                        "added" => "+ ",
                        "removed" => "- ",
                        _ => "  ",
                    };
                    for line in field(chunk, "text").lines() {
                        lines.push(format!("{}{}", prefix, line));
                    }
                }
            }
        }
        _ => {
            if let Some(values) = request["lines"].as_array() {
                for value in values {
                    lines.push(value.as_str().unwrap_or("").to_string());
                }
            }
        }
    }
    let mut doc = Document::with_version("1.5");
    let font =
        doc.add_object(dictionary! {"Type"=>"Font","Subtype"=>"Type1","BaseFont"=>"Courier"});
    let pages_id = doc.new_object_id();
    let mut page_ids = Vec::new();
    if request["imageView"].is_object() {
        let view = &request["imageView"];
        let png = image_view_png(
            root,
            &view["result"],
            &view["options"],
            bool_field(view, "flickerRight"),
        )?;
        let image = image::load_from_memory(&png)
            .map_err(|e| e.to_string())?
            .to_rgb8();
        let (width, height) = image.dimensions();
        let xobject = doc.add_object(Stream::new(
            dictionary! {
                "Type"=>"XObject","Subtype"=>"Image","Width"=>width as i64,"Height"=>height as i64,
                "ColorSpace"=>"DeviceRGB","BitsPerComponent"=>8
            },
            image.into_raw(),
        ));
        let scale = (515.0 / width as f64).min(730.0 / height as f64);
        let draw_width = width as f64 * scale;
        let draw_height = height as f64 * scale;
        let x = (595.0 - draw_width) / 2.0;
        let y = 802.0 - draw_height;
        let operations = vec![
            Operation::new("q", vec![]),
            Operation::new(
                "cm",
                vec![
                    draw_width.into(),
                    0.into(),
                    0.into(),
                    draw_height.into(),
                    x.into(),
                    y.into(),
                ],
            ),
            Operation::new("Do", vec![Object::Name(b"Im1".to_vec())]),
            Operation::new("Q", vec![]),
        ];
        let content = doc.add_object(Stream::new(
            dictionary! {},
            Content { operations }.encode().map_err(|e| e.to_string())?,
        ));
        let page=doc.add_object(dictionary!{"Type"=>"Page","Parent"=>pages_id,"MediaBox"=>vec![0.into(),0.into(),595.into(),842.into()],
            "Contents"=>content,"Resources"=>dictionary!{"XObject"=>dictionary!{"Im1"=>xobject}}});
        page_ids.push(page);
    }
    for page_lines in lines.chunks(55) {
        let mut operations = vec![
            Operation::new("BT", vec![]),
            Operation::new("Tf", vec![Object::Name(b"F1".to_vec()), Object::Integer(9)]),
            Operation::new("Td", vec![Object::Integer(40), Object::Integer(800)]),
        ];
        for line in page_lines {
            let ascii = line
                .chars()
                .map(|c| if c.is_ascii() { c } else { '?' })
                .collect::<String>();
            operations.push(Operation::new("Tj", vec![Object::string_literal(ascii)]));
            operations.push(Operation::new(
                "Td",
                vec![Object::Integer(0), Object::Integer(-13)],
            ));
        }
        operations.push(Operation::new("ET", vec![]));
        let content = doc.add_object(Stream::new(
            dictionary! {},
            Content { operations }.encode().map_err(|e| e.to_string())?,
        ));
        let page=doc.add_object(dictionary!{"Type"=>"Page","Parent"=>pages_id,"MediaBox"=>vec![0.into(),0.into(),595.into(),842.into()],
            "Contents"=>content,"Resources"=>dictionary!{"Font"=>dictionary!{"F1"=>font}}});
        page_ids.push(page);
    }
    doc.objects.insert(pages_id,lopdf::Object::Dictionary(dictionary!{"Type"=>"Pages","Kids"=>page_ids.iter().map(|id|Object::Reference(*id)).collect::<Vec<_>>(),"Count"=>page_ids.len() as i64}));
    let catalog = doc.add_object(dictionary! {"Type"=>"Catalog","Pages"=>pages_id});
    doc.trailer.set("Root", catalog);
    doc.compress();
    doc.save(destination).map_err(|e| e.to_string())?;
    Ok(())
}
