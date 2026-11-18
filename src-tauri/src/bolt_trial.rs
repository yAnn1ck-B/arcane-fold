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

mod replay;
use replay::{GameSetup, PracticeGame};

#[cfg(test)]
mod ability_tests;
#[cfg(test)]
mod discard_tests;
#[cfg(test)]
mod foundations_tests;
#[cfg(test)]
mod graveyard_tests;
#[cfg(test)]
mod history_tests;
#[cfg(test)]
mod library_tests;
#[cfg(test)]
mod lifegain_combo_tests;
#[cfg(test)]
mod trigger_combo_tests;
#[cfg(test)]
mod variable_combo_tests;

const SOURCE: &str = concat!(
    include_str!("../resources/playtest/ForgeBoltTrial.java"),
    "\n",
    include_str!("../resources/playtest/ForgePractice.java"),
    "\n",
    include_str!("../resources/playtest/PracticeReplay.java"),
    "\n",
    include_str!("../resources/playtest/PracticeCombat.java"),
    "\n",
    include_str!("../resources/playtest/PracticeLibrary.java"),
    "\n",
    include_str!("../resources/playtest/PracticeHistory.java"),
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
    Growth,
    Library,
    Deck,
}

impl Scenario {
    fn argument(self) -> &'static str {
        match self {
            Self::Bolt => "bolt",
            Self::Response => "response",
            Self::Combat => "combat",
            Self::Growth => "growth",
            Self::Library => "library",
            Self::Deck => "deck",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Seat {
    #[default]
    Player,
    Opponent,
}

impl Seat {
    fn id(self) -> &'static str {
        match self {
            Self::Player => "player",
            Self::Opponent => "opponent",
        }
    }

    fn other(self) -> Self {
        match self {
            Self::Player => Self::Opponent,
            Self::Opponent => Self::Player,
        }
    }
}

fn seat_view(snapshot: &Value, viewer: Seat) -> Result<Value, String> {
    let shared = snapshot["sharedSeats"] == true;
    if !shared && viewer != Seat::Player {
        return Err("This practice has one playable seat.".into());
    }
    let mut view = snapshot.clone();
    if let Some(fields) = view.as_object_mut() {
        fields.remove("replayState");
    }
    if view.get("players").is_some() {
        view["players"][viewer.other().id()]["hand"] = Value::Array(Vec::new());
    }
    if shared && snapshot["actor"] != viewer.id() {
        let fields = view.as_object_mut().expect("shared practice snapshot");
        fields.remove("librarySearch");
        fields.remove("revealedToYou");
        view["choices"] = Value::Array(Vec::new());
        if snapshot["stage"] == "decision" {
            let name = if viewer == Seat::Player {
                "Player 2"
            } else {
                "Player 1"
            };
            view["prompt"] = format!("{name} has a decision.").into();
        }
    }
    Ok(view)
}

struct Engine {
    child: Child,
    replies: Receiver<String>,
    scratch: TempDir,
    current: Value,
}

impl Engine {
    #[cfg(test)]
    fn launch(
        install: &Path,
        scenario: Scenario,
        deck: Option<&str>,
        opponent: Option<&str>,
    ) -> Result<Self, String> {
        Self::launch_seeded(install, scenario, deck, opponent, rand::random())
    }

    fn launch_seeded(
        install: &Path,
        scenario: Scenario,
        deck: Option<&str>,
        opponent: Option<&str>,
        seed: i64,
    ) -> Result<Self, String> {
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
            if let Some(opponent) = opponent {
                fs::write(dir.join("opponent.dck"), opponent)
                    .map_err(|e| format!("Cannot prepare Player 2's deck: {e}"))?;
            }
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
            .arg(seed.to_string())
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
    ) -> Result<&Value, String> {
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
                    let mut state: Value =
                        serde_json::from_str(line.trim_start_matches("BOLT_STATE "))
                            .map_err(|e| format!("Forge returned an invalid trial view: {e}"))?;
                    // Java's Map.of does not guarantee field order between JVMs.
                    state.sort_all_objects();
                    self.current = state;
                    return Ok(&self.current);
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

#[derive(Default)]
enum Table {
    #[default]
    Closed,
    Playing(Engine),
    Finished(Value),
}

impl Table {
    fn snapshot(&self) -> Result<&Value, String> {
        match self {
            Self::Playing(engine) => Ok(&engine.current),
            Self::Finished(snapshot) => Ok(snapshot),
            Self::Closed => Err(CLOSED.into()),
        }
    }

    fn view(&self, viewer: Seat) -> Result<Value, String> {
        seat_view(self.snapshot()?, viewer)
    }

    fn act(&mut self, viewer: Seat, action: &str, cancelled: &AtomicBool) -> Result<Value, String> {
        let Self::Playing(engine) = self else {
            return Err(CLOSED.into());
        };
        let snapshot = &engine.current;
        let can_act = if snapshot["sharedSeats"] == true {
            snapshot["actor"] == viewer.id()
        } else {
            viewer == Seat::Player
        };
        if !can_act || !offered_action(snapshot, action) {
            return Err("That choice is no longer available to this player.".into());
        }
        match engine.next_state(Some(action), cancelled) {
            Ok(snapshot) => {
                let view = seat_view(snapshot, viewer)?;
                if matches!(snapshot["stage"].as_str(), Some("resolved" | "finished")) {
                    *self = Self::Finished(std::mem::take(&mut engine.current));
                }
                Ok(view)
            }
            Err(error) => {
                *self = Self::Closed;
                Err(error)
            }
        }
    }
}

struct Session {
    id: String,
    cancelled: AtomicBool,
    table: Mutex<Option<PracticeGame>>,
}

#[derive(Default)]
pub struct Trials(Mutex<Option<Arc<Session>>>);

impl Trials {
    fn start(&self, id: String) -> Arc<Session> {
        let session = Arc::new(Session {
            id,
            cancelled: false.into(),
            table: Mutex::default(),
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
    opponent_deck_id: Option<String>,
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
        let (deck, opponent) = if scenario == Scenario::Deck {
            let id = deck_id
                .as_deref()
                .ok_or("Select a saved deck to practice.")?;
            let deck = crate::decks::load_pool(&pool, id).await?;
            let opponent = match opponent_deck_id.as_deref() {
                Some(other) if other == id => Some(deck.clone()),
                Some(other) => Some(crate::decks::load_pool(&pool, other).await?),
                None => None,
            };
            (Some(deck), opponent)
        } else {
            (None, None)
        };
        tauri::async_runtime::spawn_blocking(move || {
            if session.cancelled.load(Ordering::Acquire) {
                return Err(CLOSED.into());
            }
            let snapshot = deck
                .as_ref()
                .map(|deck| crate::decks::practice_snapshot(deck, &install))
                .transpose()?;
            let opponent = opponent
                .as_ref()
                .map(|deck| crate::decks::practice_snapshot(deck, &install))
                .transpose()?;
            let setup = GameSetup::new(install, scenario, snapshot, opponent);
            let table = PracticeGame::start(setup, &session.cancelled)?;
            let state = table.view(Seat::Player)?;
            *session.table.lock().unwrap() = Some(table);
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
    viewer: Option<Seat>,
    revision: Option<u64>,
) -> Result<Value, String> {
    let session = trials.get(&session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        session.table.lock().unwrap().as_mut().ok_or(CLOSED)?.act(
            viewer.unwrap_or_default(),
            &action,
            revision,
            &session.cancelled,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn undo_forge_action(
    trials: State<'_, Trials>,
    session_id: String,
    viewer: Seat,
    revision: u64,
) -> Result<Value, String> {
    let session = trials.get(&session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        session.table.lock().unwrap().as_mut().ok_or(CLOSED)?.undo(
            viewer,
            revision,
            &session.cancelled,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn view_forge_seat(
    trials: State<'_, Trials>,
    session_id: String,
    viewer: Seat,
) -> Result<Value, String> {
    let session = trials.get(&session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        session
            .table
            .lock()
            .unwrap()
            .as_ref()
            .ok_or(CLOSED)?
            .view(viewer)
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
    fn seat_views_preserve_the_pending_decision_and_hide_private_information() {
        let snapshot = json!({
            "stage": "decision", "sharedSeats": true, "turn": 2,
            "active": "opponent", "actor": "player", "prompt": "Search for a card",
            "players": {
                "player": { "hand": ["Forest"], "handCount": 1 },
                "opponent": { "hand": ["Mountain"], "handCount": 1 }
            },
            "choices": [{ "id": "p3_0" }],
            "librarySearch": { "cards": ["Island"] }, "revealedToYou": ["Plains"]
        });
        let first = seat_view(&snapshot, Seat::Player).unwrap();
        assert_eq!(first["players"]["opponent"]["hand"], json!([]));
        assert_eq!(first["players"]["player"]["hand"], json!(["Forest"]));
        assert_eq!(first["librarySearch"], snapshot["librarySearch"]);
        assert_eq!(first["revealedToYou"], snapshot["revealedToYou"]);
        let other = seat_view(&snapshot, Seat::Opponent).unwrap();
        assert_eq!(other["players"]["player"]["hand"], json!([]));
        assert_eq!(other["players"]["player"]["handCount"], 1);
        assert_eq!(other["players"]["opponent"]["hand"], json!(["Mountain"]));
        assert_eq!(other["choices"], json!([]));
        assert_eq!(other["prompt"], "Player 1 has a decision.");
        assert!(other.get("librarySearch").is_none());
        assert!(other.get("revealedToYou").is_none());
        assert_eq!(other["actor"], "player");
        assert_eq!(other["active"], "opponent");
        assert_eq!(seat_view(&snapshot, Seat::Player).unwrap(), first);
        assert!(offered_action(&first, "p3_0"));

        let legacy = json!({ "stage": "opponentPriority" });
        assert_eq!(seat_view(&legacy, Seat::Player).unwrap(), legacy);
        assert!(seat_view(&legacy, Seat::Opponent).is_err());
        let mut solo = snapshot;
        solo["sharedSeats"] = false.into();
        assert!(seat_view(&solo, Seat::Opponent).is_err());
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
            let mut engine = Engine::launch(&install, Scenario::Bolt, None, None).unwrap();
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

    pub(super) fn practice_engine(scenario: Scenario, deck: Option<&str>) -> Engine {
        let mut engine = Engine::launch(&forge_install(), scenario, deck, None).unwrap();
        engine.next_state(None, &AtomicBool::new(false)).unwrap();
        engine
    }

    pub(super) fn forge_install() -> PathBuf {
        std::env::var_os("FORGE_BOLT_TEST_INSTALL")
            .map(PathBuf::from)
            .expect("Set FORGE_BOLT_TEST_INSTALL to the Forge 2.0.13 folder")
    }

    pub(super) fn seeded_deck(deck: &str, opponent: Option<&str>, seed: i64) -> Engine {
        let mut engine =
            Engine::launch_seeded(&forge_install(), Scenario::Deck, Some(deck), opponent, seed)
                .unwrap();
        engine.next_state(None, &AtomicBool::new(false)).unwrap();
        engine
    }

    pub(super) fn play_until(game: &mut Engine, prefix: &str, setup: &[&str]) {
        for _ in 0..100 {
            let choices = game.current["choices"].as_array().unwrap();
            let offers = |prefix: &str| {
                choices
                    .iter()
                    .any(|option| option["label"].as_str().unwrap().starts_with(prefix))
            };
            if offers(prefix) {
                return;
            }
            let next = setup
                .iter()
                .copied()
                .find(|label| offers(label))
                .unwrap_or_else(|| {
                    panic!("Expected {prefix} or a setup action in {}", game.current)
                });
            choose(game, next);
        }
        panic!("Never reached {prefix}");
    }

    pub(super) fn choose(engine: &mut Engine, label: &str) {
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

    pub(super) fn zone<'a>(engine: &'a Engine, who: &str, name: &str) -> &'a Vec<Value> {
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
            choose(&mut engine, "Target Player 2");
            assert_eq!(engine.current["players"]["opponent"]["life"], 20);
            assert_eq!(engine.current["stack"][0]["name"], "Lightning Bolt");
            if counter {
                choose(&mut engine, "Cast Counterspell");
                choose(&mut engine, "Target Lightning Bolt");
                assert_eq!(engine.current["stage"], "finished");
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
            choose(&mut engine, "Attack Player 2 with Grizzly Bears");
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
        assert_eq!(engine.current["turn"], 1);
        assert_eq!(engine.current["phase"], "Precombat main phase");
        choose(&mut engine, "Cast Llanowar Elves");
        // No player can respond or otherwise act until the next untap and draw.
        assert_eq!(engine.current["turn"], 3);
        assert_eq!(engine.current["phase"], "Precombat main phase");
        assert!(zone(&engine, "player", "battlefield")
            .iter()
            .any(|c| c["name"] == "Llanowar Elves"));
        assert_eq!(zone(&engine, "player", "hand").len(), 5);
        assert!(zone(&engine, "player", "battlefield")
            .iter()
            .any(|c| c["name"] == "Forest" && c["tapped"] == false));
    }

    #[test]
    #[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
    fn real_forge_saved_decks_change_seats_and_offer_both_main_phases() {
        let mut engine = Engine::launch(
            &forge_install(),
            Scenario::Deck,
            Some("[Main]\n8 Forest\n"),
            Some("[Main]\n8 Mountain\n"),
        )
        .unwrap();
        let cancelled = AtomicBool::new(false);
        engine.next_state(None, &cancelled).unwrap();
        let mut table = Table::Playing(engine);
        let first = table.view(Seat::Player).unwrap();
        assert_eq!(
            first["players"]["player"]["hand"].as_array().unwrap().len(),
            7
        );
        assert_eq!(first["players"]["opponent"]["hand"], json!([]));
        let other = table.view(Seat::Opponent).unwrap();
        assert_eq!(other["choices"], json!([]));
        assert_eq!(other["players"]["player"]["hand"], json!([]));
        assert_eq!(other["players"]["opponent"]["hand"][0]["name"], "Mountain");
        let keep = first["choices"][0]["id"].as_str().unwrap();
        assert!(table.act(Seat::Opponent, keep, &cancelled).is_err());
        assert_eq!(table.view(Seat::Player).unwrap(), first);

        let play = |table: &mut Table, viewer: Seat, label: &str| {
            let view = table.view(viewer).unwrap();
            let id = view["choices"]
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["label"] == label)
                .unwrap()["id"]
                .as_str()
                .unwrap();
            table.act(viewer, id, &cancelled).unwrap()
        };
        let waiting = play(&mut table, Seat::Player, "Keep hand");
        assert_eq!(waiting["actor"], "opponent");
        assert_eq!(waiting["choices"], json!([]));
        assert_eq!(waiting["players"]["opponent"]["hand"], json!([]));
        assert!(table.act(Seat::Opponent, keep, &cancelled).is_err());
        let waiting = play(&mut table, Seat::Opponent, "Keep hand");
        assert_eq!(waiting["phase"], "Precombat main phase");
        assert_eq!(
            play(&mut table, Seat::Player, "Pass priority")["phase"],
            "Postcombat main phase"
        );
        let next_turn = play(&mut table, Seat::Player, "Play Forest");
        assert_eq!(next_turn["turn"], 2);
        assert_eq!(next_turn["actor"], "opponent");
        assert_eq!(next_turn["active"], "opponent");
        let next_turn = play(&mut table, Seat::Opponent, "Play Mountain");
        assert_eq!(next_turn["turn"], 3);
        assert_eq!(next_turn["actor"], "player");
        assert_eq!(
            next_turn["players"]["player"]["battlefield"][0]["name"],
            "Forest"
        );
        assert_eq!(
            next_turn["players"]["opponent"]["battlefield"][0]["name"],
            "Mountain"
        );

        let end = play(&mut table, Seat::Player, "Play Forest");
        assert_eq!(end["stage"], "finished");
        assert!(matches!(table, Table::Finished(_)));
        let end_other = table.view(Seat::Opponent).unwrap();
        assert_eq!(end_other["prompt"], end["prompt"]);
        assert_eq!(end_other["players"]["player"]["hand"], json!([]));
        assert_eq!(
            end_other["players"]["opponent"]["hand"][0]["name"],
            "Mountain"
        );
        assert_eq!(table.view(Seat::Player).unwrap(), end);
    }

    #[test]
    #[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
    fn real_forge_player_one_can_respond_during_player_twos_turn() {
        let mut engine = Engine::launch(
            &forge_install(),
            Scenario::Deck,
            Some("[Main]\n5 Mountain\n5 Lightning Bolt\n"),
            Some("[Main]\n10 Forest\n"),
        )
        .unwrap();
        engine.next_state(None, &AtomicBool::new(false)).unwrap();
        choose(&mut engine, "Keep hand");
        choose(&mut engine, "Keep hand");
        choose(&mut engine, "Play Mountain");
        for _ in 0..16 {
            if engine.current["active"] == "opponent" {
                break;
            }
            choose(&mut engine, "Pass priority");
        }
        assert_eq!(engine.current["turn"], 2);
        assert_eq!(engine.current["active"], "opponent");
        assert_eq!(engine.current["actor"], "player");
        let mut table = Table::Playing(engine);
        let player = table.view(Seat::Player).unwrap();
        let bolt_id = player["choices"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["label"] == "Cast Lightning Bolt")
            .unwrap()["id"]
            .as_str()
            .unwrap();
        let observer = table.view(Seat::Opponent).unwrap();
        assert_eq!(observer["players"]["opponent"]["hand"][0]["name"], "Forest");
        assert_eq!(observer["choices"], json!([]));
        assert!(table
            .act(Seat::Opponent, bolt_id, &AtomicBool::new(false))
            .is_err());
        assert_eq!(table.view(Seat::Player).unwrap(), player);
        let targets = table
            .act(Seat::Player, bolt_id, &AtomicBool::new(false))
            .unwrap();
        assert_eq!(targets["prompt"], "Choose a target for Lightning Bolt");
        assert_eq!(targets["active"], "opponent");
    }

    #[test]
    #[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
    fn real_forge_a_targeted_mana_creature_can_pay_for_its_spell() {
        for spell in ["Bite Down", "Giant Growth"] {
            let deck = format!("[Main]\n3 Forest\n3 Llanowar Elves\n2 {spell}\n");
            let mut engine = Engine::launch(
                &forge_install(),
                Scenario::Deck,
                Some(&deck),
                Some("[Main]\n4 Forest\n4 Llanowar Elves\n"),
            )
            .unwrap();
            engine.next_state(None, &AtomicBool::new(false)).unwrap();
            for action in [
                "Keep hand",
                "Keep hand",
                "Play Forest",
                "Cast Llanowar Elves",
                "Play Forest",
                "Cast Llanowar Elves",
            ] {
                choose(&mut engine, action);
            }
            assert_eq!(engine.current["step"], "Upkeep step");
            let elf_id = zone(&engine, "player", "battlefield")
                .iter()
                .find(|c| c["name"] == "Llanowar Elves")
                .unwrap()["id"]
                .clone();
            if spell == "Giant Growth" {
                // Tap Forest for another Elf. The first Elf is the only remaining mana source.
                choose(&mut engine, "Pass priority");
                assert_eq!(engine.current["step"], "Draw step");
                choose(&mut engine, "Pass priority");
                choose(&mut engine, "Cast Llanowar Elves");
            }
            choose(&mut engine, &format!("Cast {spell}"));
            let own_target = engine.current["choices"]
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["cardId"] == elf_id)
                .unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned();
            engine
                .next_state(Some(&own_target), &AtomicBool::new(false))
                .unwrap();
            if spell == "Bite Down" {
                choose(&mut engine, "Target Llanowar Elves");
                assert_eq!(
                    zone(&engine, "opponent", "graveyard")[0]["name"],
                    "Llanowar Elves"
                );
            }
            let elf = zone(&engine, "player", "battlefield")
                .iter()
                .find(|c| c["id"] == elf_id)
                .unwrap();
            assert_eq!(elf["tapped"], true);
            assert_eq!(elf["power"], if spell == "Giant Growth" { 4 } else { 1 });
            assert_eq!(zone(&engine, "player", "graveyard")[0]["name"], spell);
        }
    }

    #[test]
    #[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
    fn real_forge_giant_growth_after_blockers_or_pass() {
        for pump in [false, true] {
            let mut engine = practice_engine(Scenario::Growth, None);
            assert_eq!(engine.current["step"], "Declare attackers step");
            choose(&mut engine, "Attack Player 2 with Grizzly Bears");
            choose(&mut engine, "Confirm attackers");
            choose(&mut engine, "Pass priority");
            assert_eq!(engine.current["step"], "Declare blockers step");
            assert_eq!(engine.current["actor"], "opponent");
            choose(&mut engine, "Block Grizzly Bears with Runeclaw Bear");
            choose(&mut engine, "Confirm blockers");
            assert_eq!(engine.current["actor"], "player");
            assert_eq!(engine.current["step"], "Declare blockers step");
            if pump {
                choose(&mut engine, "Cast Giant Growth");
                choose(&mut engine, "Target Grizzly Bears");
            } else {
                choose(&mut engine, "Pass priority");
            }
            assert_eq!(engine.current["stage"], "finished");
            assert_eq!(
                zone(&engine, "opponent", "graveyard")[0]["name"],
                "Runeclaw Bear"
            );
            assert_eq!(engine.current["players"]["opponent"]["life"], 20);
            if pump {
                let bear = zone(&engine, "player", "battlefield")
                    .iter()
                    .find(|c| c["name"] == "Grizzly Bears")
                    .unwrap();
                assert_eq!(bear["power"], 5);
                assert_eq!(bear["toughness"], 5);
                assert_eq!(bear["damage"], 2);
                assert_eq!(
                    zone(&engine, "player", "graveyard")[0]["name"],
                    "Giant Growth"
                );
            } else {
                assert_eq!(
                    zone(&engine, "player", "graveyard")[0]["name"],
                    "Grizzly Bears"
                );
            }
        }
    }

    #[test]
    #[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
    fn real_forge_librarian_pays_mana_changes_type_adds_counters_and_draws() {
        let mut engine = practice_engine(Scenario::Library, None);
        let hand_count = zone(&engine, "player", "hand").len();
        let library_count = engine.current["players"]["player"]["libraryCount"]
            .as_u64()
            .unwrap();
        choose(&mut engine, "{3}{G}: Mild-Mannered Librarian");
        let field = zone(&engine, "player", "battlefield");
        assert_eq!(
            field
                .iter()
                .filter(|c| c["name"] == "Forest" && c["tapped"] == true)
                .count(),
            4
        );
        let card = field
            .iter()
            .find(|c| c["name"] == "Mild-Mannered Librarian")
            .unwrap();
        assert!(card["typeLine"].as_str().unwrap().contains("Werewolf"));
        assert_eq!(card["counters"]["+1/+1"], 2);
        assert_eq!(card["power"], 3);
        assert_eq!(zone(&engine, "player", "hand").len(), hand_count + 1);
        assert_eq!(
            engine.current["players"]["player"]["libraryCount"],
            library_count - 1
        );
    }

    #[test]
    #[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
    fn real_forge_librarians_once_limit_survives_untapping() {
        let mut engine = practice_engine(
            Scenario::Deck,
            Some("[Main]\n8 Forest\n8 Mild-Mannered Librarian\n"),
        );
        choose(&mut engine, "Keep hand");
        let mut used_on_turn = None;
        for _ in 0..180 {
            let choices = engine.current["choices"].as_array().unwrap();
            let has = |prefix: &str| {
                choices
                    .iter()
                    .any(|c| c["label"].as_str().unwrap().starts_with(prefix))
            };
            let field = zone(&engine, "player", "battlefield");
            let turn = engine.current["turn"].as_u64().unwrap();
            let activated = "{3}{G}: Mild-Mannered Librarian";
            if let Some(previous) = used_on_turn {
                if turn > previous
                    && field
                        .iter()
                        .filter(|c| c["name"] == "Forest" && c["tapped"] == false)
                        .count()
                        >= 4
                {
                    assert!(
                        !has(activated),
                        "The same permanent regained its once-only ability"
                    );
                    return;
                }
            }
            let action = if has("Play Forest") {
                "Play Forest"
            } else if !field.iter().any(|c| c["name"] == "Mild-Mannered Librarian")
                && has("Cast Mild-Mannered Librarian")
            {
                "Cast Mild-Mannered Librarian"
            } else if used_on_turn.is_none() && has(activated) {
                used_on_turn = Some(turn);
                activated
            } else if has("No attacks") {
                "No attacks"
            } else if has("Discard") {
                if has("Discard Mild-Mannered Librarian") {
                    "Discard Mild-Mannered Librarian"
                } else {
                    "Discard Forest"
                }
            } else {
                "Pass priority"
            };
            choose(&mut engine, action);
        }
        panic!("No later untap after using the Librarian's ability");
    }
}
