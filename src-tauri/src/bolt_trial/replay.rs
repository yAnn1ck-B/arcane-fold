use super::{AtomicBool, Engine, PathBuf, Scenario, Seat, Table, Value};
use sha2::{Digest, Sha256};

pub(super) struct GameSetup {
    install: PathBuf,
    scenario: Scenario,
    deck: Option<String>,
    opponent: Option<String>,
    seed: i64,
}

impl GameSetup {
    pub(super) fn new(
        install: PathBuf,
        scenario: Scenario,
        deck: Option<String>,
        opponent: Option<String>,
    ) -> Self {
        Self {
            install,
            scenario,
            deck,
            opponent,
            seed: rand::random(),
        }
    }

    fn open(&self, cancelled: &AtomicBool) -> Result<Engine, String> {
        let mut engine = Engine::launch_seeded(
            &self.install,
            self.scenario,
            self.deck.as_deref(),
            self.opponent.as_deref(),
            self.seed,
        )?;
        engine.next_state(None, cancelled)?;
        Ok(engine)
    }
}

// Only the choice and a digest of the original decision are retained for replay.
struct Move {
    action: String,
    before: [u8; 32],
}

fn fingerprint(snapshot: &Value) -> [u8; 32] {
    let mut digest = Sha256::new();
    serde_json::to_writer(&mut digest, snapshot).expect("writing a JSON value to a digest");
    digest.finalize().into()
}

pub(super) struct PracticeGame {
    setup: GameSetup,
    table: Table,
    moves: Vec<Move>,
    revision: u64,
}

impl PracticeGame {
    pub(super) fn start(setup: GameSetup, cancelled: &AtomicBool) -> Result<Self, String> {
        let table = Table::Playing(setup.open(cancelled)?);
        Ok(Self {
            setup,
            table,
            moves: Vec::new(),
            revision: 0,
        })
    }

    fn annotate(&self, mut view: Value) -> Value {
        view["revision"] = self.revision.into();
        view["canUndo"] = (!self.moves.is_empty()).into();
        view
    }

    pub(super) fn view(&self, viewer: Seat) -> Result<Value, String> {
        Ok(self.annotate(self.table.view(viewer)?))
    }

    fn check_revision(&self, revision: u64) -> Result<(), String> {
        if revision != self.revision {
            return Err("The table has already moved to a different decision.".into());
        }
        Ok(())
    }

    pub(super) fn act(
        &mut self,
        viewer: Seat,
        action: &str,
        revision: Option<u64>,
        cancelled: &AtomicBool,
    ) -> Result<Value, String> {
        if let Some(revision) = revision {
            self.check_revision(revision)?;
        }
        let before = fingerprint(self.table.snapshot()?);
        let view = self.table.act(viewer, action, cancelled)?;
        self.moves.push(Move {
            action: action.to_owned(),
            before,
        });
        self.revision += 1;
        Ok(self.annotate(view))
    }

    pub(super) fn undo(
        &mut self,
        viewer: Seat,
        revision: u64,
        cancelled: &AtomicBool,
    ) -> Result<Value, String> {
        self.check_revision(revision)?;
        let (last, earlier) = self.moves.split_last().ok_or("There is no move to undo.")?;
        // Build a second suspended Forge controller. Keep the original (including a
        // finished result) available until every decision and the requested view match.
        let mut engine = self.setup.open(cancelled)?;
        for step in earlier {
            verify_decision(&engine.current, step)?;
            engine.next_state(Some(&step.action), cancelled)?;
        }
        verify_decision(&engine.current, last)?;
        let replacement = Table::Playing(engine);
        let view = replacement.view(viewer)?;
        self.table = replacement;
        self.moves.pop();
        self.revision += 1;
        Ok(self.annotate(view))
    }
}

fn verify_decision(snapshot: &Value, step: &Move) -> Result<(), String> {
    if fingerprint(snapshot) != step.before {
        return Err("Forge could not reproduce the earlier decision exactly. Your current game is still available.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bolt_trial::tests::forge_install;
    use serde_json::json;

    fn raw(game: &PracticeGame) -> Value {
        game.table.snapshot().unwrap().clone()
    }

    fn play(game: &mut PracticeGame, viewer: Seat, label: &str) -> Value {
        let options = game.view(viewer).unwrap();
        let id = options["choices"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["label"] == label)
            .unwrap_or_else(|| panic!("Missing choice {label}: {}", options["choices"]))["id"]
            .as_str()
            .unwrap();
        game.act(viewer, id, Some(game.revision), &AtomicBool::new(false))
            .unwrap()
    }

    #[test]
    #[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
    fn real_forge_undo_recreates_private_opening_hands_shuffles_and_seats() {
        let cancel = AtomicBool::new(false);
        let setup = GameSetup::new(
            forge_install(),
            Scenario::Deck,
            Some("[Main]\n8 Forest\n8 Llanowar Elves\n".into()),
            Some("[Main]\n8 Mountain\n8 Lightning Bolt\n".into()),
        );
        let mut game = PracticeGame::start(setup, &cancel).unwrap();
        let opening = raw(&game);
        assert_eq!(game.view(Seat::Player).unwrap()["canUndo"], false);
        assert!(game.undo(Seat::Player, 0, &cancel).is_err());
        let waiting = play(&mut game, Seat::Player, "Keep hand");
        assert_eq!(waiting["actor"], "opponent");
        assert_eq!(waiting["canUndo"], true);
        let observer = game.undo(Seat::Opponent, 1, &cancel).unwrap();
        assert_eq!(observer["revision"], 2);
        assert_eq!(observer["choices"], json!([]));
        assert_eq!(observer["players"]["player"]["hand"], json!([]));
        assert!(observer.get("replayState").is_none());
        assert_eq!(opening, raw(&game));
        assert!(game.undo(Seat::Player, 1, &cancel).is_err());

        play(&mut game, Seat::Player, "Mulligan");
        let first_redraw_decision = raw(&game);
        let actor = if first_redraw_decision["actor"] == "player" {
            Seat::Player
        } else {
            Seat::Opponent
        };
        play(&mut game, actor, "Keep hand");
        let after_keep = raw(&game);
        game.undo(actor, game.revision, &cancel).unwrap();
        assert_eq!(first_redraw_decision, raw(&game));
        play(&mut game, actor, "Keep hand");
        assert_eq!(after_keep, raw(&game));
    }

    #[test]
    #[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
    fn real_forge_undo_restores_opts_private_scry_draw_and_public_history() {
        let cancel = AtomicBool::new(false);
        let setup = GameSetup::new(
            forge_install(),
            Scenario::Deck,
            Some("[Main]\n6 Island\n6 Opt|FDN|[512]\n".into()),
            Some("[Main]\n15 Forest\n".into()),
        );
        let mut game = PracticeGame::start(setup, &cancel).unwrap();
        play(&mut game, Seat::Player, "Keep hand");
        play(&mut game, Seat::Opponent, "Keep hand");
        play(&mut game, Seat::Player, "Play Island");
        for _ in 0..20 {
            if game.table.snapshot().unwrap()["turn"] == 2 {
                break;
            }
            play(&mut game, Seat::Player, "Pass priority");
        }
        assert_eq!(game.table.snapshot().unwrap()["active"], "opponent");
        let scry = play(&mut game, Seat::Player, "Cast Opt");
        assert_eq!(scry["librarySearch"]["operation"], "Scry");
        let seen = &scry["librarySearch"]["cards"][0];
        let bottom = format!("Put {} on the bottom", seen["name"].as_str().unwrap());
        let before = raw(&game);
        let log = before["history"].as_array().unwrap();
        assert!(log
            .iter()
            .any(|entry| entry["text"] == "Player 1 cast Opt."));
        assert!(log
            .iter()
            .any(|entry| entry["text"] == "Player 1 passed priority."));
        let held = |snapshot: &Value| {
            snapshot["players"]["player"]["hand"]
                .as_array()
                .unwrap()
                .iter()
                .any(|c| c["id"] == seen["id"])
        };

        play(&mut game, Seat::Player, &bottom);
        let after_bottom = raw(&game);
        assert!(!held(&after_bottom));
        let bottom_log = after_bottom["history"].as_array().unwrap();
        assert!(bottom_log.starts_with(log) && bottom_log.len() > log.len());
        let observer = game.undo(Seat::Opponent, game.revision, &cancel).unwrap();
        assert!(observer.get("librarySearch").is_none());
        assert_eq!(observer["history"], before["history"]);
        assert_eq!(raw(&game), before);
        play(&mut game, Seat::Player, &bottom);
        assert_eq!(raw(&game), after_bottom);
        game.undo(Seat::Player, game.revision, &cancel).unwrap();
        play(&mut game, Seat::Player, "Keep remaining on top");
        let after_keep = raw(&game);
        assert!(held(&after_keep));
        assert_ne!(after_keep["history"], after_bottom["history"]);
        assert!(after_keep["history"].as_array().unwrap().starts_with(log));
    }

    #[test]
    #[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
    fn real_forge_undo_branches_from_a_finished_game_and_keeps_original_on_mismatch() {
        let cancel = AtomicBool::new(false);
        let mut game = PracticeGame::start(
            GameSetup::new(forge_install(), Scenario::Bolt, None, None),
            &cancel,
        )
        .unwrap();
        for action in ["playMountain", "castBolt", "targetOpponent", "passPriority"] {
            game.act(Seat::Player, action, Some(game.revision), &cancel)
                .unwrap();
        }
        let completed = game.view(Seat::Player).unwrap();
        assert_eq!(completed["opponentLife"], 17);
        assert!(matches!(game.table, Table::Finished(_)));
        game.moves[0].before[0] ^= 1;
        assert!(game.undo(Seat::Player, 4, &cancel).is_err());
        assert_eq!(game.view(Seat::Player).unwrap(), completed);
        game.moves[0].before[0] ^= 1;
        assert_eq!(
            game.undo(Seat::Player, 4, &cancel).unwrap()["stage"],
            "opponentPriority"
        );
        assert_eq!(
            game.undo(Seat::Player, 5, &cancel).unwrap()["stage"],
            "chooseTarget"
        );
        assert!(game
            .act(Seat::Player, "targetPlayer", Some(2), &cancel)
            .is_err());
        game.act(Seat::Player, "targetPlayer", Some(6), &cancel)
            .unwrap();
        let branched = game
            .act(Seat::Player, "passPriority", Some(7), &cancel)
            .unwrap();
        assert_eq!(branched["playerLife"], 17);
        assert_eq!(branched["opponentLife"], 20);
    }
}
