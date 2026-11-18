use super::tests::{choose, forge_install, play_until, zone};
use super::{Engine, Scenario};
use serde_json::Value;
use std::sync::atomic::AtomicBool;

fn seeded(deck: &str, opponent: Option<&str>) -> Engine {
    let mut game =
        Engine::launch_seeded(&forge_install(), Scenario::Deck, Some(deck), opponent, 19).unwrap();
    game.next_state(None, &AtomicBool::new(false)).unwrap();
    game
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_foundations_think_twice_requires_flashback_cost_and_exiles_after_drawing() {
    let mut game = seeded("[Main]\n9 Island\n5 Think Twice|FDN|[165]\n4 Opt", None);
    choose(&mut game, "Keep hand");
    choose(&mut game, "Play Island");
    choose(&mut game, "Cast Opt");
    choose(&mut game, "Keep remaining on top");
    play_until(&mut game, "Play Island", &["Pass priority"]);
    choose(&mut game, "Play Island");
    choose(&mut game, "Cast Think Twice");
    let grave = zone(&game, "player", "graveyard");
    let card_id = |name: &str| grave.iter().find(|c| c["name"] == name).unwrap()["id"].clone();
    let (think, opt) = (card_id("Think Twice"), card_id("Opt"));
    let grave_options = |game: &Engine, id: &Value| {
        game.current["choices"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["cardId"] == *id)
            .cloned()
            .collect::<Vec<_>>()
    };
    assert!(
        grave_options(&game, &think).is_empty(),
        "Two Islands cannot pay the flashback cost."
    );
    play_until(&mut game, "Play Island", &["Pass priority"]);
    choose(&mut game, "Play Island");
    assert!(
        grave_options(&game, &opt).is_empty(),
        "An ordinary graveyard instant was offered."
    );
    let options = grave_options(&game, &think);
    assert_eq!(options.len(), 1);
    assert_eq!(
        options[0]["label"],
        "Flashback Think Twice from graveyard ({2}{U})"
    );
    let hand_before = zone(&game, "player", "hand").len();
    choose(&mut game, "Flashback Think Twice");
    assert_eq!(zone(&game, "player", "hand").len(), hand_before + 1);
    assert!(zone(&game, "player", "exile")
        .iter()
        .any(|c| c["id"] == think));
    assert!(zone(&game, "player", "graveyard")
        .iter()
        .any(|c| c["id"] == opt));
    assert!(grave_options(&game, &think).is_empty());
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_foundations_reassembling_skeleton_returns_tapped_from_its_owners_graveyard() {
    let mut game = seeded(
        "[Main]\n7 Swamp\n7 Reassembling Skeleton|FDN|[182]",
        Some("[Main]\n24 Mountain"),
    );
    let discard = "Discard Reassembling Skeleton";
    play_until(
        &mut game,
        discard,
        &["Keep hand", "Play Mountain", "Pass priority"],
    );
    choose(&mut game, discard);
    let skeleton = zone(&game, "player", "graveyard")[0]["id"].clone();
    let activation = "{1}{B}: Return Reassembling Skeleton";
    play_until(
        &mut game,
        activation,
        &["Play Mountain", "Play Swamp", "Pass priority"],
    );
    assert_eq!(game.current["actor"], "player");
    let options: Vec<_> = game.current["choices"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["cardId"] == skeleton)
        .collect();
    assert_eq!(options.len(), 1);
    assert_eq!(options[0]["kind"], "ability");
    choose(&mut game, activation);
    assert!(zone(&game, "player", "battlefield")
        .iter()
        .any(|c| c["id"] == skeleton && c["tapped"] == true));
    assert!(!zone(&game, "player", "graveyard")
        .iter()
        .any(|c| c["id"] == skeleton));
}
