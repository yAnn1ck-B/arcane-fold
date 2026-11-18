use super::tests::{choose, forge_install, play_until, zone};
use super::{seat_view, Engine, Scenario, Seat};
use std::sync::atomic::AtomicBool;

fn cast_in_duel(card: &str, opponent: &str) -> Engine {
    let deck = format!("[Main]\n6 Swamp\n5 {card}\n");
    let mut game = Engine::launch_seeded(
        &forge_install(),
        Scenario::Deck,
        Some(&deck),
        Some(opponent),
        19,
    )
    .unwrap();
    game.next_state(None, &AtomicBool::new(false)).unwrap();
    let cast = format!("Cast {card}");
    play_until(
        &mut game,
        &cast,
        &[
            "Keep hand",
            "Play Swamp",
            "Play Forest",
            "Cast Llanowar Elves",
            "No attacks",
            "Pass priority",
            "Discard",
        ],
    );
    choose(&mut game, &cast);
    game
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_foundations_burglar_rat_gives_the_discard_to_the_affected_seat() {
    let mut game = cast_in_duel("Burglar Rat", "[Main]\n5 Forest\n5 Mountain\n");
    play_until(&mut game, "Discard Mountain", &["Pass priority"]);
    assert_eq!(game.current["actor"], "opponent");
    assert!(game.current["prompt"]
        .as_str()
        .unwrap()
        .contains("Burglar Rat"));
    let player = seat_view(&game.current, Seat::Player).unwrap();
    assert!(player["choices"].as_array().unwrap().is_empty());
    assert!(player["players"]["opponent"]["hand"]
        .as_array()
        .unwrap()
        .is_empty());
    let before = zone(&game, "opponent", "hand").len();
    choose(&mut game, "Discard Mountain");
    assert!(zone(&game, "opponent", "graveyard")
        .iter()
        .any(|card| card["name"] == "Mountain"));
    assert!(zone(&game, "opponent", "hand").len() <= before); // A following draw step can already have occurred.
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_foundations_duress_reveals_the_hand_and_only_offers_legal_discards() {
    let mut game = cast_in_duel(
        "Duress",
        "[Main]\n4 Forest\n3 Llanowar Elves\n4 Giant Growth\n",
    );
    choose(&mut game, "Target Player 2");
    play_until(&mut game, "Discard Giant Growth", &["Pass priority"]);
    assert_eq!(game.current["actor"], "player");
    let actor = seat_view(&game.current, Seat::Player).unwrap();
    let shown = actor["librarySearch"]["cards"].as_array().unwrap();
    assert_eq!(actor["librarySearch"]["operation"], "Revealed hand");
    assert_eq!(shown.len(), zone(&game, "opponent", "hand").len());
    assert!(shown.iter().any(|card| card["name"] == "Forest"));
    assert!(shown.iter().any(|card| card["name"] == "Llanowar Elves"));
    assert!(actor["choices"]
        .as_array()
        .unwrap()
        .iter()
        .all(|choice| choice["label"] == "Discard Giant Growth"));
    let observer = seat_view(&game.current, Seat::Opponent).unwrap();
    assert!(observer.get("librarySearch").is_none());
    assert!(observer["choices"].as_array().unwrap().is_empty());
    assert!(!observer["history"].to_string().contains("Giant Growth"));
    choose(&mut game, "Discard Giant Growth");
    assert!(game.current.get("librarySearch").is_none());
    assert!(zone(&game, "opponent", "graveyard")
        .iter()
        .any(|card| card["name"] == "Giant Growth"));
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_foundations_tribute_to_hunger_sacrifices_the_selected_creature() {
    let mut game = cast_in_duel("Tribute to Hunger", "[Main]\n6 Forest\n6 Llanowar Elves\n");
    choose(&mut game, "Target Player 2");
    play_until(&mut game, "Sacrifice Llanowar Elves", &["Pass priority"]);
    assert_eq!(game.current["actor"], "opponent");
    let choices = game.current["choices"].as_array().unwrap();
    assert!(
        choices.len() >= 2
            && choices
                .iter()
                .all(|choice| choice["label"] == "Sacrifice Llanowar Elves")
    );
    let selected = choices[1]["cardId"].clone();
    let command = choices[1]["id"].as_str().unwrap().to_owned();
    game.next_state(Some(&command), &AtomicBool::new(false))
        .unwrap();
    assert!(zone(&game, "opponent", "graveyard")
        .iter()
        .any(|card| card["id"] == selected));
    assert!(!zone(&game, "opponent", "battlefield")
        .iter()
        .any(|card| card["id"] == selected));
    assert_eq!(game.current["players"]["player"]["life"], 21);
}
