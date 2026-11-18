//! Debug-only bridge to one isolated, in-memory Forge match.
use serde::Deserialize;
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

const SOURCE: &str = concat!(
    include_str!("../resources/playtest/ForgeBoltTrial.java"),
    "\n",
    include_str!("../resources/playtest/ForgePractice.java"),
    "\n",
    include_str!("../resources/playtest/PracticeCombat.java"),
);
const JAR: &str = "forge-gui-desktop-2.0.13-jar-with-dependencies.jar";
const CLOSED: &str = "This Forge trial has ended.";

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Scenario {
    #[default]
    Bolt,
    Response,
    Combat,
    Deck,
}

impl Scenario {
    fn argument(self) -> &'static str {
        match self {
            Self::Bolt => "bolt",
            Self::Response => "response",
            Self::Combat => "combat",
            Self::Deck => "deck",
        }
    }
}

struct Engine {
    child: Child,
    replies: Receiver<String>,
    scratch: TempDir,
    current: Value,
}

impl Engine {
    fn launch(install: &Path, scenario: Scenario, deck: Option<&str>) -> Result<Self, String> {
        let jar = install.join(JAR);
        if !install.is_absolute() || !jar.is_file() {
            return Err("Forge practice requires Forge Desktop 2.0.13. Select its installation folder in Settings.".into());
        }
        let scratch = tempfile::Builder::new()
            .prefix("eternal-league-bolt-")
            .tempdir()
            .map_err(|e| format!("Cannot create the trial's temporary folder: {e}"))?;
        let dir = scratch.path();
        if scenario == Scenario::Deck {
            fs::write(
                dir.join("practice.dck"),
                deck.ok_or("Select a saved deck to practice.")?,
            )
            .map_err(|e| format!("Cannot prepare the practice deck: {e}"))?;
        }
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
            .arg(scenario.argument())
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
            current: Value::Null,
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
                    let state = serde_json::from_str(line.trim_start_matches("BOLT_STATE "))
                        .map_err(|e| format!("Forge returned an invalid trial view: {e}"))?;
                    self.current = state;
                    return Ok(self.current.clone());
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

fn offered_action(state: &Value, action: &str) -> bool {
    if action.is_empty() || action.len() > 128 || action.chars().any(char::is_control) {
        return false;
    }
    if let Some(choices) = state["choices"].as_array() {
        return choices
            .iter()
            .any(|choice| choice["id"].as_str() == Some(action));
    }
    match state["stage"].as_str() {
        Some("ready") => action == "playMountain",
        Some("landPlayed") => action == "castBolt",
        Some("chooseTarget") => matches!(action, "targetPlayer" | "targetOpponent"),
        Some("opponentPriority") => action == "passPriority",
        _ => false,
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
    scenario: Option<Scenario>,
    deck_id: Option<String>,
) -> Result<Value, String> {
    let scenario = scenario.unwrap_or_default();
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
        let deck = if scenario == Scenario::Deck {
            let id = deck_id
                .as_deref()
                .ok_or("Select a saved deck to practice.")?;
            Some(crate::decks::load_pool(&pool, id).await?)
        } else {
            None
        };
        tauri::async_runtime::spawn_blocking(move || {
            if session.cancelled.load(Ordering::Acquire) {
                return Err(CLOSED.into());
            }
            let snapshot = deck
                .as_ref()
                .map(|deck| crate::decks::practice_snapshot(deck, &install))
                .transpose()?;
            let mut engine = Engine::launch(&install, scenario, snapshot.as_deref())?;
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
    let session = trials.get(&session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = session.engine.lock().unwrap();
        let engine = guard.as_mut().ok_or(CLOSED)?;
        if !offered_action(&engine.current, &action) {
            return Err("That choice is no longer available.".into());
        }
        let state = engine.next_state(Some(&action), &session.cancelled);
        if state.as_ref().map_or(true, |view| {
            matches!(view["stage"].as_str(), Some("resolved" | "finished"))
        }) {
            guard.take();
        }
        state
    })
    .await
    .map_err(|e| e.to_string())?
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
    fn practice_accepts_only_choices_from_the_current_prompt() {
        let first = json!({"choices":[{"id":"p1_0", "label":"Pass priority"}]});
        let second = json!({"choices":[{"id":"p2_0", "label":"Pass priority"}]});
        assert!(offered_action(&first, "p1_0"));
        assert!(!offered_action(&second, "p1_0"));
        assert!(!offered_action(&second, "Pass priority"));
        assert!(!offered_action(&second, "p2_0\n"));
        assert!(offered_action(&json!({"stage":"ready"}), "playMountain"));
        assert!(!offered_action(
            &json!({"stage":"resolved"}),
            "passPriority"
        ));
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
            let mut engine = Engine::launch(&install, Scenario::Bolt, None).unwrap();
            let scratch = engine.scratch.path().to_path_buf();
            let ready = engine.next_state(None, &cancelled).unwrap();
            assert_eq!(ready["stage"], "ready");
            let hand = ready["hand"].as_array().unwrap();
            assert_eq!(hand.len(), 2);
            assert!(hand.contains(&json!("Mountain")) && hand.contains(&json!("Lightning Bolt")));
            assert_eq!(ready["playerLife"], 20);
            assert_eq!(ready["opponentLife"], 20);
            assert_eq!(ready["opponentBattlefield"], json!([]));
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

    fn practice_engine(scenario: Scenario, deck: Option<&str>) -> Engine {
        let mut engine = Engine::launch(&forge_install(), scenario, deck).unwrap();
        engine.next_state(None, &AtomicBool::new(false)).unwrap();
        engine
    }

    fn forge_install() -> PathBuf {
        std::env::var_os("FORGE_BOLT_TEST_INSTALL")
            .map(PathBuf::from)
            .expect("Set FORGE_BOLT_TEST_INSTALL to the Forge 2.0.13 folder")
    }

    fn choose(engine: &mut Engine, label: &str) {
        let prefix = label.to_lowercase();
        let options = engine.current["choices"].as_array().unwrap();
        let id = options
            .iter()
            .find(|option| {
                option["label"]
                    .as_str()
                    .is_some_and(|label| label.to_lowercase().starts_with(&prefix))
            })
            .unwrap_or_else(|| panic!("Missing choice {label} in {}", engine.current))["id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(offered_action(&engine.current, &id));
        engine
            .next_state(Some(&id), &AtomicBool::new(false))
            .unwrap();
        assert!(
            !offered_action(&engine.current, &id),
            "Old choice remains active"
        );
    }

    fn zone<'a>(engine: &'a Engine, who: &str, name: &str) -> &'a Vec<Value> {
        engine.current["players"][who][name].as_array().unwrap()
    }

    fn finish_by_passing(engine: &mut Engine) {
        for _ in 0..12 {
            if engine.current["stage"] == "finished" {
                return;
            }
            choose(engine, "Pass");
        }
        panic!("Did not finish after passing priority: {}", engine.current);
    }

    #[test]
    #[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
    fn real_forge_counterspell_or_pass() {
        for counter in [false, true] {
            let mut engine = practice_engine(Scenario::Response, None);
            choose(&mut engine, "Play Mountain");
            choose(&mut engine, "Cast Lightning Bolt");
            choose(&mut engine, "Target opponent");
            assert_eq!(engine.current["players"]["opponent"]["life"], 20);
            assert_eq!(engine.current["stack"][0]["name"], "Lightning Bolt");
            if counter {
                choose(&mut engine, "Cast Counterspell");
                choose(&mut engine, "Target Lightning Bolt");
                assert_eq!(engine.current["stack"].as_array().unwrap().len(), 2);
                assert_eq!(
                    zone(&engine, "opponent", "battlefield")
                        .iter()
                        .filter(|c| c["name"] == "Island" && c["tapped"] == true)
                        .count(),
                    2
                );
            }
            finish_by_passing(&mut engine);
            assert_eq!(
                engine.current["players"]["opponent"]["life"],
                if counter { 20 } else { 17 }
            );
            assert_eq!(engine.current["players"]["player"]["life"], 20);
            assert_eq!(engine.current["stack"], json!([]));
            assert_eq!(
                zone(&engine, "player", "graveyard")[0]["name"],
                "Lightning Bolt"
            );
            assert_eq!(
                zone(&engine, "opponent", "graveyard")
                    .iter()
                    .any(|card| card["name"] == "Counterspell"),
                counter
            );
        }
    }

    #[test]
    #[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
    fn real_forge_combat_with_and_without_a_blocker() {
        for block in [true, false] {
            let mut engine = practice_engine(Scenario::Combat, None);
            choose(&mut engine, "Attack opponent with Grizzly Bears");
            choose(&mut engine, "Confirm attackers");
            if block {
                choose(&mut engine, "Block Grizzly Bears with Runeclaw Bear");
                choose(&mut engine, "Confirm blockers");
            } else {
                choose(&mut engine, "No blocks");
            }
            finish_by_passing(&mut engine);
            assert_eq!(engine.current["players"]["player"]["life"], 20);
            assert_eq!(
                engine.current["players"]["opponent"]["life"],
                if block { 20 } else { 18 }
            );
            for (seat, name) in [("player", "Grizzly Bears"), ("opponent", "Runeclaw Bear")] {
                assert!(zone(
                    &engine,
                    seat,
                    if block { "graveyard" } else { "battlefield" }
                )
                .iter()
                .any(|c| c["name"] == name));
            }
        }
    }

    #[test]
    #[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
    fn real_forge_practice_saved_deck_mulligan_cast_and_next_turn() {
        let install = forge_install();
        let snapshot = tauri::async_runtime::block_on(async {
            let pool = sqlx::sqlite::SqlitePoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await
                .unwrap();
            sqlx::raw_sql(include_str!("../migrations/001_initial.sql"))
                .execute(&pool)
                .await
                .unwrap();
            sqlx::raw_sql(include_str!("../migrations/002_catalog.sql"))
                .execute(&pool)
                .await
                .unwrap();
            sqlx::raw_sql("INSERT INTO cards(id,oracle_id,name,set_code,collector_number,rarity,metadata_json) VALUES
                ('f','forest','Forest','m10','246','common','{}'),
                ('e','elves','Llanowar Elves','m10','189','common','{}');
                INSERT INTO decks(id,name) VALUES('practice','Saved opening hand');
                INSERT INTO deck_cards(deck_id,card_id,section,quantity) VALUES
                ('practice','f','main',4),('practice','e','main',4),('practice','f','sideboard',1);")
                .execute(&pool).await.unwrap();
            let deck = crate::decks::load_pool(&pool, "practice").await.unwrap();
            let snapshot = crate::decks::practice_snapshot(&deck, &install).unwrap();
            pool.close().await;
            snapshot
        });
        assert!(snapshot.contains("4 Llanowar Elves|M10|[189]"));
        assert!(snapshot.contains("4 Forest|M10|[246]"));
        let mut engine = practice_engine(Scenario::Deck, Some(&snapshot));
        assert_eq!(zone(&engine, "player", "hand").len(), 7);
        assert_eq!(engine.current["players"]["player"]["libraryCount"], 1);
        for card in zone(&engine, "player", "hand") {
            assert_eq!(card["setCode"].as_str().unwrap().to_uppercase(), "M10");
            assert_eq!(
                card["collectorNumber"],
                if card["name"] == "Forest" {
                    "246"
                } else {
                    "189"
                }
            );
        }
        choose(&mut engine, "Mulligan");
        choose(&mut engine, "Keep hand");
        choose(&mut engine, "Bottom");
        assert_eq!(zone(&engine, "player", "hand").len(), 6);
        choose(&mut engine, "Play Forest");
        choose(&mut engine, "Cast Llanowar Elves");
        assert!(zone(&engine, "player", "battlefield")
            .iter()
            .any(|c| c["name"] == "Forest" && c["tapped"] == true));
        if !engine.current["stack"].as_array().unwrap().is_empty() {
            choose(&mut engine, "Pass");
        }
        assert!(zone(&engine, "player", "battlefield")
            .iter()
            .any(|c| c["name"] == "Llanowar Elves"));
        let first_turn = engine.current["turn"].as_i64().unwrap();
        choose(&mut engine, "Next turn");
        assert!(engine.current["turn"].as_i64().unwrap() > first_turn);
        assert_eq!(zone(&engine, "player", "hand").len(), 5);
        assert!(zone(&engine, "player", "battlefield")
            .iter()
            .any(|c| c["name"] == "Forest" && c["tapped"] == false));
    }
}
