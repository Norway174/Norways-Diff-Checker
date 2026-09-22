fn main() {
    println!("cargo:rerun-if-env-changed=NDC_BUILD_COMMIT");
    tauri_build::build()
}
