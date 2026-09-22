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
    scheduled_update: Mutex<Option<String>>,
    update_download: Arc<Mutex<Option<UpdateDownload>>>,
}

struct UpdateDownload {
    cancelled: Arc<AtomicBool>,
    launching: bool,
}

const SETTINGS_FILE: &str = "preferences.json";

fn select_data_root(
    exe: Option<&Path>,
    registry_root: Option<PathBuf>,
    default_root: PathBuf,
) -> PathBuf {
    let exe_folder = exe.and_then(Path::parent);
    if let Some(folder) = exe_folder {
        if folder.join(SETTINGS_FILE).is_file() {
            return folder.to_path_buf();
        }
        if let Some(parent) = folder.parent() {
            if parent.join(SETTINGS_FILE).is_file() {
                return parent.to_path_buf();
            }
        }
    }
    if let Some(root) = registry_root {
        return root;
    }
    if default_root.join(SETTINGS_FILE).is_file() {
        return default_root;
    }
    exe_folder.map(Path::to_path_buf).unwrap_or(default_root)
}

#[cfg(windows)]
fn registry_install_root() -> Option<PathBuf> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};

    let software = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(key) = software.open_subkey(r"Software\NorwaysDiffChecker") {
        if let Ok(path) = key.get_value::<String, _>("AppPath") {
            if !path.trim().is_empty() {
                let mut root = PathBuf::from(path);
                if root
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("app"))
                {
                    root.pop();
                }
                return Some(root);
            }
        }
        // DataPath was written by installers before 0.1.4.
        if let Ok(path) = key.get_value::<String, _>("DataPath") {
            if !path.trim().is_empty() {
                return Some(PathBuf::from(path));
            }
        }
    }
    software
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\NorwaysDiffChecker")
        .ok()
        .and_then(|key| key.get_value::<String, _>("InstallLocation").ok())
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
}

#[cfg(not(windows))]
fn registry_install_root() -> Option<PathBuf> {
    None
}

fn data_root() -> PathBuf {
    #[cfg(windows)]
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir());
    #[cfg(not(windows))]
    let base = std::env::temp_dir();
    let exe = std::env::current_exe().ok();
    select_data_root(
        exe.as_deref(),
        registry_install_root(),
        base.join("NorwaysDiffChecker"),
    )
}

fn installed_copy() -> bool {
    let Some(root) = registry_install_root() else {
        return false;
    };
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    [
        root.join("norways-diff-checker.exe"),
        root.join("app/norways-diff-checker.exe"),
    ]
    .iter()
    .any(|candidate| paths_equal(candidate, &exe))
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    let left = left.canonicalize().unwrap_or_else(|_| left.to_path_buf());
    let right = right.canonicalize().unwrap_or_else(|_| right.to_path_buf());
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

#[cfg(test)]
mod data_root_tests {
    use super::*;

    fn test_root() -> PathBuf {
        std::env::temp_dir().join(format!("ndc-data-root-test-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn settings_beside_executable_win_over_every_fallback() {
        let root = test_root();
        let exe_dir = root.join("portable");
        let registry = root.join("registered");
        let default = root.join("default");
        fs::create_dir_all(&exe_dir).unwrap();
        fs::write(exe_dir.join(SETTINGS_FILE), b"{}").unwrap();
        assert_eq!(
            select_data_root(Some(&exe_dir.join("app.exe")), Some(registry), default),
            exe_dir
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn parent_settings_are_found_from_app_subfolder() {
        let root = test_root();
        let app = root.join("NorwaysDiffChecker/app");
        fs::create_dir_all(&app).unwrap();
        fs::write(root.join("NorwaysDiffChecker").join(SETTINGS_FILE), b"{}").unwrap();
        assert_eq!(
            select_data_root(Some(&app.join("app.exe")), None, root.join("default")),
            root.join("NorwaysDiffChecker")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn registry_precedes_existing_default_settings() {
        let root = test_root();
        let exe_dir = root.join("portable");
        let registry = root.join("registered");
        let default = root.join("default");
        fs::create_dir_all(&exe_dir).unwrap();
        fs::create_dir_all(&default).unwrap();
        fs::write(default.join(SETTINGS_FILE), b"{}").unwrap();
        assert_eq!(
            select_data_root(
                Some(&exe_dir.join("app.exe")),
                Some(registry.clone()),
                default
            ),
            registry
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unused_portable_copy_falls_back_to_its_own_folder() {
        let root = test_root();
        let exe_dir = root.join("portable");
        fs::create_dir_all(&exe_dir).unwrap();
        assert_eq!(
            select_data_root(Some(&exe_dir.join("app.exe")), None, root.join("default")),
            exe_dir
        );
        fs::remove_dir_all(root).unwrap();
    }
}

fn build_commit() -> &'static str {
    option_env!("NDC_BUILD_COMMIT").unwrap_or("")
}
fn build_version() -> String {
    serde_json::from_str::<Value>(include_str!("../../package.json"))
        .ok()
        .map(|v| string(&v, "version").to_string())
        .unwrap_or_default()
}

fn update_manifest() -> Result<Value, String> {
    let mut response =
        ureq::get("https://api.github.com/repos/Norway174/Norways-Diff-Checker/releases/latest")
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "NorwaysDiffChecker")
            .header("Cache-Control", "no-cache")
            .call()
            .map_err(|e| e.to_string())?;
    let mut body = String::new();
    response
        .body_mut()
        .as_reader()
        .take(131_072)
        .read_to_string(&mut body)
        .map_err(|e| e.to_string())?;
    let release: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let tag = string(&release, "tag_name");
    let version = string(&release, "name");
    let encoded_tag = format!(
        "x-{}",
        version
            .as_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
    let commit = string(&release, "target_commitish");
    if version.is_empty()
        || version.len() > 255
        || (tag != format!("v{version}") && tag != encoded_tag)
        || tag.len() > 600
        || !tag
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        || commit.len() != 40
        || !commit.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("Invalid update release metadata.".into());
    }
    let asset_version = if tag == format!("v{version}") {
        version
    } else {
        tag
    };
    let installer_name = format!("NorwaysDiffChecker-{asset_version}-Installer.exe");
    let installer = release["assets"]
        .as_array()
        .ok_or("Update release has no assets.")?
        .iter()
        .find(|asset| string(asset, "name") == installer_name)
        .ok_or("Update release has no installer.")?;
    let url = string(installer, "browser_download_url");
    let digest = string(installer, "digest");
    let hash = digest
        .strip_prefix("sha256:")
        .ok_or("Update installer has no SHA-256 digest.")?;
    let bytes = installer["size"]
        .as_u64()
        .ok_or("Update installer has no size.")?;
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit())
        || bytes == 0 || bytes > 100_000_000
        || url != format!("https://github.com/Norway174/Norways-Diff-Checker/releases/download/{tag}/{installer_name}") {
        return Err("Invalid update installer asset.".into());
    }
    Ok(
        json!({"version":version,"commit":commit,"installerUrl":url,"installerSha256":hash,"installerBytes":bytes}),
    )
}
fn check_update() -> Result<Value, String> {
    let current = build_commit();
    let version = build_version();
    if current.len() != 40 || !installed_copy() {
        return Ok(json!({"available":false,"currentVersion":version}));
    }
    let manifest = update_manifest()?;
    let published = string(&manifest, "version");
    Ok(
        json!({"available":version != published,"currentVersion":version,"publishedVersion":published}),
    )
}
fn download_update<F>(root: &Path, manifest: &Value, mut progress: F) -> Result<PathBuf, String>
where
    F: FnMut(u64, u64, &str) -> Result<(), String>,
{
    let commit = string(&manifest, "commit");
    let cache = root.join("cache/updates");
    fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let installer = cache.join(format!("Installer-{commit}.exe"));
    let expected = string(&manifest, "installerSha256");
    let total = manifest["installerBytes"]
        .as_u64()
        .ok_or("Invalid installer size.")?;
    progress(0, total, "Downloading")?;
    if !installer.exists() || file_hash(&installer)? != expected {
        let partial = cache.join(format!("Installer-{commit}.partial"));
        let _ = fs::remove_file(&partial);
        let result = (|| -> Result<(), String> {
            let mut response = ureq::get(string(&manifest, "installerUrl"))
                .call()
                .map_err(|e| e.to_string())?;
            let mut reader = response.body_mut().as_reader();
            let mut file = File::create(&partial).map_err(|e| e.to_string())?;
            let mut hasher = Sha256::new();
            let mut buffer = [0u8; 65536];
            let mut received = 0u64;
            loop {
                progress(received, total, "Downloading")?;
                let n = reader.read(&mut buffer).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                received += n as u64;
                if received > 100_000_000 {
                    return Err("Installer download is too large.".into());
                }
                file.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
                hasher.update(&buffer[..n]);
                progress(received, total, "Downloading")?;
            }
            progress(received, total, "Verifying")?;
            if format!("{:x}", hasher.finalize()) != expected {
                return Err("Installer download failed SHA-256 verification.".into());
            }
            drop(file);
            fs::rename(&partial, &installer).map_err(|e| e.to_string())?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&partial);
        }
        result?;
    }
    progress(total, total, "Verifying")?;
    Ok(installer)
}
fn start_update(
    root: &Path,
    app: tauri::AppHandle,
    expected_version: &str,
    update_download: &Arc<Mutex<Option<UpdateDownload>>>,
    cancelled: &Arc<AtomicBool>,
) -> Result<(), String> {
    if cancelled.load(Ordering::SeqCst) {
        return Err("Update cancelled.".into());
    }
    let _ = app.emit("update-download-progress", json!({"version":expected_version,"phase":"Checking release","receivedBytes":0,"totalBytes":0,"percent":0}));
    let manifest = update_manifest()?;
    if string(&manifest, "version") != expected_version {
        return Err("The available update changed. Check again.".into());
    }
    if build_version() == expected_version {
        return Ok(());
    }
    let installer = download_update(root, &manifest, |received, total, phase| {
        if cancelled.load(Ordering::SeqCst) {
            return Err("Update cancelled.".into());
        }
        let percent = if total == 0 {
            0
        } else {
            (received.min(total) * 100 / total) as u8
        };
        let _ = app.emit("update-download-progress", json!({"version":expected_version,"phase":phase,"receivedBytes":received,"totalBytes":total,"percent":percent}));
        Ok(())
    })?;
    let mut slot = update_download.lock().map_err(|e| e.to_string())?;
    if cancelled.load(Ordering::SeqCst) {
        return Err("Update cancelled.".into());
    }
    if let Some(operation) = slot.as_mut() {
        operation.launching = true;
    }
    let _ = app.emit("update-download-progress", json!({"version":expected_version,"phase":"Starting installer","receivedBytes":0,"totalBytes":0,"percent":100}));
    Command::new(installer)
        .args(["/UPDATE", "/S"])
        .creation_flags_hidden()
        .spawn()
        .map_err(|e| e.to_string())?;
    drop(slot);
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        app.exit(0);
    });
    Ok(())
}
fn update_on_close(expected_commit: &str) -> Result<(), String> {
    if expected_commit.len() != 40 || !expected_commit.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid scheduled update.".into());
    }
    let manifest = update_manifest()?;
    if !string(&manifest, "commit").eq_ignore_ascii_case(expected_commit) {
        return Err("The scheduled update changed.".into());
    }
    let installer = download_update(&data_root(), &manifest, |_, _, _| Ok(()))?;
    Command::new(installer)
        .args(["/UPDATE", "/S", "/NOLAUNCH"])
        .creation_flags_hidden()
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn settings_path(state: &State) -> PathBuf {
    state.root.join(SETTINGS_FILE)
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
    if let Some(version) = raw.get("skippedUpdateVersion").and_then(Value::as_str) {
        if version.len() <= 255 {
            value["skippedUpdateVersion"] = json!(version);
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

fn ensure_settings(root: &Path) -> Result<(), String> {
    let path = root.join(SETTINGS_FILE);
    if path.exists() {
        return Ok(());
    }
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    fs::write(
        path,
        serde_json::to_vec_pretty(&clean_settings(Value::Null)).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
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
const MIB: u64 = 1024 * 1024;
const LIBREOFFICE_VERSION: &str = "26.2.6";
const LIBREOFFICE_DOWNLOAD_BYTES: u64 = 373252096;
const LIBREOFFICE_INSTALLED_BYTES: u64 = 1596766810;

fn show_status(root: &Path) -> Value {
    let installed = root
        .join("dependencies/libreoffice/program/soffice.exe")
        .exists();
    json!({"installed": installed, "version": LIBREOFFICE_VERSION, "downloadBytes": LIBREOFFICE_DOWNLOAD_BYTES,
        "installedBytes": if installed {LIBREOFFICE_INSTALLED_BYTES} else {0}, "installedBytesEstimate": LIBREOFFICE_INSTALLED_BYTES})
}

fn cached_bytes(cache: &Path, files: &[(&str, u64)]) -> u64 {
    files
        .iter()
        .filter_map(|(name, expected)| {
            fs::metadata(cache.join(name))
                .ok()
                .filter(|metadata| metadata.is_file() && metadata.len() == *expected)
                .map(|_| *expected)
        })
        .sum()
}

fn readable_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    let precision = if value >= 100.0 || unit == 0 { 0 } else { 1 };
    format!("{value:.precision$} {}", UNITS[unit])
}

fn disk_space_error(label: &str, required: u64, available: u64) -> String {
    let shortfall = required.saturating_sub(available);
    format!(
        "Not enough disk space to install {label}. About {} is required (including temporary files), but only {} is available. Free at least {} and try again.",
        readable_bytes(required),
        readable_bytes(available),
        readable_bytes(shortfall)
    )
}

#[cfg(windows)]
fn available_disk_space(path: &Path) -> Result<u64, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut available = 0u64;
    let result = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if result == 0 {
        Err(format!(
            "Unable to check free disk space: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(available)
    }
}

#[cfg(not(windows))]
fn available_disk_space(_path: &Path) -> Result<u64, String> {
    Ok(u64::MAX)
}

fn ensure_install_space(root: &Path, label: &str, required: u64) -> Result<(), String> {
    let available = available_disk_space(root)?;
    if available < required {
        Err(disk_space_error(label, required, available))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod disk_space_tests {
    use super::*;

    #[test]
    fn storage_sizes_are_readable() {
        assert_eq!(readable_bytes(0), "0 B");
        assert_eq!(readable_bytes(1536), "1.5 KB");
        assert_eq!(readable_bytes(1596766810), "1.5 GB");
    }

    #[test]
    fn storage_error_explains_required_available_and_shortfall() {
        let error = disk_space_error("LibreOffice", 2 * 1024 * MIB, 1536 * MIB);
        assert_eq!(
            error,
            "Not enough disk space to install LibreOffice. About 2.0 GB is required (including temporary files), but only 1.5 GB is available. Free at least 512 MB and try again."
        );
    }
}

const PDFIUM_HASH: &str = "79d4676b656cfb1abcea88f9ade3b4b0826c5200382db5f4ec72a636c598c118";
const PDFIUM_ARCHIVE_HASH: &str =
    "73cc0de638ac2095e7445bf56a38200a5b7c7ca0e9f4ba144598f2457377ac08";
const OCR_DETECTION_HASH: &str = "f15cfb56bd02c4bf478a20343986504a1f01e1665c2b3a0ad66340f054b1b5ca";
const OCR_RECOGNITION_HASH: &str =
    "e484866d4cce403175bd8d00b128feb08ab42e208de30e42cd9889d8f1735a6e";

fn file_hash(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}
fn optional_status(root: &Path, kind: &str) -> Result<Value, String> {
    let (installed, version, download, installed_size) = match kind {
        "pdfium" => (
            root.join("dependencies/pdfium/pdfium.dll").exists(),
            "151.0.7881.0",
            3733154u64,
            7211520u64,
        ),
        "ocr" => (
            root.join("dependencies/ocr/text-detection.rten").exists()
                && root.join("dependencies/ocr/text-recognition.rten").exists(),
            "ocrs",
            12226852u64,
            12226852u64,
        ),
        _ => return Err("Unknown optional dependency.".into()),
    };
    Ok(
        json!({"installed":installed,"version":version,"downloadBytes":download,"installedBytes":if installed {installed_size} else {0},"installedBytesEstimate":installed_size}),
    )
}
fn emit_optional_progress(
    window: &WebviewWindow,
    kind: &str,
    phase: &str,
    received: u64,
    total: u64,
) {
    let _ = window.emit("optional-dependency-progress", json!({"kind":kind,"phase":phase,"receivedBytes":received,"totalBytes":total,"percent":received.saturating_mul(100)/total.max(1)}));
}
fn download_optional(
    root: &Path,
    window: &WebviewWindow,
    kind: &str,
    name: &str,
    url: &str,
    hash: &str,
    size: u64,
    base: u64,
    total: u64,
) -> Result<PathBuf, String> {
    let cache = root.join("dependencies/downloads");
    fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let target = cache.join(name);
    if target.exists()
        && fs::metadata(&target).map_err(|e| e.to_string())?.len() == size
        && file_hash(&target)? == hash
    {
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
            if n == 0 {
                break;
            }
            received += n as u64;
            if received > size {
                return Err(format!("{name} download exceeded expected size."));
            }
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
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result?;
    Ok(target)
}
fn install_optional(root: &Path, window: &WebviewWindow, kind: &str) -> Result<Value, String> {
    let install = root.join("dependencies").join(kind);
    let staging = root.join("dependencies").join(format!("{kind}.installing"));
    let _ = optional_status(root, kind)?;
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|e| e.to_string())?;
    }
    let cache = root.join("dependencies/downloads");
    let (label, downloads, installed_bytes) = match kind {
        "pdfium" => (
            "PDFium",
            vec![("pdfium-win-x64-7881.tgz", 3733154u64)],
            7211520u64,
        ),
        "ocr" => (
            "OCR models",
            vec![
                ("text-detection.rten", 2510284u64),
                ("text-recognition.rten", 9716568u64),
            ],
            12226852u64,
        ),
        _ => return Err("Unknown optional dependency.".into()),
    };
    emit_optional_progress(window, kind, "Checking storage", 0, 1);
    let download_bytes: u64 = downloads.iter().map(|(_, size)| *size).sum();
    let required = download_bytes
        .saturating_sub(cached_bytes(&cache, &downloads))
        .saturating_add(installed_bytes)
        .saturating_add(64 * MIB);
    ensure_install_space(root, label, required)?;
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let result = (|| -> Result<(), String> {
        match kind {
            "pdfium" => {
                let archive = download_optional(root, window, kind, "pdfium-win-x64-7881.tgz", "https://github.com/bblanchon/pdfium-binaries/releases/download/chromium%2F7881/pdfium-win-x64.tgz", PDFIUM_ARCHIVE_HASH, 3733154, 0, 3733154)?;
                emit_optional_progress(window, kind, "Installing", 0, 7211520);
                let decoder =
                    flate2::read::GzDecoder::new(File::open(archive).map_err(|e| e.to_string())?);
                let mut archive = tar::Archive::new(decoder);
                let mut found = false;
                for entry in archive.entries().map_err(|e| e.to_string())? {
                    let mut entry = entry.map_err(|e| e.to_string())?;
                    if entry.path().map_err(|e| e.to_string())?.as_ref()
                        == Path::new("bin/pdfium.dll")
                    {
                        let mut file =
                            File::create(staging.join("pdfium.dll")).map_err(|e| e.to_string())?;
                        std::io::copy(&mut entry, &mut file).map_err(|e| e.to_string())?;
                        found = true;
                        break;
                    }
                }
                if !found || file_hash(&staging.join("pdfium.dll"))? != PDFIUM_HASH {
                    return Err("PDFium library failed SHA-256 verification.".into());
                }
                emit_optional_progress(window, kind, "Installing", 7211520, 7211520);
            }
            "ocr" => {
                let files = [
                    ("text-detection.rten", OCR_DETECTION_HASH, 2510284u64, 0u64),
                    (
                        "text-recognition.rten",
                        OCR_RECOGNITION_HASH,
                        9716568u64,
                        2510284u64,
                    ),
                ];
                for (name, hash, size, base) in files {
                    let url = format!("https://ocrs-models.s3-accelerate.amazonaws.com/{name}");
                    let file = download_optional(
                        root, window, kind, name, &url, hash, size, base, 12226852,
                    )?;
                    fs::copy(file, staging.join(name)).map_err(|e| e.to_string())?;
                }
                emit_optional_progress(window, kind, "Installing", 12226852, 12226852);
            }
            _ => return Err("Unknown optional dependency.".into()),
        }
        if install.exists() {
            fs::remove_dir_all(&install).map_err(|e| e.to_string())?;
        }
        fs::rename(&staging, &install).map_err(|e| e.to_string())?;
        if kind == "ocr" {
            compare::clear_ocr_cache();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result?;
    optional_status(root, kind)
}
fn install_libreoffice(root: &Path, window: &WebviewWindow) -> Result<Value, String> {
    const HASH: &str = "f9877032fd908beb9c0ddf06df4af5c2e85f419c42e14876c4cce5aae5fb2660";
    let cache = root.join("dependencies/downloads");
    let install = root.join("dependencies/libreoffice");
    let staging = root.join("dependencies/libreoffice.installing");
    fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|e| e.to_string())?;
    }
    let msi_name = format!("LibreOffice_{LIBREOFFICE_VERSION}_Win_x86-64.msi");
    let msi = cache.join(&msi_name);
    let _ = window.emit(
        "libreoffice-progress",
        json!({"phase":"Checking storage","receivedBytes":0,"totalBytes":1,"percent":0}),
    );
    let cached = cached_bytes(&cache, &[(msi_name.as_str(), LIBREOFFICE_DOWNLOAD_BYTES)]);
    ensure_install_space(
        root,
        "LibreOffice",
        LIBREOFFICE_DOWNLOAD_BYTES
            .saturating_sub(cached)
            .saturating_add(LIBREOFFICE_INSTALLED_BYTES)
            .saturating_add(256 * MIB),
    )?;
    let download = || -> Result<(), String> {
        let url=format!("https://download.documentfoundation.org/libreoffice/stable/{LIBREOFFICE_VERSION}/win/x86_64/{msi_name}");
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
    ensure_install_space(
        root,
        "LibreOffice",
        LIBREOFFICE_INSTALLED_BYTES.saturating_add(256 * MIB),
    )?;
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
        let code = result.code().unwrap_or_default();
        let disk_error = ensure_install_space(
            root,
            "LibreOffice",
            LIBREOFFICE_INSTALLED_BYTES.saturating_add(256 * MIB),
        )
        .err();
        let _ = fs::remove_dir_all(&staging);
        if let Some(error) = disk_error {
            return Err(error);
        }
        return Err(if code == 1619 {
            "Windows Installer could not open the verified LibreOffice package. Restart Windows and try again. If the problem continues, delete the cached download from the app data folder and retry. (exit code 1619)".into()
        } else {
            format!("Windows Installer could not extract LibreOffice (exit code {code}). Restart Windows and try again.")
        });
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
        json!({"installed":true,"version":LIBREOFFICE_VERSION,"downloadBytes":LIBREOFFICE_DOWNLOAD_BYTES,"installedBytes":LIBREOFFICE_INSTALLED_BYTES,"installedBytesEstimate":LIBREOFFICE_INSTALLED_BYTES}),
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
            for key in ["restoreTabs","recentCompareLimit","recentCompares","lastImageView","tabs","activeTabId","skippedUpdateVersion"] {
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
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let folder = exe.parent().ok_or("Unable to locate the app folder.")?;
            let installer = if folder.file_name().is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("app")) {
                folder.parent().unwrap_or(folder).join("Installer.exe")
            } else {
                folder.join("Installer.exe")
            };
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
    tauri::async_runtime::spawn_blocking(check_update)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn start_update_async(
    app: tauri::AppHandle,
    state: tauri::State<'_, State>,
    expected_version: String,
) -> Result<(), String> {
    if !state.jobs.lock().map_err(|e| e.to_string())?.is_empty() {
        return Err("A comparison is still running. The update will be retried later.".into());
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    let update_download = state.update_download.clone();
    {
        let mut slot = update_download.lock().map_err(|e| e.to_string())?;
        if slot.is_some() {
            return Err("An update download is already running.".into());
        }
        *slot = Some(UpdateDownload {
            cancelled: cancelled.clone(),
            launching: false,
        });
    }
    let root = state.root.clone();
    *state.scheduled_update.lock().map_err(|e| e.to_string())? = None;
    let operation = update_download.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        start_update(&root, app, &expected_version, &operation, &cancelled)
    })
    .await
    .map_err(|e| e.to_string());
    *update_download.lock().map_err(|e| e.to_string())? = None;
    result?
}

#[tauri::command]
fn cancel_update_download(state: tauri::State<'_, State>) -> Result<bool, String> {
    let slot = state.update_download.lock().map_err(|e| e.to_string())?;
    if let Some(operation) = slot.as_ref() {
        if operation.launching {
            return Ok(false);
        }
        operation.cancelled.store(true, Ordering::SeqCst);
        return Ok(true);
    }
    Ok(false)
}

#[tauri::command]
async fn schedule_update_on_close_async(
    state: tauri::State<'_, State>,
    expected_version: String,
) -> Result<(), String> {
    let manifest = tauri::async_runtime::spawn_blocking(update_manifest)
        .await
        .map_err(|e| e.to_string())??;
    if string(&manifest, "version") != expected_version || build_version() == expected_version {
        return Err("The available update changed. Check again.".into());
    }
    *state.scheduled_update.lock().map_err(|e| e.to_string())? =
        Some(string(&manifest, "commit").to_string());
    Ok(())
}

#[tauri::command]
fn cancel_scheduled_update(state: tauri::State<'_, State>) -> Result<(), String> {
    *state.scheduled_update.lock().map_err(|e| e.to_string())? = None;
    Ok(())
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
async fn install_optional_async(
    window: WebviewWindow,
    state: tauri::State<'_, State>,
    kind: String,
) -> Result<Value, String> {
    let root = state.root.clone();
    tauri::async_runtime::spawn_blocking(move || install_optional(&root, &window, &kind))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn delete_optional_async(
    state: tauri::State<'_, State>,
    kind: String,
) -> Result<Value, String> {
    let root = state.root.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = optional_status(&root, &kind)?;
        if kind == "ocr" {
            compare::clear_ocr_cache();
        }
        let path = root.join("dependencies").join(&kind);
        if path.exists() {
            fs::remove_dir_all(path).map_err(|e| e.to_string())?;
        }
        optional_status(&root, &kind)
    })
    .await
    .map_err(|e| e.to_string())?
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
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--update-on-close") {
        let result = args
            .get(2)
            .ok_or_else(|| "Missing scheduled update commit.".to_string())
            .and_then(|commit| update_on_close(commit));
        if let Err(error) = result {
            let _ = fs::create_dir_all(data_root().join("cache/updates"));
            let _ = fs::write(data_root().join("cache/updates/last-error.txt"), error);
        }
        return;
    }
    let root = data_root();
    let _ = ensure_settings(&root);
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
            scheduled_update: Mutex::new(None),
            update_download: Arc::new(Mutex::new(None)),
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
            cancel_update_download,
            schedule_update_on_close_async,
            cancel_scheduled_update,
            export_async
        ])
        .on_window_event(|window, event| {
            if !matches!(event, tauri::WindowEvent::Destroyed) {
                return;
            }
            let app = window.app_handle();
            let state = app.state::<State>();
            state.active_tabs.lock().unwrap().remove(window.label());
            let remaining = app
                .webview_windows()
                .into_keys()
                .any(|label| label != window.label());
            if !remaining {
                if let Some(commit) = state.scheduled_update.lock().unwrap().take() {
                    if let Ok(exe) = std::env::current_exe() {
                        let _ = Command::new(exe)
                            .args(["--update-on-close", &commit])
                            .creation_flags_hidden()
                            .spawn();
                    }
                }
            }
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
