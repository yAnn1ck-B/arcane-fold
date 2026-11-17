//! Bounded, read-only discovery for extracted Windows Forge distributions.
//! No candidate program is executed and no directory or registry value is changed.
use std::{
    collections::{HashSet, VecDeque},
    env, fs,
    path::{Component, Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

const CACHE_TTL: Duration = Duration::from_secs(30);
const SEARCH_TIME: Duration = Duration::from_secs(2);
const COMMON_TIME: Duration = Duration::from_millis(1250);
const MAX_ENTRIES: usize = 40_000;
const MAX_DIRECTORIES: usize = 4_000;
const COMMON_ENTRIES: usize = 25_000;

struct Cache {
    key: Vec<Option<std::ffi::OsString>>,
    checked: Instant,
    resources: Vec<PathBuf>,
}
static CACHE: OnceLock<Mutex<Option<Cache>>> = OnceLock::new();

#[derive(Clone, Copy)]
struct Limits {
    entries: usize,
    directories: usize,
    duration: Duration,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            entries: MAX_ENTRIES,
            directories: MAX_DIRECTORIES,
            duration: SEARCH_TIME,
        }
    }
}
struct Budget {
    started: Instant,
    limits: Limits,
    entries: usize,
    directories: usize,
    visited: HashSet<PathBuf>,
}
impl Budget {
    fn new(limits: Limits) -> Self {
        Self {
            started: Instant::now(),
            limits,
            entries: 0,
            directories: 0,
            visited: HashSet::new(),
        }
    }
    fn available(&self, entries: usize, duration: Duration) -> bool {
        self.entries < self.limits.entries.min(entries)
            && self.directories < self.limits.directories
            && self.started.elapsed() < self.limits.duration.min(duration)
    }
}

fn plain_metadata(path: &Path) -> Option<fs::Metadata> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if metadata.file_type().is_symlink() {
        return None;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return None;
        }
    }
    Some(metadata)
}
fn local_absolute_path(path: &Path) -> bool {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return false;
    }
    #[cfg(windows)]
    {
        use std::path::Prefix;
        let Some(Component::Prefix(prefix)) = path.components().next() else {
            return false;
        };
        let letter = match prefix.kind() {
            Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => letter,
            _ => return false,
        };
        if !windows::fixed_drive(letter) {
            return false;
        }
    }
    true
}
fn safe_directory(path: &Path) -> bool {
    local_absolute_path(path)
        && path
            .ancestors()
            .all(|parent| plain_metadata(parent).is_some_and(|value| value.is_dir()))
}
fn verified_resources(installation: &Path) -> Option<PathBuf> {
    if !safe_directory(installation) {
        return None;
    }
    if !plain_metadata(&installation.join("forge.exe")).is_some_and(|value| value.is_file()) {
        return None;
    }
    let res = installation.join("res");
    if !plain_metadata(&res).is_some_and(|value| value.is_dir())
        || !plain_metadata(&res.join("editions")).is_some_and(|value| value.is_dir())
        || !plain_metadata(&res.join("cardsfolder")).is_some_and(|value| value.is_dir())
    {
        return None;
    }
    Some(res)
}
fn skipped_directory(path: &Path) -> bool {
    matches!(
        path.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_ascii_lowercase()
            .as_str(),
        "$recycle.bin"
            | "system volume information"
            | "windows"
            | "$windows.~bt"
            | "$windows.~ws"
            | ".git"
            | "node_modules"
            | "target"
            | "cache"
            | "caches"
            | ".cache"
    )
}
fn visit_key(path: &Path) -> Option<PathBuf> {
    let canonical = fs::canonicalize(path).ok()?;
    #[cfg(windows)]
    {
        Some(PathBuf::from(canonical.to_string_lossy().to_lowercase()))
    }
    #[cfg(not(windows))]
    {
        Some(canonical)
    }
}

fn scan_roots(
    roots: &[(PathBuf, usize)],
    budget: &mut Budget,
    entries: usize,
    duration: Duration,
) -> Vec<PathBuf> {
    let mut queue = VecDeque::new();
    for (root, depth) in roots {
        if safe_directory(root) {
            queue.push_back((root.clone(), *depth));
        }
    }
    while let Some((directory, depth)) = queue.pop_front() {
        if !budget.available(entries, duration) {
            break;
        }
        let Some(key) = visit_key(&directory) else {
            continue;
        };
        if !budget.visited.insert(key) {
            continue;
        }
        budget.directories += 1;
        if let Some(res) = verified_resources(&directory) {
            return vec![res];
        }
        if depth == 0 {
            continue;
        }
        let Ok(children) = fs::read_dir(&directory) else {
            continue;
        };
        let mut directories = Vec::new();
        for child in children {
            if !budget.available(entries, duration) {
                break;
            }
            budget.entries += 1;
            let Ok(child) = child else {
                continue;
            };
            let path = child.path();
            if skipped_directory(&path) {
                continue;
            }
            if plain_metadata(&path).is_some_and(|value| value.is_dir())
                && queue.len() + directories.len() < budget.limits.directories
            {
                directories.push(path);
            }
        }
        // Names resembling Forge are useful hints, never an eligibility requirement.
        directories.sort_by_key(|path| {
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();
            (!name.contains("forge"), name)
        });
        queue.extend(directories.into_iter().map(|path| (path, depth - 1)));
    }
    Vec::new()
}

fn installation_hint(value: &str) -> PathBuf {
    let value = value.trim();
    let value = if let Some(quoted) = value.strip_prefix('"') {
        quoted.split('"').next().unwrap_or_default()
    } else {
        value
    };
    let path = PathBuf::from(value);
    if path.file_name().is_some_and(|name| {
        name.eq_ignore_ascii_case("forge.exe") || name.eq_ignore_ascii_case("res")
    }) {
        path.parent().unwrap_or(&path).to_path_buf()
    } else {
        path
    }
}
#[cfg(any(windows, test))]
fn icon_installation_hint(value: &str) -> PathBuf {
    let value = value.trim();
    let path = value
        .rsplit_once(',')
        .and_then(|(path, index)| index.trim().parse::<i32>().ok().map(|_| path.trim()))
        .unwrap_or(value);
    installation_hint(path)
}

fn discover(
    hints: Vec<PathBuf>,
    common: Vec<PathBuf>,
    drives: Vec<PathBuf>,
    limits: Limits,
) -> Vec<PathBuf> {
    let mut budget = Budget::new(limits);
    let mut seen = HashSet::new();
    let mut found = Vec::new();
    for hint in hints.into_iter().take(512) {
        if budget.started.elapsed() >= limits.duration {
            break;
        }
        if let Some(res) = verified_resources(&hint) {
            if seen.insert(res.clone()) {
                found.push(res);
            }
        }
    }
    if !found.is_empty() {
        return found;
    }
    // Desktop is intentionally first: common extracted installs need no drive scan.
    for root in common {
        let found = scan_roots(&[(root, 6)], &mut budget, COMMON_ENTRIES, COMMON_TIME);
        if !found.is_empty() {
            return found;
        }
        if !budget.available(COMMON_ENTRIES, COMMON_TIME) {
            break;
        }
    }
    let drives: Vec<_> = drives.into_iter().map(|root| (root, 5)).collect();
    scan_roots(&drives, &mut budget, limits.entries, limits.duration)
}

/// Called only after conventional/hinted resource roots have been ruled out.
/// Results (including no match) are cached briefly to bound repeated UI checks.
pub(crate) fn fallback_resource_candidates() -> Vec<PathBuf> {
    if !cfg!(windows) {
        return Vec::new();
    }
    let names = [
        "FORGE_HOME",
        "FORGE_DIR",
        "PATH",
        "USERPROFILE",
        "HOME",
        "LOCALAPPDATA",
        "APPDATA",
        "OneDrive",
    ];
    let key: Vec<_> = names.iter().map(env::var_os).collect();
    let mut cache = CACHE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if let Some(value) = cache
        .as_ref()
        .filter(|value| value.key == key && value.checked.elapsed() < CACHE_TTL)
    {
        let valid: Vec<_> = value
            .resources
            .iter()
            .filter(|res| {
                res.parent()
                    .is_some_and(|install| verified_resources(install).is_some())
            })
            .cloned()
            .collect();
        if value.resources.is_empty() || !valid.is_empty() {
            return valid;
        }
    }
    let started = Instant::now();
    let mut hints: Vec<_> = ["FORGE_HOME", "FORGE_DIR"]
        .iter()
        .filter_map(env::var_os)
        .map(|value| installation_hint(&value.to_string_lossy()))
        .collect();
    if let Some(value) = env::var_os("PATH") {
        hints.extend(env::split_paths(&value).take(256));
    }
    #[cfg(windows)]
    let (registry, desktop) = windows::registry_hints(started + Duration::from_millis(250));
    #[cfg(not(windows))]
    let (registry, desktop): (Vec<PathBuf>, Vec<PathBuf>) = (Vec::new(), Vec::new());
    hints.extend(registry);
    let profile = if cfg!(windows) {
        env::var_os("USERPROFILE").or_else(|| env::var_os("HOME"))
    } else {
        env::var_os("HOME").or_else(|| env::var_os("USERPROFILE"))
    }
    .map(PathBuf::from);
    let mut common = desktop;
    if let Some(profile) = profile {
        common.extend(
            [
                "Desktop",
                "Downloads",
                "Games",
                "Apps",
                "Portable",
                "Documents",
            ]
            .iter()
            .map(|name| profile.join(name)),
        );
        common.push(profile);
    }
    if let Some(onedrive) = env::var_os("OneDrive") {
        common.insert(0, PathBuf::from(onedrive).join("Desktop"));
    }
    if let Some(local) = env::var_os("LOCALAPPDATA") {
        common.push(PathBuf::from(local).join("Programs"));
    }
    #[cfg(windows)]
    let drives = windows::fixed_drives();
    #[cfg(not(windows))]
    let drives = Vec::new();
    let remaining = SEARCH_TIME.saturating_sub(started.elapsed());
    let resources = discover(
        hints,
        common,
        drives,
        Limits {
            duration: remaining,
            ..Limits::default()
        },
    );
    *cache = Some(Cache {
        key,
        checked: Instant::now(),
        resources: resources.clone(),
    });
    resources
}

#[cfg(windows)]
mod windows {
    use super::{icon_installation_hint, installation_hint};
    use std::{ffi::c_void, path::PathBuf, ptr, time::Instant};
    type Hkey = *mut c_void;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetLogicalDrives() -> u32;
        fn GetDriveTypeW(root: *const u16) -> u32;
        fn ExpandEnvironmentStringsW(source: *const u16, destination: *mut u16, size: u32) -> u32;
    }
    #[link(name = "advapi32")]
    extern "system" {
        fn RegOpenKeyExW(
            key: Hkey,
            subkey: *const u16,
            options: u32,
            access: u32,
            result: *mut Hkey,
        ) -> i32;
        fn RegQueryValueExW(
            key: Hkey,
            name: *const u16,
            reserved: *mut u32,
            kind: *mut u32,
            data: *mut u8,
            size: *mut u32,
        ) -> i32;
        fn RegEnumKeyExW(
            key: Hkey,
            index: u32,
            name: *mut u16,
            size: *mut u32,
            reserved: *mut u32,
            class: *mut u16,
            class_size: *mut u32,
            modified: *mut c_void,
        ) -> i32;
        fn RegCloseKey(key: Hkey) -> i32;
    }
    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }
    pub(super) fn fixed_drive(letter: u8) -> bool {
        let root = [letter as u16, b':' as u16, b'\\' as u16, 0];
        unsafe { GetDriveTypeW(root.as_ptr()) == 3 }
    }
    pub(super) fn fixed_drives() -> Vec<PathBuf> {
        let mask = unsafe { GetLogicalDrives() };
        (0..26)
            .filter_map(|index| {
                let letter = b'A' + index;
                (mask & (1 << index) != 0 && fixed_drive(letter))
                    .then(|| PathBuf::from(format!("{}:\\", letter as char)))
            })
            .collect()
    }
    struct Key(Hkey);
    impl Drop for Key {
        fn drop(&mut self) {
            unsafe {
                RegCloseKey(self.0);
            }
        }
    }
    fn open(parent: Hkey, name: &str, view: u32) -> Option<Key> {
        let mut key = ptr::null_mut();
        // Query + enumerate only; no registry write access is requested.
        if unsafe {
            RegOpenKeyExW(
                parent,
                wide(name).as_ptr(),
                0,
                0x0001 | 0x0008 | view,
                &mut key,
            )
        } == 0
        {
            Some(Key(key))
        } else {
            None
        }
    }
    fn value(key: &Key, name: Option<&str>) -> Option<String> {
        let name = name.map(wide);
        let mut buffer = vec![0u16; 4096];
        let mut bytes = (buffer.len() * 2) as u32;
        let mut kind = 0;
        if unsafe {
            RegQueryValueExW(
                key.0,
                name.as_ref().map_or(ptr::null(), |name| name.as_ptr()),
                ptr::null_mut(),
                &mut kind,
                buffer.as_mut_ptr().cast(),
                &mut bytes,
            )
        } != 0
            || !matches!(kind, 1 | 2)
            || bytes % 2 != 0
            || bytes as usize > buffer.len() * 2
        {
            return None;
        }
        let words = &buffer[..bytes as usize / 2];
        let text = String::from_utf16_lossy(
            &words[..words
                .iter()
                .position(|word| *word == 0)
                .unwrap_or(words.len())],
        );
        if kind == 2 {
            let mut expanded = vec![0u16; 4096];
            let size = unsafe {
                ExpandEnvironmentStringsW(
                    wide(&text).as_ptr(),
                    expanded.as_mut_ptr(),
                    expanded.len() as u32,
                )
            } as usize;
            if size == 0 || size > expanded.len() {
                return None;
            }
            Some(String::from_utf16_lossy(&expanded[..size - 1]))
        } else {
            Some(text)
        }
    }
    pub(super) fn registry_hints(deadline: Instant) -> (Vec<PathBuf>, Vec<PathBuf>) {
        let mut hints = Vec::new();
        let mut desktop = Vec::new();
        let user = 0x8000_0001u32 as i32 as isize as Hkey;
        let machine = 0x8000_0002u32 as i32 as isize as Hkey;
        if let Some(key) = open(
            user,
            "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders",
            0,
        ) {
            if let Some(path) = value(&key, Some("Desktop")) {
                desktop.push(PathBuf::from(path));
            }
        }
        for parent in [user, machine] {
            for view in [0x0100, 0x0200] {
                if Instant::now() >= deadline {
                    return (hints, desktop);
                }
                if let Some(key) = open(
                    parent,
                    "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\forge.exe",
                    view,
                ) {
                    if let Some(path) = value(&key, None) {
                        hints.push(installation_hint(&path));
                    }
                }
                let Some(key) = open(
                    parent,
                    "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
                    view,
                ) else {
                    continue;
                };
                for index in 0..1024 {
                    if Instant::now() >= deadline {
                        return (hints, desktop);
                    }
                    let mut name = [0u16; 512];
                    let mut length = name.len() as u32;
                    let result = unsafe {
                        RegEnumKeyExW(
                            key.0,
                            index,
                            name.as_mut_ptr(),
                            &mut length,
                            ptr::null_mut(),
                            ptr::null_mut(),
                            ptr::null_mut(),
                            ptr::null_mut(),
                        )
                    };
                    if result == 259 {
                        break;
                    }
                    if result != 0 {
                        continue;
                    }
                    let Some(item) = open(
                        key.0,
                        &String::from_utf16_lossy(&name[..length as usize]),
                        view,
                    ) else {
                        continue;
                    };
                    if !value(&item, Some("DisplayName"))
                        .is_some_and(|name| name.to_lowercase().contains("forge"))
                    {
                        continue;
                    }
                    if let Some(path) = value(&item, Some("InstallLocation")) {
                        hints.push(installation_hint(&path));
                    }
                    if let Some(path) = value(&item, Some("DisplayIcon")) {
                        hints.push(icon_installation_hint(&path));
                    }
                }
            }
        }
        (hints, desktop)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn installation(path: &Path) -> PathBuf {
        fs::create_dir_all(path.join("res/editions")).unwrap();
        fs::create_dir_all(path.join("res/cardsfolder")).unwrap();
        fs::write(path.join("forge.exe"), "fixture, never executed").unwrap();
        path.join("res")
    }
    #[test]
    fn forge_discovery_finds_real_desktop_layout_and_arbitrary_nested_names() {
        let root = tempfile::tempdir().unwrap();
        let desktop = root.path().join("Desktop");
        let expected = installation(&desktop.join("forge 2.0.13"));
        assert_eq!(
            discover(Vec::new(), vec![desktop], Vec::new(), Limits::default()),
            vec![expected]
        );
        let arbitrary = installation(&root.path().join("Games/cards/Latest Build"));
        assert_eq!(
            discover(
                Vec::new(),
                vec![root.path().join("Games")],
                Vec::new(),
                Limits::default()
            ),
            vec![arbitrary]
        );
    }
    #[test]
    fn forge_discovery_rejects_impostors_missing_paths_and_linked_resources() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("forge.exe"), "fixture").unwrap();
        assert!(verified_resources(root.path()).is_none());
        assert!(discover(
            Vec::new(),
            vec![root.path().join("missing")],
            Vec::new(),
            Limits::default()
        )
        .is_empty());
        fs::create_dir_all(root.path().join("res/editions")).unwrap();
        assert!(verified_resources(root.path()).is_none());
    }
    #[test]
    fn forge_discovery_hints_win_before_broad_search() {
        let root = tempfile::tempdir().unwrap();
        let hinted = root.path().join("selected");
        let expected = installation(&hinted);
        installation(&root.path().join("Desktop/other"));
        assert_eq!(
            discover(
                vec![hinted],
                vec![root.path().join("Desktop")],
                Vec::new(),
                Limits::default()
            ),
            vec![expected]
        );
        assert_eq!(
            installation_hint(&format!(
                "\"{}\",0",
                root.path().join("selected/forge.exe").display()
            )),
            root.path().join("selected")
        );
    }
    #[test]
    fn forge_discovery_preserves_comma_paths_and_only_parses_display_icon_indexes() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("Games, Cards/My Forge");
        let expected = installation(&folder);
        let raw = folder.to_string_lossy();
        let executable = folder.join("forge.exe");
        assert_eq!(installation_hint(&raw), folder);
        assert_eq!(installation_hint(&executable.to_string_lossy()), folder);
        assert_eq!(
            installation_hint(&format!("\"{}\"", executable.display())),
            folder
        );
        for value in [
            format!("{},0", executable.display()),
            format!("  \"{}\" , -1  ", executable.display()),
            executable.to_string_lossy().into_owned(),
        ] {
            let hint = icon_installation_hint(&value);
            assert_eq!(hint, folder);
            assert_eq!(verified_resources(&hint), Some(expected.clone()));
        }
        assert_eq!(installation_hint(&raw), icon_installation_hint(&raw));
        assert_eq!(
            installation_hint("folder,not-an-index"),
            PathBuf::from("folder,not-an-index")
        );
        assert_eq!(
            icon_installation_hint("folder,not-an-index"),
            PathBuf::from("folder,not-an-index")
        );
    }

    #[test]
    fn forge_discovery_enforces_depth_entry_directory_and_time_budgets() {
        let root = tempfile::tempdir().unwrap();
        installation(&root.path().join("a/b/c"));
        let mut budget = Budget::new(Limits::default());
        assert!(scan_roots(
            &[(root.path().to_path_buf(), 1)],
            &mut budget,
            MAX_ENTRIES,
            SEARCH_TIME
        )
        .is_empty());
        let mut budget = Budget::new(Limits {
            entries: 1,
            directories: 1,
            duration: SEARCH_TIME,
        });
        assert!(scan_roots(
            &[(root.path().to_path_buf(), 6)],
            &mut budget,
            MAX_ENTRIES,
            SEARCH_TIME
        )
        .is_empty());
        assert!(budget.entries <= 1 && budget.directories <= 1);
        let mut budget = Budget::new(Limits {
            duration: Duration::ZERO,
            ..Limits::default()
        });
        assert!(scan_roots(
            &[(root.path().to_path_buf(), 6)],
            &mut budget,
            MAX_ENTRIES,
            SEARCH_TIME
        )
        .is_empty());
        assert_eq!(budget.directories, 0);
    }
    #[cfg(unix)]
    #[test]
    fn forge_discovery_skips_symlink_roots_children_and_cycles() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let actual = root.path().join("actual");
        installation(&actual);
        symlink(&actual, root.path().join("linked")).unwrap();
        symlink(root.path(), actual.join("cycle")).unwrap();
        assert!(verified_resources(&root.path().join("linked")).is_none());
        let mut budget = Budget::new(Limits::default());
        assert!(scan_roots(
            &[(root.path().join("linked"), 6)],
            &mut budget,
            MAX_ENTRIES,
            SEARCH_TIME
        )
        .is_empty());
    }
    #[cfg(windows)]
    #[test]
    fn forge_discovery_skips_windows_junctions_without_following_them() {
        use std::os::windows::fs::MetadataExt;
        use std::os::windows::process::CommandExt;
        let root = tempfile::tempdir().unwrap();
        let actual = root.path().join("actual");
        installation(&actual);
        let link = root.path().join("linked");
        let output = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(&link)
            .arg(&actual)
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_ne!(
            fs::symlink_metadata(&link).unwrap().file_attributes() & 0x400,
            0
        );
        assert!(verified_resources(&link).is_none());
        let mut budget = Budget::new(Limits::default());
        assert!(scan_roots(&[(link.clone(), 6)], &mut budget, MAX_ENTRIES, SEARCH_TIME).is_empty());
        fs::remove_dir(link).unwrap();
    }
}
