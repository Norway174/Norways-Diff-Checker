#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod compare;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::process::Command;
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Emitter, Manager, WebviewWindow};

struct State {
    root: PathBuf,
    settings_lock: Mutex<()>,
    jobs: Mutex<HashMap<String, Arc<AtomicBool>>>,
    drags: Mutex<HashMap<String, (String, Value, bool)>>,
    bootstrap: Mutex<HashMap<String, Value>>,
    primary: Mutex<String>,
    active_tabs: Mutex<HashMap<String, Value>>,
}

fn data_root() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(folder) = exe.parent() {
            if folder.join("portable.flag").exists() || folder.join("preferences.json").exists() {
                return folder.to_path_buf();
            }
        }
    }
    #[cfg(windows)]
    if let Ok(key) = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey(r"Software\NorwaysDiffChecker") {
        if let Ok(path) = key.get_value::<String, _>("DataPath") {
            if !path.trim().is_empty() { return PathBuf::from(path); }
        }
    }
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir());
    base.join("NorwaysDiffChecker")
}

fn build_commit() -> &'static str { option_env!("NDC_BUILD_COMMIT").unwrap_or("") }

fn update_manifest() -> Result<Value, String> {
    let mut response = ureq::get("https://raw.githubusercontent.com/Norway174/Norways-Diff-Checker/downloads/latest.json")
        .header("Cache-Control", "no-cache")
        .call().map_err(|e| e.to_string())?;
    let mut body = String::new();
    response.body_mut().as_reader().take(16_384).read_to_string(&mut body).map_err(|e| e.to_string())?;
    let manifest: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let commit = string(&manifest, "commit");
    let hash = string(&manifest, "installerSha256");
    let url = string(&manifest, "installerUrl");
    if commit.len() != 40 || !commit.bytes().all(|b| b.is_ascii_hexdigit())
        || hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit())
        || url != format!("https://github.com/Norway174/Norways-Diff-Checker/releases/download/commit-{commit}/Installer-{commit}.exe") {
        return Err("Invalid update manifest.".into());
    }
    Ok(manifest)
}
fn check_update() -> Result<Value, String> {
    let current = build_commit();
    if current.len() != 40 || std::env::current_exe().ok().and_then(|p| p.parent().map(|x| x.join("portable.flag").exists())).unwrap_or(false) {
        return Ok(json!({"available":false,"currentCommit":current}));
    }
    let manifest = update_manifest()?;
    let published = string(&manifest, "commit");
    Ok(json!({"available":!current.eq_ignore_ascii_case(published),"currentCommit":current,"publishedCommit":published}))
}
fn start_update(root: &Path, app: tauri::AppHandle) -> Result<(), String> {
    let manifest = update_manifest()?;
    let commit = string(&manifest, "commit");
    if build_commit().eq_ignore_ascii_case(commit) { return Ok(()); }
    let cache = root.join("cache/updates");
    fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let installer = cache.join(format!("Installer-{commit}.exe"));
    let expected = string(&manifest, "installerSha256");
    if !installer.exists() || file_hash(&installer)? != expected {
        let partial = cache.join(format!("Installer-{commit}.partial"));
        let _ = fs::remove_file(&partial);
        let result = (|| -> Result<(), String> {
            let mut response = ureq::get(string(&manifest, "installerUrl")).call().map_err(|e| e.to_string())?;
            let mut reader = response.body_mut().as_reader();
            let mut file = File::create(&partial).map_err(|e| e.to_string())?;
            let mut hasher = Sha256::new();
            let mut buffer = [0u8; 65536];
            let mut received = 0u64;
            loop {
                let n = reader.read(&mut buffer).map_err(|e| e.to_string())?;
                if n == 0 { break; }
                received += n as u64;
                if received > 100_000_000 { return Err("Installer download is too large.".into()); }
                file.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
                hasher.update(&buffer[..n]);
            }
            if format!("{:x}", hasher.finalize()) != expected { return Err("Installer download failed SHA-256 verification.".into()); }
            drop(file);
            fs::rename(&partial, &installer).map_err(|e| e.to_string())?;
            Ok(())
        })();
        if result.is_err() { let _ = fs::remove_file(&partial); }
        result?;
    }
    Command::new(installer).args(["/UPDATE", "/S"]).creation_flags_hidden().spawn().map_err(|e| e.to_string())?;
    std::thread::spawn(move || { std::thread::sleep(std::time::Duration::from_millis(500)); app.exit(0); });
    Ok(())
}

fn settings_path(state: &State) -> PathBuf {
    state.root.join("preferences.json")
}
fn clean_settings(raw: Value) -> Value {
    let mut value = json!({
        "restoreTabs": raw.get("restoreTabs").and_then(Value::as_bool).unwrap_or(true),
        "recentCompareLimit": raw.get("recentCompareLimit").and_then(Value::as_u64).unwrap_or(10).min(50),
        "recentCompares": raw.get("recentCompares").and_then(Value::as_array).cloned().unwrap_or_default(),
        "tabs": raw.get("tabs").and_then(Value::as_array).cloned().unwrap_or_default(),
    });
    for key in ["lastImageView", "activeTabId"] {
        if let Some(x) = raw.get(key) {
            value[key] = x.clone();
        }
    }
    if let Some(tabs) = value["tabs"].as_array_mut() {
        tabs.truncate(100);
        for tab in tabs {
            tab["result"] = Value::Null;
            tab["busy"] = json!(false);
            tab["progress"] = json!(0);
            tab["phase"] = json!("");
            if let Some(options) = tab.get_mut("options").and_then(Value::as_object_mut) {
                options.remove("password");
            }
        }
    }
    value
}
fn get_settings(state: &State) -> Value {
    let path = settings_path(state);
    for candidate in [path.clone(), path.with_extension("json.bak")] {
        if let Ok(bytes) = fs::read(candidate) {
            if let Ok(raw) = serde_json::from_slice(&bytes) {
                return clean_settings(raw);
            }
        }
    }
    clean_settings(Value::Null)
}
fn save_settings(state: &State, value: Value) -> Result<Value, String> {
    let clean = clean_settings(value);
    let path = settings_path(state);
    fs::create_dir_all(&state.root).map_err(|e| e.to_string())?;
    if path.exists() {
        let _ = fs::copy(&path, path.with_extension("json.bak"));
    }
    let temp = path.with_extension("json.tmp");
    fs::write(
        &temp,
        serde_json::to_vec_pretty(&clean).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(temp, path).map_err(|e| e.to_string())?;
    Ok(clean)
}
fn string<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
fn path_input(value: &Value) -> Result<PathBuf, String> {
    let path = string(value, "path");
    if path.is_empty() || path.len() > 32767 {
        return Err("Invalid input path.".into());
    }
    Ok(PathBuf::from(path))
}
fn describe_one(path: &Path) -> Result<Value, String> {
    let absolute = path.canonicalize().map_err(|e| e.to_string())?;
    let stat = fs::metadata(&absolute).map_err(|e| e.to_string())?;
    let extension = absolute
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mut types: Vec<&str> = if stat.is_dir() {
        vec!["folders"]
    } else {
        Vec::new()
    };
    if stat.is_file() {
        if ["jpg", "jpeg", "png", "webp", "gif", "heic"].contains(&extension.as_str()) {
            types.push("images");
        }
        if ["pdf", "docx", "pptx"].contains(&extension.as_str()) {
            types.push("documents");
        }
        if extension == "pdf" {
            types.push("images");
        }
        if ["xlsx", "xls", "csv", "tsv", "ods", "txt"].contains(&extension.as_str()) {
            types.push("excel");
        }
        types.push("text");
    }
    Ok(
        json!({"id": uuid::Uuid::new_v4().to_string(), "name": absolute.file_name().unwrap_or_default().to_string_lossy(),
        "path": absolute.to_string_lossy(), "size": stat.len(), "types": types}),
    )
}
fn show_status(root: &Path) -> Value {
    let installed = root
        .join("dependencies/libreoffice/program/soffice.exe")
        .exists();
    json!({"installed": installed, "version": "26.2.6", "downloadBytes": 373252096u64,
        "installedBytes": if installed {1596766810u64} else {0}, "installedBytesEstimate": 1596766810u64})
}
const PDFIUM_HASH: &str = "79d4676b656cfb1abcea88f9ade3b4b0826c5200382db5f4ec72a636c598c118";
const PDFIUM_ARCHIVE_HASH: &str = "73cc0de638ac2095e7445bf56a38200a5b7c7ca0e9f4ba144598f2457377ac08";
const OCR_DETECTION_HASH: &str = "f15cfb56bd02c4bf478a20343986504a1f01e1665c2b3a0ad66340f054b1b5ca";
const OCR_RECOGNITION_HASH: &str = "e484866d4cce403175bd8d00b128feb08ab42e208de30e42cd9889d8f1735a6e";

fn file_hash(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        hasher.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}
fn optional_status(root: &Path, kind: &str) -> Result<Value, String> {
    let (installed, version, download, installed_size) = match kind {
        "pdfium" => (root.join("dependencies/pdfium/pdfium.dll").exists(), "151.0.7881.0", 3733154u64, 7211520u64),
        "ocr" => (root.join("dependencies/ocr/text-detection.rten").exists() && root.join("dependencies/ocr/text-recognition.rten").exists(), "ocrs", 12226852u64, 12226852u64),
        _ => return Err("Unknown optional dependency.".into()),
    };
    Ok(json!({"installed":installed,"version":version,"downloadBytes":download,"installedBytes":if installed {installed_size} else {0},"installedBytesEstimate":installed_size}))
}
fn emit_optional_progress(window: &WebviewWindow, kind: &str, phase: &str, received: u64, total: u64) {
    let _ = window.emit("optional-dependency-progress", json!({"kind":kind,"phase":phase,"receivedBytes":received,"totalBytes":total,"percent":received.saturating_mul(100)/total.max(1)}));
}
fn download_optional(root: &Path, window: &WebviewWindow, kind: &str, name: &str, url: &str, hash: &str, size: u64, base: u64, total: u64) -> Result<PathBuf, String> {
    let cache = root.join("dependencies/downloads");
    fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let target = cache.join(name);
    if target.exists() && fs::metadata(&target).map_err(|e| e.to_string())?.len() == size && file_hash(&target)? == hash {
        emit_optional_progress(window, kind, "Downloading", base + size, total);
        return Ok(target);
    }
    let _ = fs::remove_file(&target);
    let partial = cache.join(format!("{name}.partial"));
    let _ = fs::remove_file(&partial);
    let result = (|| -> Result<(), String> {
        let mut response = ureq::get(url).call().map_err(|e| e.to_string())?;
        let mut stream = response.body_mut().as_reader();
        let mut file = File::create(&partial).map_err(|e| e.to_string())?;
        let mut bytes = [0u8; 65536];
        let mut received = 0u64;
        let mut hasher = Sha256::new();
        loop {
            let n = stream.read(&mut bytes).map_err(|e| e.to_string())?;
            if n == 0 { break; }
            received += n as u64;
            if received > size { return Err(format!("{name} download exceeded expected size.")); }
            file.write_all(&bytes[..n]).map_err(|e| e.to_string())?;
            hasher.update(&bytes[..n]);
            emit_optional_progress(window, kind, "Downloading", base + received, total);
        }
        file.flush().map_err(|e| e.to_string())?;
        if received != size || format!("{:x}", hasher.finalize()) != hash {
            return Err(format!("{name} download failed SHA-256 verification."));
        }
        drop(file);
        fs::rename(&partial, &target).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(&partial); }
    result?;
    Ok(target)
}
fn install_optional(root: &Path, window: &WebviewWindow, kind: &str) -> Result<Value, String> {
    let install = root.join("dependencies").join(kind);
    let staging = root.join("dependencies").join(format!("{kind}.installing"));
    let _ = optional_status(root, kind)?;
    if staging.exists() { fs::remove_dir_all(&staging).map_err(|e| e.to_string())?; }
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let result = (|| -> Result<(), String> {
        match kind {
            "pdfium" => {
                let archive = download_optional(root, window, kind, "pdfium-win-x64-7881.tgz", "https://github.com/bblanchon/pdfium-binaries/releases/download/chromium%2F7881/pdfium-win-x64.tgz", PDFIUM_ARCHIVE_HASH, 3733154, 0, 3733154)?;
                emit_optional_progress(window, kind, "Installing", 0, 7211520);
                let decoder = flate2::read::GzDecoder::new(File::open(archive).map_err(|e| e.to_string())?);
                let mut archive = tar::Archive::new(decoder);
                let mut found = false;
                for entry in archive.entries().map_err(|e| e.to_string())? {
                    let mut entry = entry.map_err(|e| e.to_string())?;
                    if entry.path().map_err(|e| e.to_string())?.as_ref() == Path::new("bin/pdfium.dll") {
                        let mut file = File::create(staging.join("pdfium.dll")).map_err(|e| e.to_string())?;
                        std::io::copy(&mut entry, &mut file).map_err(|e| e.to_string())?;
                        found = true;
                        break;
                    }
                }
                if !found || file_hash(&staging.join("pdfium.dll"))? != PDFIUM_HASH { return Err("PDFium library failed SHA-256 verification.".into()); }
                emit_optional_progress(window, kind, "Installing", 7211520, 7211520);
            }
            "ocr" => {
                let files = [
                    ("text-detection.rten", OCR_DETECTION_HASH, 2510284u64, 0u64),
                    ("text-recognition.rten", OCR_RECOGNITION_HASH, 9716568u64, 2510284u64),
                ];
                for (name, hash, size, base) in files {
                    let url = format!("https://ocrs-models.s3-accelerate.amazonaws.com/{name}");
                    let file = download_optional(root, window, kind, name, &url, hash, size, base, 12226852)?;
                    fs::copy(file, staging.join(name)).map_err(|e| e.to_string())?;
                }
                emit_optional_progress(window, kind, "Installing", 12226852, 12226852);
            }
            _ => return Err("Unknown optional dependency.".into()),
        }
        if install.exists() { fs::remove_dir_all(&install).map_err(|e| e.to_string())?; }
        fs::rename(&staging, &install).map_err(|e| e.to_string())?;
        if kind == "ocr" { compare::clear_ocr_cache(); }
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_dir_all(&staging); }
    result?;
    optional_status(root, kind)
}
fn install_libreoffice(root: &Path, window: &WebviewWindow) -> Result<Value, String> {
    const VERSION: &str = "26.2.6";
    const HASH: &str = "f9877032fd908beb9c0ddf06df4af5c2e85f419c42e14876c4cce5aae5fb2660";
    let cache = root.join("dependencies/downloads");
    let install = root.join("dependencies/libreoffice");
    fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let msi = cache.join(format!("LibreOffice_{VERSION}_Win_x86-64.msi"));
    let download = || -> Result<(), String> {
        let url=format!("https://download.documentfoundation.org/libreoffice/stable/{VERSION}/win/x86_64/LibreOffice_{VERSION}_Win_x86-64.msi");
        let mut response = ureq::get(&url).call().map_err(|e| e.to_string())?;
        let total = response
            .headers()
            .get("content-length")
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(373252096);
        let partial = msi.with_extension("msi.partial");
        let mut file = File::create(&partial).map_err(|e| e.to_string())?;
        let mut stream = response.body_mut().as_reader();
        let mut bytes = [0u8; 65536];
        let mut received = 0u64;
        let mut last = 0u64;
        loop {
            let n = stream.read(&mut bytes).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            file.write_all(&bytes[..n]).map_err(|e| e.to_string())?;
            received += n as u64;
            if received - last > 2_000_000 {
                last = received;
                let _=window.emit("libreoffice-progress",json!({"phase":"Downloading","receivedBytes":received,"totalBytes":total,"percent":received*100/total.max(1)}));
            }
        }
        fs::rename(partial, &msi).map_err(|e| e.to_string())?;
        Ok(())
    };
    if !msi.exists() {
        download()?;
    }
    let mut hasher = Sha256::new();
    let mut file = File::open(&msi).map_err(|e| e.to_string())?;
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    if format!("{:x}", hasher.finalize()) != HASH {
        let _ = fs::remove_file(&msi);
        return Err("LibreOffice download failed SHA-256 verification.".into());
    }
    let staging = root.join("dependencies/libreoffice.installing");
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let _ = window.emit(
        "libreoffice-progress",
        json!({"phase":"Installing","receivedBytes":0,"totalBytes":1596766810u64,"percent":0}),
    );
    let installer = msi.to_string_lossy().to_string();
    let target = format!("TARGETDIR={}", staging.display());
    let result = Command::new("msiexec.exe")
        .creation_flags_hidden()
        .args(["/a", &installer, &target, "/qn", "/norestart"])
        .status()
        .map_err(|e| e.to_string())?;
    if !result.success() {
        return Err(format!("LibreOffice extraction failed ({result})."));
    }
    if !staging.join("program/soffice.exe").exists() {
        return Err("LibreOffice extraction completed without soffice.exe.".into());
    }
    if install.exists() {
        fs::remove_dir_all(&install).map_err(|e| e.to_string())?;
    }
    fs::rename(staging, &install).map_err(|e| e.to_string())?;
    let _=window.emit("libreoffice-progress",json!({"phase":"Installing","receivedBytes":1596766810u64,"totalBytes":1596766810u64,"percent":100}));
    Ok(
        json!({"installed":true,"version":VERSION,"downloadBytes":373252096u64,"installedBytes":1596766810u64,"installedBytesEstimate":1596766810u64}),
    )
}
fn registry(args: &[&str]) -> bool {
    Command::new("reg.exe")
        .args(args)
        .creation_flags_hidden()
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}
trait HiddenCommand {
    fn creation_flags_hidden(&mut self) -> &mut Self;
}
impl HiddenCommand for Command {
    fn creation_flags_hidden(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(0x08000000);
        }
        self
    }
}
fn shell_keys() -> [&'static str; 2] {
    [
        r"HKCU\Software\Classes\*\shell\NorwaysDiffChecker",
        r"HKCU\Software\Classes\Directory\shell\NorwaysDiffChecker",
    ]
}
fn shell_installed() -> bool {
    shell_keys().iter().all(|key| {
        registry(&["query", &format!(r"{}\command", key), "/ve"])
            && registry(&["query", key, "/v", "MultiSelectModel"])
    })
}
fn set_shell(enabled: bool) -> Result<bool, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let command = format!("\"{}\" \"%1\"", exe.display());
    for (key, label) in shell_keys()
        .iter()
        .zip(["Compare this file", "Compare this folder"])
    {
        if enabled {
            let entries: Vec<Vec<String>> = vec![
                vec![
                    "add".into(),
                    key.to_string(),
                    "/ve".into(),
                    "/d".into(),
                    label.into(),
                    "/f".into(),
                ],
                vec![
                    "add".into(),
                    key.to_string(),
                    "/v".into(),
                    "Icon".into(),
                    "/d".into(),
                    exe.to_string_lossy().into_owned(),
                    "/f".into(),
                ],
                vec![
                    "add".into(),
                    key.to_string(),
                    "/v".into(),
                    "MultiSelectModel".into(),
                    "/d".into(),
                    "Player".into(),
                    "/f".into(),
                ],
                vec![
                    "add".into(),
                    format!(r"{}\command", key),
                    "/ve".into(),
                    "/d".into(),
                    command.clone(),
                    "/f".into(),
                ],
            ];
            for entry in entries {
                let args: Vec<&str> = entry.iter().map(String::as_str).collect();
                if !registry(&args) {
                    return Err("Unable to update Explorer context menu.".into());
                }
            }
        } else if registry(&["query", key]) && !registry(&["delete", key, "/f"]) {
            return Err("Unable to remove Explorer context menu.".into());
        }
    }
    Ok(shell_installed())
}

#[tauri::command]
fn native_call(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, State>,
    action: String,
    payload: Value,
) -> Result<Value, String> {
    match action.as_str() {
        "bootstrap" => Ok(state.bootstrap.lock().unwrap().remove(window.label()).unwrap_or_else(|| json!({"initialTab": null, "primary": window.label() == *state.primary.lock().unwrap()}))),
        "startup_requests" => {
            let paths: Vec<String> = std::env::args().skip(1).filter(|s| Path::new(s).exists()).collect();
            if paths.is_empty() { Ok(json!([])) } else { Ok(json!([{"paths": paths, "reuseExisting": false}])) }
        },
        "describe" => {
            let paths = payload.as_array().ok_or("Invalid paths")?;
            if paths.len() > 100 { return Err("Too many input paths.".into()); }
            paths.iter().map(|p| describe_one(Path::new(p.as_str().ok_or("Invalid path")?))).collect::<Result<Vec<_>, _>>().map(|v| json!(v))
        },
        "read_text" => {
            if let Some(text) = payload.get("text").and_then(Value::as_str) { return Ok(json!(text)); }
            let path = path_input(&payload)?;
            if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 512 * 1024 * 1024 { return Err("Text input exceeds 512 MB.".into()); }
            Ok(json!(String::from_utf8_lossy(&fs::read(path).map_err(|e| e.to_string())?).to_string()))
        },
        "preview" => compare::preview(&payload,&state.root),
        "settings_get" => Ok(get_settings(&state)),
        "settings_set" => {
            let _guard = state.settings_lock.lock().unwrap();
            let mut current = get_settings(&state);
            let patch = payload.as_object().ok_or("Invalid settings update")?;
            for key in ["restoreTabs","recentCompareLimit","recentCompares","lastImageView","tabs","activeTabId"] {
                if let Some(value) = patch.get(key) { current[key] = value.clone(); }
            }
            save_settings(&state, current)
        },
        "app_data_path" => Ok(json!(state.root.to_string_lossy())),
        "open_app_data" => {
            Command::new("explorer.exe")
                .arg(&state.root)
                .creation_flags_hidden()
                .spawn()
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        },
        "libreoffice_status" => Ok(show_status(&state.root)),
        "optional_dependency_status" => optional_status(&state.root, payload.as_str().unwrap_or("")),
        "shell_menu_status" => Ok(json!(shell_installed())),
        "shell_menu_set" => set_shell(payload.as_bool().unwrap_or(false)).map(|v|json!(v)),
        "open_maintenance" => {
            let installer = std::env::current_exe().map_err(|e| e.to_string())?
                .parent().ok_or("Unable to locate the app folder.")?.join("Installer.exe");
            if installer.is_file() {
                Command::new(installer).creation_flags_hidden().spawn().map_err(|e| e.to_string())?;
            } else {
                Command::new("explorer.exe").arg("ms-settings:appsfeatures").creation_flags_hidden().spawn().map_err(|e| e.to_string())?;
            }
            Ok(json!({"status":"opened"}))
        },
        "active_tab" => { state.active_tabs.lock().unwrap().insert(window.label().into(),payload); Ok(Value::Null) },
        "begin_drag" => {
            let token = string(&payload, "token").to_string();
            let tab = payload.get("tab").cloned().ok_or("Missing tab")?;
            let close = payload.get("tabCount").and_then(Value::as_u64) == Some(1);
            state.drags.lock().unwrap().insert(token.clone(), (window.label().into(), tab.clone(), close));
            let _ = app.emit("tab-drag-state", json!({"id": tab["id"], "title": tab["title"], "type": tab["type"]}));
            Ok(json!(token))
        },
        "end_drag" => { state.drags.lock().unwrap().remove(payload.as_str().unwrap_or("")); let _ = app.emit("tab-drag-state", Value::Null); Ok(Value::Null) },
        "accept_drag" => {
            let drag = state.drags.lock().unwrap().remove(payload.as_str().unwrap_or(""));
            let _ = app.emit("tab-drag-state", Value::Null);
            if let Some((source, tab, close)) = drag {
                if source == window.label() { return Ok(Value::Null); }
                if let Some(source_window) = app.get_webview_window(&source) { let _ = source_window.emit("remove-transferred-tab", json!({"id": tab["id"], "closeWindow": close})); }
                return Ok(tab);
            }
            Ok(Value::Null)
        },
        "detach_tab" => {
            let token = string(&payload, "token");
            let drag = state.drags.lock().unwrap().remove(token);
            let _ = app.emit("tab-drag-state", Value::Null);
            if let Some((source, tab, close)) = drag {
                if source != window.label() { return Ok(json!(false)); }
                let label = format!("tab-{}", uuid::Uuid::new_v4());
                state.bootstrap.lock().unwrap().insert(label.clone(), json!({"initialTab": tab, "primary": false}));
                let position = &payload["position"];
                let x = position["x"].as_f64().unwrap_or(300.0) - 180.0;
                let y = position["y"].as_f64().unwrap_or(100.0) - 18.0;
                tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::App("index.html".into()))
                    .title("Norways Diff Checker").inner_size(1440.0,900.0).min_inner_size(920.0,640.0)
                    .decorations(false).position(x,y).build().map_err(|e| e.to_string())?;
                let _ = window.emit("remove-transferred-tab", json!({"id": tab["id"], "closeWindow": close}));
                return Ok(json!(true));
            }
            Ok(json!(false))
        },
        "release_assets" => {
            let id = payload.as_str().unwrap_or("");
            if uuid::Uuid::parse_str(id).is_ok() {
                let path = state.root.join("cache/comparison-assets").join(id);
                if path.exists() { fs::remove_dir_all(path).map_err(|e| e.to_string())?; }
            }
            Ok(Value::Null)
        },
        "cancel_compare" => {
            if let Some(flag) = state.jobs.lock().unwrap().get(payload.as_str().unwrap_or("")) { flag.store(true, Ordering::Relaxed); }
            Ok(Value::Null)
        },
        _ => Err(format!("Unknown action: {action}")),
    }
}

#[tauri::command]
async fn install_libreoffice_async(
    window: WebviewWindow,
    state: tauri::State<'_, State>,
) -> Result<Value, String> {
    let root = state.root.clone();
    tauri::async_runtime::spawn_blocking(move || install_libreoffice(&root, &window))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn check_update_async() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(check_update).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn start_update_async(app: tauri::AppHandle, state: tauri::State<'_, State>) -> Result<(), String> {
    if !state.jobs.lock().map_err(|e| e.to_string())?.is_empty() {
        return Err("A comparison is still running. The update will be retried later.".into());
    }
    let root = state.root.clone();
    tauri::async_runtime::spawn_blocking(move || start_update(&root, app)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn delete_libreoffice_async(state: tauri::State<'_, State>) -> Result<Value, String> {
    let root = state.root.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = root.join("dependencies/libreoffice");
        if path.exists() {
            fs::remove_dir_all(path).map_err(|e| e.to_string())?;
        }
        Ok(show_status(&root))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn install_optional_async(window: WebviewWindow, state: tauri::State<'_, State>, kind: String) -> Result<Value, String> {
    let root = state.root.clone();
    tauri::async_runtime::spawn_blocking(move || install_optional(&root, &window, &kind))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn delete_optional_async(state: tauri::State<'_, State>, kind: String) -> Result<Value, String> {
    let root = state.root.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = optional_status(&root, &kind)?;
        if kind == "ocr" { compare::clear_ocr_cache(); }
        let path = root.join("dependencies").join(&kind);
        if path.exists() { fs::remove_dir_all(path).map_err(|e| e.to_string())?; }
        optional_status(&root, &kind)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn export_async(state: tauri::State<'_, State>, payload: Value) -> Result<Value, String> {
    let root = state.root.clone();
    tauri::async_runtime::spawn_blocking(move || compare::export(&root, &payload))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn start_compare(
    window: WebviewWindow,
    state: tauri::State<'_, State>,
    request: Value,
) -> Result<String, String> {
    let id = string(&request, "id").to_string();
    uuid::Uuid::parse_str(&id).map_err(|_| "Invalid comparison ID")?;
    if !["text", "images", "documents", "excel", "folders"].contains(&string(&request, "type")) {
        return Err("Invalid comparison type".into());
    }
    let flag = Arc::new(AtomicBool::new(false));
    state.jobs.lock().unwrap().insert(id.clone(), flag.clone());
    let root = state.root.clone();
    let id_for_thread = id.clone();
    std::thread::spawn(move || {
        let send = |value: Value| {
            let _ = window.emit("compare-event", json!({"id": id_for_thread, "kind": "progress", "value": value["value"], "phase": value["phase"]}));
        };
        let result = compare::run(&request, &root, &flag, send);
        if result.is_ok()
            && request["left"]["path"].is_string()
            && request["right"]["path"].is_string()
        {
            let state = window.app_handle().state::<State>();
            let _guard = state.settings_lock.lock().unwrap();
            let mut settings = get_settings(&state);
            let recent = json!({"type":request["type"],"left":request["left"]["path"],"right":request["right"]["path"]});
            let limit = settings["recentCompareLimit"].as_u64().unwrap_or(10) as usize;
            let mut entries = vec![recent.clone()];
            if let Some(previous) = settings["recentCompares"].as_array() {
                entries.extend(previous.iter().filter(|v| **v != recent).cloned());
            }
            entries.truncate(limit);
            settings["recentCompares"] = json!(entries);
            let _ = save_settings(&state, settings);
        }
        let event = if flag.load(Ordering::Relaxed) {
            json!({"id": id_for_thread, "kind": "cancelled"})
        } else {
            match result {
                Ok(result) => json!({"id": id_for_thread, "kind": "result", "result": result}),
                Err(error) => {
                    json!({"id": id_for_thread, "kind": "error", "code": if error.contains("LibreOffice is required") { "LIBREOFFICE_REQUIRED" } else if error.contains("PDFium is required") { "PDFIUM_REQUIRED" } else if error.contains("OCR models are required") { "OCR_REQUIRED" } else { "COMPARISON_FAILED" }, "error": error})
                }
            }
        };
        let _ = window.emit("compare-event", event);
        window
            .app_handle()
            .state::<State>()
            .jobs
            .lock()
            .unwrap()
            .remove(&id_for_thread);
    });
    Ok(id)
}

fn main() {
    let root = data_root();
    let _ = fs::create_dir_all(root.join("cache/comparison-assets"));
    let asset_root = root.join("cache/comparison-assets");
    tauri::Builder::default()
        .register_uri_scheme_protocol("ndc-asset", move |_context, request| {
            let missing = || {
                tauri::http::Response::builder()
                    .status(404)
                    .body(Vec::new())
                    .unwrap()
            };
            let path = request.uri().path().trim_start_matches('/');
            let mut parts = path.split('/');
            let Some(id) = parts.next() else {
                return missing();
            };
            let Some(name) = parts.next() else {
                return missing();
            };
            if uuid::Uuid::parse_str(id).is_err()
                || parts.next().is_some()
                || !name.ends_with(".png")
                || !name
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'.')
            {
                return missing();
            }
            match fs::read(asset_root.join(id).join(name)) {
                Ok(bytes) => tauri::http::Response::builder()
                    .header("Content-Type", "image/png")
                    .header("Access-Control-Allow-Origin", "*")
                    .body(bytes)
                    .unwrap(),
                Err(_) => missing(),
            }
        })
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let paths: Vec<String> = argv
                .into_iter()
                .skip(1)
                .filter(|s| Path::new(s).exists())
                .collect();
            if !paths.is_empty() {
                let state = app.state::<State>();
                let target = if paths.len() == 1 {
                    describe_one(Path::new(&paths[0])).ok().and_then(|input| {
                        let types = input["types"].as_array()?;
                        state
                            .active_tabs
                            .lock()
                            .unwrap()
                            .iter()
                            .find(|(_, tab)| {
                                let compatible = types.iter().any(|t| t == &tab["type"]);
                                compatible && ((tab["left"] == true) != (tab["right"] == true))
                            })
                            .map(|(label, _)| label.clone())
                    })
                } else {
                    None
                };
                let selected = target.as_deref().unwrap_or("main");
                if let Some(window) = app.get_webview_window(selected) {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.emit(
                        "open-paths",
                        json!({"paths":paths,"mode":if target.is_some(){"reuse"}else{"new"}}),
                    );
                }
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(State {
            root,
            settings_lock: Mutex::new(()),
            jobs: Mutex::new(HashMap::new()),
            drags: Mutex::new(HashMap::new()),
            bootstrap: Mutex::new(HashMap::new()),
            primary: Mutex::new("main".into()),
            active_tabs: Mutex::new(HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![
            native_call,
            start_compare,
            install_libreoffice_async,
            delete_libreoffice_async,
            install_optional_async,
            delete_optional_async,
            check_update_async,
            start_update_async,
            export_async
        ])
        .on_window_event(|window, event| {
            if !matches!(event, tauri::WindowEvent::Destroyed) {
                return;
            }
            let app = window.app_handle();
            let state = app.state::<State>();
            state.active_tabs.lock().unwrap().remove(window.label());
            if *state.primary.lock().unwrap() != window.label() {
                return;
            }
            let next = app
                .webview_windows()
                .into_keys()
                .find(|label| label != window.label());
            if let Some(label) = next {
                *state.primary.lock().unwrap() = label.clone();
                if let Some(next_window) = app.get_webview_window(&label) {
                    let _ = next_window.emit("primary-window", true);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Unable to start Norways Diff Checker");
}
