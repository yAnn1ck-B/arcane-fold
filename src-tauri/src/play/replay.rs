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

pub(super) type PendingStops = [Option<String>; 2];

pub(super) fn action_with_stops(action: &str, stops: &PendingStops) -> String {
    if stops.iter().all(Option::is_none) {
        return action.into();
    }
    format!(
        "PRIORITY {} {} {action}",
        stops[0].as_deref().unwrap_or("="),
        stops[1].as_deref().unwrap_or("=")
    )
}

// Retain the settings in force when the move resumed Forge. One-shot stops
// can create extra decisions during replay even when the game state is identical.
struct Move {
    action: String,
    before: [u8; 32],
    stops: PendingStops,
}

fn fingerprint(snapshot: &Value) -> [u8; 32] {
    let mut digest = Sha256::new();
    serde_json::to_writer(&mut digest, snapshot).expect("writing a JSON value to a digest");
    digest.finalize().into()
}

pub(super) struct LiveGame {
    setup: GameSetup,
    table: Table,
    moves: Vec<Move>,
    revision: u64,
    pending_stops: PendingStops,
}

impl LiveGame {
    pub(super) fn start(setup: GameSetup, cancelled: &AtomicBool) -> Result<Self, String> {
        let table = Table::Playing(setup.open(cancelled)?);
        Ok(Self {
            setup,
            table,
            moves: Vec::new(),
            revision: 0,
            pending_stops: Default::default(),
        })
    }

    fn annotate(&self, mut view: Value, viewer: Seat) -> Value {
        view["revision"] = self.revision.into();
        view["canUndo"] = (!self.moves.is_empty()).into();
        if let Some(stop) = &self.pending_stops[viewer.index()] {
            view["priorityStop"] = stop.as_str().into();
        }
        view
    }

    pub(super) fn view(&self, viewer: Seat) -> Result<Value, String> {
        Ok(self.annotate(self.table.view(viewer)?, viewer))
    }

    pub(super) fn set_priority_stop(
        &mut self,
        viewer: Seat,
        revision: u64,
        stop: String,
    ) -> Result<Value, String> {
        self.check_revision(revision)?;
        if !matches!(
            stop.as_str(),
            "auto"
                | "next"
                | "full"
                | "upkeep"
                | "draw"
                | "precombatMain"
                | "beginCombat"
                | "afterAttackers"
                | "afterBlockers"
                | "firstStrikeDamage"
                | "combatDamage"
                | "endCombat"
                | "postcombatMain"
                | "endStep"
        ) {
            return Err("Unknown priority stop.".into());
        }
        let current = self.table.view(viewer)?;
        if current["stage"] != "decision" || !current["priorityStop"].is_string() {
            return Err("Priority stops are available during an active game.".into());
        }
        self.pending_stops[viewer.index()] = Some(stop);
        // The table is still suspended on the very same decision. The other seat's
        // outstanding action remains valid and will carry both players' latest settings.
        Ok(self.annotate(current, viewer))
    }

    fn check_revision(&self, revision: u64) -> Result<(), String> {
        if revision != self.revision {
            return Err("The table has already moved to a different decision.".into());
        }
        Ok(())
    }

    pub(super) fn manual_position(
        &mut self,
        revision: u64,
        cancelled: &AtomicBool,
    ) -> Result<Value, String> {
        self.check_revision(revision)?;
        match &mut self.table {
            Table::Playing(engine) => engine.manual_position(cancelled),
            _ => Err("Only an active Forge match can switch to manual play.".into()),
        }
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
        let view = self
            .table
            .act(viewer, action, &self.pending_stops, cancelled)?;
        self.moves.push(Move {
            action: action.to_owned(),
            before,
            stops: std::mem::take(&mut self.pending_stops),
        });
        self.revision += 1;
        Ok(self.annotate(view, viewer))
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
            engine.next_state(
                Some(&action_with_stops(&step.action, &step.stops)),
                cancelled,
            )?;
        }
        verify_decision(&engine.current, last)?;
        let replacement = Table::Playing(engine);
        let view = replacement.view(viewer)?;
        self.table = replacement;
        self.pending_stops = last.stops.clone();
        self.moves.pop();
        self.revision += 1;
        Ok(self.annotate(view, viewer))
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
    use crate::play::tests::forge_install;
    use serde_json::json;

    #[test]
    #[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
    fn real_forge_automatic_and_full_control_offer_the_same_nonmana_decisions() {
        let scripts: &[(&str, &[&str])] = &[
            (
                "priority-counter",
                &[
                    "Cast Savannah Lions",
                    "Cast Essence Scatter",
                    "Target Savannah Lions",
                    "Play Forest",
                ],
            ),
            (
                "priority-upkeep",
                &[
                    "Cast Burst Lightning",
                    "Target Player 2",
                    "Cast Negate",
                    "Target Burst Lightning",
                    "Play Forest",
                ],
            ),
        ];
        for &(scenario, script) in scripts {
            let trace = |full: bool| {
                let cancel = AtomicBool::new(false);
                let setup = GameSetup {
                    seed: 2401,
                    ..GameSetup::new(forge_install(), Scenario::Position(scenario), None, None)
                };
                let mut game = LiveGame::start(setup, &cancel).unwrap();
                if full {
                    for seat in [Seat::Player, Seat::Opponent] {
                        game.set_priority_stop(seat, game.revision, "full".into())
                            .unwrap();
                    }
                }
                let mut windows = Vec::new();
                let mut empty_windows = 0;
                let mut remaining = script.iter().copied().peekable();
                for _ in 0..100 {
                    let state = raw(&game);
                    let actor = if state["actor"] == "player" {
                        Seat::Player
                    } else {
                        Seat::Opponent
                    };
                    let choices = state["choices"].as_array().unwrap();
                    // In these fixed positions the only activated abilities are basic land mana abilities.
                    let actions: Vec<_> = choices
                        .iter()
                        .filter(|c| c["kind"] != "pass" && c["kind"] != "ability")
                        .map(|c| c["label"].as_str().unwrap())
                        .collect();
                    if actions.is_empty() {
                        empty_windows += 1;
                    } else {
                        let stack: Vec<_> = state["stack"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|c| &c["name"])
                            .collect();
                        windows.push(json!([
                            state["turn"],
                            state["phase"],
                            state["step"],
                            state["actor"],
                            stack,
                            actions
                        ]));
                    }
                    let next = *remaining.peek().unwrap();
                    if actions.contains(&next) {
                        remaining.next();
                        if remaining.peek().is_none() {
                            return (windows, empty_windows, state["players"].clone());
                        }
                        play(&mut game, actor, next);
                    } else {
                        play(&mut game, actor, "Pass priority");
                    }
                }
                panic!("Did not reach the final decision in {scenario}");
            };
            let (automatic, auto_empty, auto_players) = trace(false);
            let (full, full_empty, full_players) = trace(true);
            assert_eq!(auto_empty, 0, "{scenario}");
            assert!(
                full_empty > 0,
                "{scenario} should exercise an automatic pass"
            );
            assert_eq!(automatic, full, "Different response windows in {scenario}");
            assert_eq!(
                auto_players, full_players,
                "Different outcome in {scenario}"
            );
        }
    }

    fn raw(game: &LiveGame) -> Value {
        game.table.snapshot().unwrap().clone()
    }

    fn play(game: &mut LiveGame, viewer: Seat, label: &str) -> Value {
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
    #[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
    fn real_forge_end_turn_preserves_combat_responses_stops_and_undo() {
        let cancel = AtomicBool::new(false);
        let start = |scenario| {
            let setup = GameSetup::new(forge_install(), Scenario::Position(scenario), None, None);
            LiveGame::start(setup, &cancel).unwrap()
        };
        let end_id = |game: &LiveGame| {
            raw(game)["choices"]
                .as_array()
                .unwrap()
                .iter()
                .find_map(|c| c["endTurnId"].as_str().map(str::to_owned))
        };
        let mut game = start("priority-counter");
        let end = end_id(&game).unwrap();
        let before = raw(&game);
        let next = game.act(Seat::Player, &end, Some(0), &cancel).unwrap();
        assert_eq!(next["turn"], 2);
        assert_eq!(next["active"], "opponent");
        let after_end = raw(&game);
        play(&mut game, Seat::Opponent, "Play Island");
        game.undo(Seat::Opponent, game.revision, &cancel).unwrap();
        assert_eq!(after_end, raw(&game));
        game.undo(Seat::Player, game.revision, &cancel).unwrap();
        assert_eq!(before, raw(&game));

        game.set_priority_stop(Seat::Player, game.revision, "beginCombat".into())
            .unwrap();
        assert!(game
            .act(Seat::Player, &end, Some(game.revision), &cancel)
            .is_err());
        play(&mut game, Seat::Player, "Pass priority");
        assert_eq!(raw(&game)["step"], "Beginning of combat step");
        assert!(
            end_id(&game).is_none(),
            "consumed one-shot stop is still explicit"
        );
        game.set_priority_stop(Seat::Player, game.revision, "full".into())
            .unwrap();
        while raw(&game)["phase"] != "Ending phase" {
            assert_eq!(raw(&game)["turn"], 1);
            assert!(end_id(&game).is_none());
            play(&mut game, Seat::Player, "Pass priority");
        }
        let end = end_id(&game).unwrap();
        game.act(Seat::Player, &end, Some(game.revision), &cancel)
            .unwrap();
        assert_eq!(raw(&game)["turn"], 2);

        let mut combat = start("board-damage");
        let end = end_id(&combat).unwrap();
        combat.act(Seat::Player, &end, Some(0), &cancel).unwrap();
        assert_eq!(raw(&combat)["prompt"], "Declare attackers");
        assert!(end_id(&combat).is_none());

        let mut response = start("priority-yield");
        while raw(&response)["phase"] != "Precombat main phase" {
            play(&mut response, Seat::Opponent, "Pass priority");
        }
        let end = end_id(&response).unwrap();
        response
            .act(Seat::Player, &end, Some(response.revision), &cancel)
            .unwrap();
        assert_eq!(raw(&response)["actor"], "opponent");
        assert!(end_id(&response).is_none());
        play(&mut response, Seat::Opponent, "Cast Opt");
        assert_eq!(raw(&response)["actor"], "player");
        assert_eq!(raw(&response)["stack"][0]["name"], "Opt");
        assert!(end_id(&response).is_none());
        play(&mut response, Seat::Player, "Cast Negate");
        play(&mut response, Seat::Player, "Target Opt");
    }

    #[test]
    #[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
    fn real_forge_priority_stops_are_private_apply_to_either_seat_and_replay() {
        let cancel = AtomicBool::new(false);
        let deck = "[Main]\n20 Island\n".to_string();
        let setup = GameSetup::new(
            forge_install(),
            Scenario::Deck,
            Some(deck.clone()),
            Some(deck),
        );
        let mut game = LiveGame::start(setup, &cancel).unwrap();
        let first = game
            .set_priority_stop(Seat::Player, 0, "beginCombat".into())
            .unwrap();
        assert_eq!(first["canUndo"], false);
        let other = game
            .set_priority_stop(Seat::Opponent, 0, "next".into())
            .unwrap();
        assert_eq!(other["priorityStop"], "next");
        assert_eq!(other["choices"], json!([]));
        assert!(other.get("priorityStops").is_none());
        assert_eq!(
            game.view(Seat::Player).unwrap()["priorityStop"],
            "beginCombat"
        );
        play(&mut game, Seat::Player, "Keep hand");
        play(&mut game, Seat::Opponent, "Mulligan");
        let manual = game.manual_position(game.revision, &cancel).unwrap();
        let players = &manual["match"]["players"];
        assert_eq!(players[0]["kept"], true);
        assert_eq!(players[0]["mulligans"], 0);
        assert_eq!(players[1]["kept"], false);
        assert_eq!(players[1]["mulligans"], 1);
        play(&mut game, Seat::Opponent, "Keep hand");
        let upkeep = play(&mut game, Seat::Opponent, "Bottom Island");
        assert_eq!(upkeep["actor"], "opponent");
        assert_eq!(upkeep["step"], "Upkeep step");
        assert_eq!(upkeep["priorityStop"], "auto");
        assert_eq!(upkeep["choices"].as_array().unwrap().len(), 1);
        assert_eq!(upkeep["choices"][0]["label"], "Pass priority");
        assert!(game
            .set_priority_stop(Seat::Opponent, 0, "full".into())
            .is_err());
        play(&mut game, Seat::Opponent, "Pass priority");
        let main = play(&mut game, Seat::Player, "Play Island");
        assert_eq!(main["priorityStop"], "beginCombat");
        assert!(main["choices"].as_array().unwrap().iter().any(|choice| choice["manaAbility"] == true));
        let combat = play(&mut game, Seat::Player, "Pass priority");
        assert_eq!(combat["step"], "Beginning of combat step");
        assert_eq!(combat["priorityStop"], "auto");
        assert_eq!(combat["prompt"], "At your stop — choose a play or continue");
        let mana = combat["choices"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["kind"] == "ability")
            .unwrap();
        let tapped = play(&mut game, Seat::Player, mana["label"].as_str().unwrap());
        assert_eq!(tapped["step"], combat["step"]);
        assert_eq!(tapped["players"]["player"]["mana"], 1);
        assert_eq!(tapped["choices"][0]["label"], "Pass priority");
        let before = raw(&game);
        let revision = game.revision;
        game.set_priority_stop(Seat::Opponent, revision, "endStep".into())
            .unwrap();
        play(&mut game, Seat::Player, "Pass priority");
        let end = raw(&game);
        assert_eq!(end["actor"], "opponent");
        assert_eq!(end["step"], "End step");
        assert_eq!(end["players"]["player"]["mana"], 0);
        let waiting = game.undo(Seat::Opponent, game.revision, &cancel).unwrap();
        assert_eq!(raw(&game), before);
        assert_eq!(waiting["priorityStop"], "endStep");
        assert_eq!(waiting["choices"], json!([]));
        play(&mut game, Seat::Player, "Pass priority");
        assert_eq!(raw(&game), end);
    }

    #[test]
    #[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
    fn real_forge_named_combat_stops_distinguish_blockers_damage_and_end_of_combat() {
        let cancel = AtomicBool::new(false);
        let setup = GameSetup::new(
            forge_install(),
            Scenario::Position("board-trample"),
            None,
            None,
        );
        let mut game = LiveGame::start(setup, &cancel).unwrap();
        game.set_priority_stop(Seat::Opponent, game.revision, "afterBlockers".into())
            .unwrap();
        play(&mut game, Seat::Player, "Pass priority");
        play(
            &mut game,
            Seat::Player,
            "Attack Player 2 with Rampaging Baloths",
        );
        play(&mut game, Seat::Player, "Confirm attackers");
        let blocks = play(&mut game, Seat::Opponent, "No blocks");
        assert_eq!(blocks["actor"], "opponent");
        assert_eq!(blocks["step"], "Declare blockers step");
        assert_eq!(blocks["players"]["opponent"]["life"], 20);
        game.set_priority_stop(Seat::Opponent, game.revision, "combatDamage".into())
            .unwrap();
        let damage = play(&mut game, Seat::Opponent, "Pass priority");
        assert_eq!(damage["actor"], "opponent");
        assert_eq!(damage["step"], "Combat damage step");
        assert_eq!(damage["players"]["opponent"]["life"], 14);
        game.set_priority_stop(Seat::Player, game.revision, "endCombat".into())
            .unwrap();
        let end = play(&mut game, Seat::Opponent, "Pass priority");
        assert_eq!(end["actor"], "player");
        assert_eq!(end["step"], "End of combat step");
        assert_eq!(
            play(&mut game, Seat::Player, "Pass priority")["phase"],
            "Postcombat main phase"
        );
    }

    #[test]
    #[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
    fn real_forge_full_control_holds_after_floating_mana_and_casting_own_spell() {
        let cancel = AtomicBool::new(false);
        let setup = GameSetup::new(
            forge_install(),
            Scenario::Position("target-goggles"),
            None,
            None,
        );
        let mut game = LiveGame::start(setup, &cancel).unwrap();
        let opening = game.view(Seat::Player).unwrap();
        assert_eq!(opening["actor"], "player");
        game.set_priority_stop(Seat::Player, game.revision, "full".into())
            .unwrap();
        let mountain = opening["players"]["player"]["battlefield"]
            .as_array()
            .unwrap()
            .iter()
            .find(|card| card["name"] == "Mountain")
            .unwrap();
        let tap = opening["choices"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["kind"] == "ability" && c["cardId"] == mountain["id"])
            .unwrap();
        game.act(
            Seat::Player,
            tap["id"].as_str().unwrap(),
            Some(game.revision),
            &cancel,
        )
        .unwrap();
        assert_eq!(raw(&game)["players"]["player"]["mana"], 1);
        play(&mut game, Seat::Player, "Cast Shock");
        let casting = play(&mut game, Seat::Player, "Target Player 2");
        assert_eq!(casting["actor"], "player");
        assert_eq!(casting["priorityStop"], "full");
        assert_eq!(casting["stack"][0]["name"], "Shock");
        assert_eq!(casting["players"]["opponent"]["life"], 20);
        let goggles = casting["players"]["player"]["battlefield"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == "Pyromancer's Goggles")
            .unwrap();
        let mana = casting["choices"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["cardId"] == goggles["id"] && c["kind"] == "ability")
            .unwrap();
        game.set_priority_stop(Seat::Player, game.revision, "auto".into())
            .unwrap();
        let responding = play(&mut game, Seat::Player, mana["label"].as_str().unwrap());
        assert_eq!(responding["actor"], "opponent");
        assert_eq!(responding["players"]["player"]["mana"], 1);
        assert_eq!(responding["stack"][0]["name"], "Shock");
        let other = game.view(Seat::Opponent).unwrap();
        assert_eq!(other["priorityStop"], "auto");
        assert!(other["choices"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["label"] == "Cast Burst Lightning"));
        play(&mut game, Seat::Opponent, "Pass priority");
        assert_eq!(raw(&game)["players"]["opponent"]["life"], 18);
    }

    #[test]
    #[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
    fn real_forge_manual_handoff_reads_hidden_zones_without_advancing_the_match() {
        let cancel = AtomicBool::new(false);
        let mut setup = GameSetup::new(
            forge_install(),
            Scenario::Deck,
            Some("[metadata]\nName=Elves\n[Main]\n8 Forest\n8 Llanowar Elves\n".into()),
            Some("[metadata]\nName=Burn\n[Main]\n8 Mountain\n8 Lightning Bolt\n".into()),
        );
        setup.seed = 455;
        let mut game = LiveGame::start(setup, &cancel).unwrap();
        let before = raw(&game);
        let export = game.manual_position(0, &cancel).unwrap();
        assert_eq!(export, game.manual_position(0, &cancel).unwrap());
        assert_eq!(before, raw(&game));
        assert_eq!(before["history"], export["history"]);
        assert_eq!(export["match"]["pieces"].as_object().unwrap().len(), 32);
        assert_eq!(export["match"]["players"][0]["deckName"], "Elves");
        assert_eq!(export["match"]["players"][1]["deckName"], "Burn");
        for p in 0..2 {
            let player = &export["match"]["players"][p];
            assert_eq!(player["mana"], json!({"W":0,"U":0,"B":0,"R":0,"G":0,"C":0}));
            assert_eq!(player["zones"]["hand"].as_array().unwrap().len(), 7);
            assert_eq!(player["zones"]["library"].as_array().unwrap().len(), 9);
            assert_eq!(player["kept"], false);
        }
        play(&mut game, Seat::Player, "Keep hand");
        assert!(game.manual_position(0, &cancel).is_err());
        let second = game.manual_position(1, &cancel).unwrap();
        assert_eq!(second["match"]["players"][0]["kept"], true);
        assert_eq!(second["match"]["players"][1]["kept"], false);
        assert_eq!(
            second["match"]["players"][0]["zones"],
            export["match"]["players"][0]["zones"]
        );
        play(&mut game, Seat::Opponent, "Keep hand");
        let active = game.manual_position(2, &cancel).unwrap();
        assert_eq!(active["match"]["players"][1]["kept"], true);
        for _ in 0..60 {
            if raw(&game)["turn"] == 2 && raw(&game)["phase"] == "Precombat main phase" {
                break;
            }
            let actor = if raw(&game)["actor"] == "player" {
                Seat::Player
            } else {
                Seat::Opponent
            };
            play(&mut game, actor, "Pass priority");
        }
        let drawn = game.manual_position(game.revision, &cancel).unwrap();
        let original_library = active["match"]["players"][1]["zones"]["library"]
            .as_array()
            .unwrap();
        let seat_two = &drawn["match"]["players"][1];
        assert_eq!(
            seat_two["zones"]["library"].as_array().unwrap(),
            &original_library[1..]
        );
        assert!(seat_two["zones"]["hand"]
            .as_array()
            .unwrap()
            .contains(&original_library[0]));
    }

    #[test]
    #[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
    fn real_forge_manual_handoff_keeps_partial_london_bottom_order_private() {
        let cancel = AtomicBool::new(false);
        let mut game = LiveGame::start(
            GameSetup::new(
                forge_install(),
                Scenario::Deck,
                Some("[Main]\n12 Forest\n".into()),
                Some("[Main]\n12 Mountain\n".into()),
            ),
            &cancel,
        )
        .unwrap();
        let mut redraws = 0;
        for _ in 0..12 {
            let position = raw(&game);
            let actor = if position["actor"] == "player" {
                Seat::Player
            } else {
                Seat::Opponent
            };
            if position["choices"][0]["label"]
                .as_str()
                .unwrap()
                .starts_with("Bottom ")
            {
                assert_eq!(actor, Seat::Player);
                let chosen = &position["choices"][0];
                let expected = chosen["cardId"]
                    .as_str()
                    .unwrap()
                    .strip_prefix('c')
                    .unwrap();
                game.act(
                    actor,
                    chosen["id"].as_str().unwrap(),
                    Some(game.revision),
                    &cancel,
                )
                .unwrap();
                let handoff = game.manual_position(game.revision, &cancel).unwrap();
                let player = &handoff["match"]["players"][0];
                assert_eq!(player["kept"], false);
                assert_eq!(player["mulligans"], 2);
                assert_eq!(
                    player["openingBottom"],
                    json!([format!("forge-card-{expected}")])
                );
                assert_eq!(player["zones"]["hand"].as_array().unwrap().len(), 7);
                assert!(handoff["match"]["players"][1]
                    .get("openingBottom")
                    .is_none());
                return;
            }
            let label = if actor == Seat::Player && redraws < 2 {
                redraws += 1;
                "Mulligan"
            } else {
                "Keep hand"
            };
            play(&mut game, actor, label);
        }
        panic!("Forge never asked for the second London bottom card.");
    }

    #[test]
    #[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
    fn real_forge_manual_handoff_preserves_top_spell_target_and_playable_forge() {
        let cancel = AtomicBool::new(false);
        let mut game = LiveGame::start(
            GameSetup::new(forge_install(), Scenario::Bolt, None, None),
            &cancel,
        )
        .unwrap();
        for action in ["playMountain", "castBolt", "targetOpponent"] {
            game.act(Seat::Player, action, Some(game.revision), &cancel)
                .unwrap();
        }
        let export = game.manual_position(game.revision, &cancel).unwrap();
        let position = &export["match"];
        assert_eq!(position["step"], 3);
        assert_eq!(position["turn"], 1);
        assert_eq!(position["stack"].as_array().unwrap().len(), 1);
        let spell = &position["stack"][0];
        assert_eq!(spell["kind"], "spell");
        assert_eq!(spell["label"], "Lightning Bolt");
        assert_eq!(spell["targets"], "Player 2");
        let id = spell["card"].as_str().unwrap();
        let printing = position["pieces"][id]["printing"].as_str().unwrap();
        assert_eq!(position["catalog"][printing]["name"], "Lightning Bolt");
        let mountain = position["players"][0]["zones"]["battlefield"][0]
            .as_str()
            .unwrap();
        assert_eq!(position["pieces"][mountain]["tapped"], true);
        assert_eq!(position["players"][1]["life"], 20);
        assert_eq!(export["history"], raw(&game)["history"]);
        let resolved = game
            .act(Seat::Player, "passPriority", Some(3), &cancel)
            .unwrap();
        assert_eq!(resolved["opponentLife"], 17);
        assert!(game.manual_position(4, &cancel).is_err());
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
        let mut game = LiveGame::start(setup, &cancel).unwrap();
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
        let mut game = LiveGame::start(setup, &cancel).unwrap();
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
        let handoff = game.manual_position(game.revision, &cancel).unwrap();
        assert_eq!(handoff["match"]["stack"][0]["label"], "Opt");
        assert_eq!(handoff["match"]["handoffDecision"]["seat"], 0);
        assert_eq!(handoff["match"]["handoffDecision"]["text"], scry["prompt"]);
        assert_eq!(handoff["history"], scry["history"]);
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
        let mut game = LiveGame::start(
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
