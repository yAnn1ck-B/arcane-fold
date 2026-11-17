// Verification-only: copied into the runner checkout examples directory after
// the release artifact is frozen. Production app source/configuration are unchanged. Uses the real updater's AppImage replacement path with MockRuntime;
// it never launches an application or registers database/progression plugins.

#[cfg(target_os = "linux")]
mod linux {
    use reqwest::Url;
    use serde_json::{json, Value};
    use std::{
        collections::HashMap,
        ffi::OsStr,
        fs::{self, File},
        io::Read,
        net::IpAddr,
        os::unix::fs::PermissionsExt,
        path::{Path, PathBuf},
        time::Duration,
    };
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
    use tauri_plugin_updater::UpdaterExt;

    const MAX_APPIMAGE_BYTES: u64 = 512 * 1024 * 1024;

    struct Arguments {
        appimage: PathBuf,
        config: PathBuf,
        endpoint: String,
        mode: String,
        old_version: String,
        new_version: String,
    }

    fn arguments() -> Result<Arguments, String> {
        let mut values = HashMap::new();
        let mut args = std::env::args().skip(1);
        while let Some(flag) = args.next() {
            if !matches!(
                flag.as_str(),
                "--appimage"
                    | "--config"
                    | "--endpoint"
                    | "--mode"
                    | "--old-version"
                    | "--new-version"
            ) {
                return Err(format!("Unknown QA argument: {flag}"));
            }
            let value = args
                .next()
                .ok_or_else(|| format!("Missing value for {flag}"))?;
            if values.insert(flag.clone(), value).is_some() {
                return Err(format!("Duplicate QA argument: {flag}"));
            }
        }
        let mut required = |flag: &str| {
            values
                .remove(flag)
                .ok_or_else(|| format!("Required: {flag}"))
        };
        let result = Arguments {
            appimage: PathBuf::from(required("--appimage")?),
            config: PathBuf::from(required("--config")?),
            endpoint: required("--endpoint")?,
            mode: required("--mode")?,
            old_version: required("--old-version")?,
            new_version: required("--new-version")?,
        };
        if !matches!(result.mode.as_str(), "tampered" | "good") {
            return Err("--mode must be tampered or good.".into());
        }
        Ok(result)
    }

    fn loopback_url(value: &str) -> Result<Url, String> {
        let parsed = Url::parse(value).map_err(|error| error.to_string())?;
        let address = parsed.host_str().unwrap_or("").trim_matches(['[', ']']);
        let address: IpAddr = address
            .parse()
            .map_err(|_| "QA URLs must use a literal loopback IP address.")?;
        if !address.is_loopback()
            || parsed.scheme() != "http"
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.fragment().is_some()
        {
            return Err(
                "Only credential-free HTTP loopback URLs are allowed for this QA probe.".into(),
            );
        }
        Ok(parsed)
    }

    fn validated_appimage(path: &Path) -> Result<PathBuf, String> {
        let qa_root = std::env::var_os("LINUX_QA_ROOT")
            .ok_or("LINUX_QA_ROOT must identify the isolated QA directory.")?;
        let qa_root = PathBuf::from(qa_root);
        if !qa_root.is_absolute() || !path.is_absolute() {
            return Err("LINUX_QA_ROOT and --appimage must be absolute paths.".into());
        }
        let qa_root = fs::canonicalize(qa_root).map_err(|error| error.to_string())?;
        if qa_root == Path::new("/") || !qa_root.is_dir() {
            return Err("LINUX_QA_ROOT cannot be the filesystem root.".into());
        }
        if fs::symlink_metadata(path)
            .map_err(|error| error.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("The installed QA AppImage cannot be a symbolic link.".into());
        }
        let resolved = fs::canonicalize(path).map_err(|error| error.to_string())?;
        if resolved == qa_root
            || !resolved.starts_with(&qa_root)
            || resolved.extension() != Some(OsStr::new("AppImage"))
        {
            return Err(
                "The target must be a regular .AppImage strictly inside LINUX_QA_ROOT.".into(),
            );
        }
        let metadata = resolved.metadata().map_err(|error| error.to_string())?;
        if !metadata.is_file()
            || metadata.len() < 4
            || metadata.len() > MAX_APPIMAGE_BYTES
            || metadata.permissions().mode() & 0o111 == 0
        {
            return Err(
                "The target must be an executable QA AppImage smaller than 512 MiB.".into(),
            );
        }
        let mut magic = [0_u8; 4];
        File::open(&resolved)
            .and_then(|mut file| file.read_exact(&mut magic))
            .map_err(|error| error.to_string())?;
        if magic != *b"\x7fELF" {
            return Err("The installed QA AppImage is not an ELF executable.".into());
        }
        Ok(resolved)
    }

    fn file_matches(path: &Path, expected: &[u8]) -> Result<bool, String> {
        let mut file = File::open(path).map_err(|error| error.to_string())?;
        if file.metadata().map_err(|error| error.to_string())?.len() != expected.len() as u64 {
            return Ok(false);
        }
        let mut buffer = [0_u8; 64 * 1024];
        for part in expected.chunks(buffer.len()) {
            file.read_exact(&mut buffer[..part.len()])
                .map_err(|error| error.to_string())?;
            if &buffer[..part.len()] != part {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn signature_rejection(error: &tauri_plugin_updater::Error) -> bool {
        matches!(
            error,
            tauri_plugin_updater::Error::Minisign(_)
                | tauri_plugin_updater::Error::SignedVersionMismatch { .. }
                | tauri_plugin_updater::Error::MissingSignedVersion
        )
    }

    fn rejected_result(
        stage: &str,
        error: &tauri_plugin_updater::Error,
        path: &Path,
        old: &[u8],
        old_version: &str,
        new_version: &str,
    ) -> Result<Value, String> {
        if !signature_rejection(error) {
            return Err(format!(
                "Tampered QA failed for a non-signature reason at {stage}: {error}"
            ));
        }
        if !file_matches(path, old)? {
            return Err("The rejected update changed the installed QA AppImage.".into());
        }
        Ok(json!({
            "currentVersion":old_version, "version":new_version, "mode":"tampered",
            "tamperedRejected":true, "stage":stage, "installed":false,
            "oldBytesPreserved":true, "error":error.to_string()
        }))
    }

    pub async fn run() -> Result<Value, String> {
        let args = arguments()?;
        let endpoint = loopback_url(&args.endpoint)?;
        let installed = validated_appimage(&args.appimage)?;
        let old = fs::read(&installed).map_err(|error| error.to_string())?;
        let old_permissions = installed
            .metadata()
            .map_err(|error| error.to_string())?
            .permissions()
            .mode();
        let provided: Value =
            serde_json::from_slice(&fs::read(&args.config).map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())?;
        let committed: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tauri.conf.json"
        )))
        .map_err(|error| error.to_string())?;
        if committed.get("version").and_then(Value::as_str) != Some(args.new_version.as_str()) {
            return Err(
                "The expected new version must match committed release configuration.".into(),
            );
        }
        let mut updater_config = provided
            .pointer("/plugins/updater")
            .cloned()
            .ok_or("The QA config must include plugins.updater.")?;
        let expected_key = committed
            .pointer("/plugins/updater/pubkey")
            .and_then(Value::as_str)
            .filter(|key| !key.is_empty())
            .ok_or("The committed updater public key is missing.")?;
        if updater_config.get("pubkey").and_then(Value::as_str) != Some(expected_key)
            || updater_config
                .get("requireSignedVersion")
                .and_then(Value::as_bool)
                != Some(true)
            || updater_config
                .get("allowDowngrades")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        {
            return Err("QA must retain the real committed public key, required signed versions, and downgrade protection.".into());
        }
        updater_config["dangerousInsecureTransportProtocol"] = json!(true);
        updater_config["dangerousAcceptInvalidCerts"] = json!(false);
        updater_config["dangerousAcceptInvalidHostnames"] = json!(false);
        updater_config["endpoints"] = json!([args.endpoint]);
        // Deserialize exactly the plugin's Config before creating any runtime.
        let _: tauri_plugin_updater::Config =
            serde_json::from_value(updater_config.clone()).map_err(|error| error.to_string())?;
        let mut context: tauri::Context<MockRuntime> = mock_context(noop_assets());
        context.package_info_mut().version = args
            .old_version
            .parse()
            .map_err(|_| "Invalid old application version.")?;
        context.config_mut().identifier = "com.eternalleague.linuxupdaterqa".into();
        context
            .config_mut()
            .plugins
            .0
            .insert("updater".into(), updater_config);
        let app = mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .map_err(|error| error.to_string())?;
        let updater = app
            .updater_builder()
            .executable_path(&installed)
            .no_proxy()
            .timeout(Duration::from_secs(180))
            .endpoints(vec![endpoint.clone()])
            .map_err(|error| error.to_string())?
            .build()
            .map_err(|error| error.to_string())?;
        // Leave target selection at its native default. Supplying linux-x86_64
        // here would append the architecture twice when matching platforms.
        let update = updater
            .check()
            .await
            .map_err(|error| error.to_string())?
            .ok_or("Expected a signed upgrade for the old application version.")?;
        if update.current_version != args.old_version || update.version != args.new_version {
            return Err("The manifest/current version differs from the fixed QA upgrade.".into());
        }
        let download = loopback_url(update.download_url.as_str())?;
        if download.origin() != endpoint.origin() {
            return Err("The payload must use the same loopback origin as the manifest.".into());
        }
        let bytes = match update.download(|_, _| {}, || {}).await {
            Ok(bytes) => bytes,
            Err(error) if args.mode == "tampered" => {
                return rejected_result(
                    "download",
                    &error,
                    &installed,
                    &old,
                    &args.old_version,
                    &args.new_version,
                )
            }
            Err(error) => return Err(format!("Signed updater download failed: {error}")),
        };
        if bytes.len() as u64 > MAX_APPIMAGE_BYTES {
            return Err("The downloaded QA payload exceeds 512 MiB.".into());
        }
        if args.mode == "tampered" {
            // Install verifies the same server-supplied bytes independently.
            // Never manufacture a successful tamper test by changing them here.
            return match update.install(&bytes) {
                Err(error) => rejected_result(
                    "install",
                    &error,
                    &installed,
                    &old,
                    &args.old_version,
                    &args.new_version,
                ),
                Ok(()) => Err("SECURITY FAILURE: the tampered AppImage was installed.".into()),
            };
        }
        update
            .install(&bytes)
            .map_err(|error| format!("Signed native AppImage install failed: {error}"))?;
        if !file_matches(&installed, &bytes)? || file_matches(&installed, &old)? {
            return Err(
                "The installed QA file does not exactly match the new signed AppImage.".into(),
            );
        }
        let new_permissions = installed
            .metadata()
            .map_err(|error| error.to_string())?
            .permissions()
            .mode();
        if old_permissions & 0o777 != new_permissions & 0o777 {
            return Err("The AppImage install changed its executable permissions.".into());
        }
        // Do not execute or relaunch either AppImage. The orchestrator owns
        // independent artifact hashing, data snapshots, and app launch checks.
        Ok(json!({
            "currentVersion":args.old_version, "version":args.new_version, "mode":"good",
            "installed":true, "newBytesMatch":true, "permissionsPreserved":true,
            "installedBytes":bytes.len(), "target":update.target
        }))
    }
}

fn main() {
    #[cfg(target_os = "linux")]
    match tauri::async_runtime::block_on(linux::run()) {
        Ok(result) => println!("{result}"),
        Err(error) => {
            println!("{}", serde_json::json!({"ok":false,"error":error}));
            std::process::exit(1);
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        eprintln!("This isolated updater probe runs only on Linux.");
        std::process::exit(2);
    }
}
