use std::{
    fs,
    path::{Path, PathBuf},
};

pub fn check_migrations(directory: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    for entry in
        fs::read_dir(directory).map_err(|error| format!("Cannot read SQL migrations: {error}"))?
    {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.extension().is_some_and(|extension| extension == "sql") {
            files.push(path);
        }
    }
    files.sort();
    if files.is_empty() {
        return Err("No SQL migrations were found.".into());
    }
    for file in &files {
        let bytes =
            fs::read(file).map_err(|error| format!("Cannot read {}: {error}", file.display()))?;
        if bytes.contains(&b'\r') {
            return Err(format!("{} contains CR/CRLF line endings. Save SQL migrations with LF only, as required by .gitattributes; SQLx hashes the exact bytes.", file.display()));
        }
    }
    Ok(files)
}
