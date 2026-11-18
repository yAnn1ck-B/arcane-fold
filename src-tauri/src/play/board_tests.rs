use super::tests::{choose, play_until, practice_engine, zone};
use super::{Engine, Scenario};
use serde_json::Value;

fn block_with_both(game: &mut Engine, attacker: &str) {
    let attack = format!("Attack Player 2 with {attacker}");
    play_until(game, &attack, &["Pass priority"]);
    choose(game, &attack);
    choose(game, "Confirm attackers");
    let first = format!("Block {attacker} with Savannah Lions");
    play_until(game, &first, &["Pass priority"]);
    choose(game, &first);
    choose(game, &format!("Block {attacker} with Helpful Hunter"));
    choose(game, "Confirm blockers");
    play_until(game, "Assign 1 to", &["Pass priority"]);
    assert_eq!(game.current["actor"], "player");
}

fn permanent<'a>(game: &'a Engine, name: &str) -> &'a Value {
    zone(game, "player", "battlefield")
        .iter()
        .find(|card| card["name"] == name)
        .unwrap()
}

#[test]
#[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
fn real_forge_attacker_can_assign_damage_to_either_blocker() {
    for (kill, spare) in [
        ("Helpful Hunter", "Savannah Lions"),
        ("Savannah Lions", "Helpful Hunter"),
    ] {
        let mut game = practice_engine(Scenario::Position("board-damage"), None);
        block_with_both(&mut game, "Llanowar Elves");
        choose(&mut game, &format!("Assign 1 to {kill}"));
        play_until(&mut game, "Play Forest", &["Pass priority"]);
        assert!(zone(&game, "opponent", "graveyard")
            .iter()
            .any(|card| card["name"] == kill));
        assert!(zone(&game, "opponent", "battlefield")
            .iter()
            .any(|card| card["name"] == spare));
        assert_eq!(game.current["players"]["opponent"]["life"], 20);
    }
}

#[test]
#[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
fn real_forge_trample_requires_lethal_before_assigning_the_rest_to_the_defender() {
    let mut game = practice_engine(Scenario::Position("board-trample"), None);
    block_with_both(&mut game, "Rampaging Baloths");
    for blocker in ["Helpful Hunter", "Savannah Lions"] {
        assert!(!game.current["choices"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["label"].as_str().unwrap().ends_with("to Player 2")));
        choose(&mut game, &format!("Assign 1 to {blocker}"));
    }
    choose(&mut game, "Assign 4 to Player 2");
    play_until(&mut game, "Play Forest", &["Pass priority"]);
    assert_eq!(game.current["players"]["opponent"]["life"], 16);
    assert_eq!(zone(&game, "opponent", "graveyard").len(), 2);
}

#[test]
#[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
fn real_forge_goldvein_pick_shows_its_bearer_and_creates_a_treasure_token() {
    let mut game = practice_engine(Scenario::Position("board-gear"), None);
    play_until(&mut game, "Cast Goldvein Pick", &["Pass priority"]);
    choose(&mut game, "Cast Goldvein Pick");
    play_until(&mut game, "Equip", &["Pass priority"]);
    choose(&mut game, "Equip");
    choose(&mut game, "Target Healer's Hawk");
    play_until(
        &mut game,
        "Attack Player 2 with Healer's Hawk",
        &["Pass priority"],
    );
    assert_eq!(
        permanent(&game, "Goldvein Pick")["attachedTo"],
        permanent(&game, "Healer's Hawk")["id"]
    );
    assert_eq!(permanent(&game, "Healer's Hawk")["power"], 2);
    choose(&mut game, "Attack Player 2 with Healer's Hawk");
    choose(&mut game, "Confirm attackers");
    play_until(&mut game, "Play Forest", &["Pass priority", "No blocks"]);
    assert_eq!(permanent(&game, "Treasure Token")["token"], true);
    assert_eq!(game.current["players"]["opponent"]["life"], 18);
}

#[test]
#[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
fn real_forge_chandras_token_copy_displays_its_haste_and_sacrifice_ability() {
    let mut game = practice_engine(Scenario::Position("board-copy"), None);
    play_until(&mut game, "Cast Chandra", &["Pass priority"]);
    choose(&mut game, "Cast Chandra");
    play_until(&mut game, "+1:", &["Pass priority"]);
    choose(&mut game, "+1:");
    choose(&mut game, "Target Healer's Hawk");
    play_until(&mut game, "Attack Player 2 with", &["Pass priority"]);
    let hawks: Vec<_> = zone(&game, "player", "battlefield")
        .iter()
        .filter(|card| card["name"] == "Healer's Hawk")
        .collect();
    assert_eq!(hawks.len(), 2);
    let token = hawks.iter().find(|card| card["token"] == true).unwrap();
    let text = token["oracleText"].as_str().unwrap().to_lowercase();
    assert!(
        text.contains("haste") && text.contains("sacrifice"),
        "{text}"
    );
    assert!(game.current["choices"]
        .as_array()
        .unwrap()
        .iter()
        .any(|choice| choice["cardId"] == token["id"]));
    choose(&mut game, "No attacks");
    play_until(
        &mut game,
        "Play Island",
        &["Pass priority", "No attacks", "No blocks"],
    );
    assert_eq!(
        zone(&game, "player", "battlefield")
            .iter()
            .filter(|card| card["name"] == "Healer's Hawk")
            .count(),
        1
    );
}
