#[path = "build_support/migrations.rs"]
mod migration_policy;

fn main() {
    println!("cargo:rerun-if-changed=migrations");
    println!("cargo:rerun-if-changed=build_support/migrations.rs");
    let files = migration_policy::check_migrations(std::path::Path::new("migrations"))
        .unwrap_or_else(|error| panic!("Non-canonical SQL migration: {error}"));
    for file in files {
        println!("cargo:rerun-if-changed={}", file.display());
    }
    tauri_build::build()
}
