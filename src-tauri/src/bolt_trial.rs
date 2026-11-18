//! Debug-only bridge to one isolated, in-memory Forge match.
use serde_json::Value;
use std::{
    fs::{self, File},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, State};
use tempfile::TempDir;

const SOURCE: &str = include_str!("../resources/playtest/ForgeBoltTrial.java");
const JAR: &str = "forge-gui-desktop-2.0.13-jar-with-dependencies.jar";
const CLOSED: &str = "This Forge trial has ended.";

struct Engine {
    child: Child,
    replies: Receiver<String>,
    scratch: TempDir,
}

impl Engine {
    fn launch(install: &Path) -> Result<Self, String> {
        let jar = install.join(JAR);
        if !install.is_absolute() || !jar.is_file() {
            return Err("The Lightning Bolt trial requires Forge Desktop 2.0.13. Select its installation folder in Settings.".into());
        }
        let scratch = tempfile::Builder::new()
            .prefix("eternal-league-bolt-")
            .tempdir()
            .map_err(|e| format!("Cannot create the trial's temporary folder: {e}"))?;
        let dir = scratch.path();
        let source = dir.join("ForgeBoltTrial.java");
        fs::write(&source, SOURCE).map_err(|e| format!("Cannot prepare the Forge adapter: {e}"))?;
        let stderr = File::create(dir.join("stderr.log")).map_err(|e| e.to_string())?;
        let mut command = Command::new("java");
        command
            .current_dir(dir)
            .arg("-Djava.awt.headless=true")
            .arg("-Dfile.encoding=UTF-8")
            .arg(format!("-Duser.home={}", dir.display()))
            .arg(format!("-Djava.io.tmpdir={}", dir.display()))
            .arg("-cp")
            .arg(jar)
            .arg(source)
            .arg(install)
            .arg(dir)
            .env_remove("JDK_JAVA_OPTIONS")
            .env_remove("JAVA_TOOL_OPTIONS")
            .env_remove("_JAVA_OPTIONS")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(stderr);
        for key in [
            "APPDATA",
            "LOCALAPPDATA",
            "HOME",
            "USERPROFILE",
            "TEMP",
            "TMP",
            "TMPDIR",
            "XDG_CACHE_HOME",
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
        ] {
            command.env(key, dir);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = command.spawn().map_err(|e| {
            format!("Cannot start Java for the Forge trial. Install a JDK compatible with Forge 2.0.13 (JDK 17) and put java on PATH. {e}")
        })?;
        let stdout = child.stdout.take().expect("piped stdout");
        let (send, replies) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if (line.starts_with("BOLT_STATE ") || line.starts_with("BOLT_ERROR "))
                    && send.send(line).is_err()
                {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            replies,
            scratch,
        })
    }

    fn next_state(
        &mut self,
        action: Option<&str>,
        cancelled: &AtomicBool,
    ) -> Result<Value, String> {
        if let Some(action) = action {
            let input = self.child.stdin.as_mut().ok_or(CLOSED)?;
            writeln!(input, "{action}")
                .and_then(|_| input.flush())
                .map_err(|e| format!("Forge could not receive the move: {e}"))?;
        }
        let timeout = if action.is_none() { 60 } else { 15 };
        let deadline = Instant::now() + Duration::from_secs(timeout);
        while Instant::now() < deadline {
            if cancelled.load(Ordering::Acquire) {
                return Err(CLOSED.into());
            }
            match self.replies.recv_timeout(Duration::from_millis(100)) {
                Ok(line) => {
                    if let Some(error) = line.strip_prefix("BOLT_ERROR ") {
                        return Err(format!("Forge trial: {error}"));
                    }
                    return serde_json::from_str(line.trim_start_matches("BOLT_STATE "))
                        .map_err(|e| format!("Forge returned an invalid trial view: {e}"));
                }
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => {
                    let mut detail = String::new();
                    if let Ok(file) = File::open(self.scratch.path().join("stderr.log")) {
                        let _ = file.take(1200).read_to_string(&mut detail);
                    }
                    return Err(format!("The Forge adapter exited before replying. Check that JDK 17 and Forge 2.0.13 are installed. {}", detail.trim()));
                }
            }
        }
        Err("Forge timed out waiting for the trial. Start a new trial to try again.".into())
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        // Reap before TempDir removes open files, especially on Windows.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct Session {
    id: String,
    cancelled: AtomicBool,
    engine: Mutex<Option<Engine>>,
}

#[derive(Default)]
pub struct Trials(Mutex<Option<Arc<Session>>>);

impl Trials {
    fn start(&self, id: String) -> Arc<Session> {
        let session = Arc::new(Session {
            id,
            cancelled: false.into(),
            engine: Mutex::default(),
        });
        let old = self.0.lock().unwrap().replace(Arc::clone(&session));
        if let Some(old) = old {
            old.cancelled.store(true, Ordering::Release);
        }
        session
    }

    fn get(&self, id: &str) -> Result<Arc<Session>, String> {
        self.0
            .lock()
            .unwrap()
            .as_ref()
            .filter(|s| s.id == id)
            .cloned()
            .ok_or_else(|| CLOSED.into())
    }

    pub fn close(&self, id: Option<&str>) {
        let mut active = self.0.lock().unwrap();
        if active
            .as_ref()
            .is_some_and(|s| id.is_none_or(|id| id == s.id))
        {
            let old = active.take().unwrap();
            old.cancelled.store(true, Ordering::Release);
        }
    }
}

#[tauri::command]
pub async fn start_bolt_trial(
    app: AppHandle,
    trials: State<'_, Trials>,
    session_id: String,
) -> Result<Value, String> {
    // Reserve before any await so leaving the page can also cancel a slow startup.
    let session = trials.start(session_id.clone());
    let result = async {
        let pool = crate::catalog::open_pool(&app).await?;
        let paths = crate::decks::saved_forge_paths(&pool).await?;
        let install = PathBuf::from(
            paths
                .install_dir
                .ok_or("Select your Forge installation in Settings.")?,
        );
        tauri::async_runtime::spawn_blocking(move || {
            if session.cancelled.load(Ordering::Acquire) {
                return Err(CLOSED.into());
            }
            let mut engine = Engine::launch(&install)?;
            let state = engine.next_state(None, &session.cancelled)?;
            *session.engine.lock().unwrap() = Some(engine);
            Ok(state)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    .await;
    if result.is_err() {
        trials.close(Some(&session_id));
    }
    result
}

#[tauri::command]
pub async fn act_bolt_trial(
    trials: State<'_, Trials>,
    session_id: String,
    action: String,
) -> Result<Value, String> {
    if !matches!(
        action.as_str(),
        "playMountain" | "castBolt" | "targetPlayer" | "targetOpponent" | "passPriority"
    ) {
        return Err("Unknown Forge trial action.".into());
    }
    let session = trials.get(&session_id)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut guard = session.engine.lock().unwrap();
        let engine = guard.as_mut().ok_or("Forge is still starting.")?;
        engine.next_state(Some(&action), &session.cancelled)
    })
    .await
    .map_err(|e| e.to_string())?;
    if result
        .as_ref()
        .map_or(true, |state| state["stage"] == "resolved")
    {
        trials.close(Some(&session_id));
    }
    result
}

#[tauri::command]
pub fn stop_bolt_trial(trials: State<'_, Trials>, session_id: String) {
    trials.close(Some(&session_id));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn replacing_a_session_ignores_late_actions_and_stops() {
        let trials = Trials::default();
        let first = trials.start("first".into());
        let second = trials.start("second".into());
        trials.close(Some("first"));
        assert!(first.cancelled.load(Ordering::Acquire));
        assert!(trials.get("first").is_err());
        assert!(trials.get("second").is_ok());
        trials.close(None);
        assert!(second.cancelled.load(Ordering::Acquire));
        assert!(trials.get("second").is_err());
    }

    #[test]
    #[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
    fn real_forge_bolt_trial() {
        let install = std::env::var_os("FORGE_BOLT_TEST_INSTALL")
            .map(PathBuf::from)
            .expect("Set FORGE_BOLT_TEST_INSTALL to the Forge 2.0.13 folder");
        let cancelled = AtomicBool::new(false);
        for (target, name, your_life, their_life) in [
            ("targetOpponent", "opponent", 20, 17),
            ("targetPlayer", "player", 17, 20),
        ] {
            let mut engine = Engine::launch(&install).unwrap();
            let scratch = engine.scratch.path().to_path_buf();
            let ready = engine.next_state(None, &cancelled).unwrap();
            assert_eq!(ready["stage"], "ready");
            let hand = ready["hand"].as_array().unwrap();
            assert_eq!(hand.len(), 2);
            assert!(hand.contains(&json!("Mountain")) && hand.contains(&json!("Lightning Bolt")));
            assert_eq!(ready["playerLife"], 20);
            assert_eq!(ready["opponentLife"], 20);
            let land = engine.next_state(Some("playMountain"), &cancelled).unwrap();
            assert_eq!(land["stage"], "landPlayed");
            assert_eq!(land["hand"], json!(["Lightning Bolt"]));
            assert_eq!(land["battlefield"], json!(["Mountain"]));
            assert_eq!(land["mountainTapped"], false);
            let cast = engine.next_state(Some("castBolt"), &cancelled).unwrap();
            assert_eq!(cast["stage"], "chooseTarget");
            assert_eq!(cast["legalTargets"], json!(["player", "opponent"]));
            let pending = engine.next_state(Some(target), &cancelled).unwrap();
            assert_eq!(pending["stage"], "opponentPriority");
            assert_eq!(pending["target"], name);
            assert_eq!(pending["hand"], json!([]));
            assert_eq!(pending["graveyard"], json!([]));
            assert_eq!(pending["stack"], json!(["Lightning Bolt"]));
            assert_eq!(pending["mountainTapped"], true);
            assert_eq!(pending["mana"], 0);
            assert_eq!(pending["playerLife"], 20);
            assert_eq!(pending["opponentLife"], 20);
            let resolved = engine.next_state(Some("passPriority"), &cancelled).unwrap();
            assert_eq!(resolved["stage"], "resolved");
            assert_eq!(resolved["playerLife"], your_life);
            assert_eq!(resolved["opponentLife"], their_life);
            assert_eq!(resolved["stack"], json!([]));
            assert_eq!(resolved["graveyard"], json!(["Lightning Bolt"]));
            drop(engine.child.stdin.take());
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if let Some(status) = engine.child.try_wait().unwrap() {
                    assert!(status.success());
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "JVM did not exit when the client closed"
                );
                thread::sleep(Duration::from_millis(25));
            }
            drop(engine);
            assert!(!scratch.exists());
        }
    }
}
