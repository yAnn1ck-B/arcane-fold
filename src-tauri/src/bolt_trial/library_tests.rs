use super::tests::{choose, practice_engine, zone};
use super::{seat_view, Engine, Scenario, Seat};

fn has_card(engine: &Engine, seat: &str, pile: &str, name: &str) -> bool {
    zone(engine, seat, pile)
        .iter()
        .any(|card| card["name"] == name)
}

fn has_search_choice(engine: &Engine, label: &str) -> bool {
    engine.current["choices"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["label"] == label)
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_bushwhack_search_can_find_a_basic_or_decline() {
    for find in [true, false] {
        let mut game = practice_engine(Scenario::Library, None);
        assert!(game.current.get("librarySearch").is_none());
        choose(&mut game, "Cast Bushwhack");
        choose(&mut game, "Search your library");
        let eligible = game.current["librarySearch"]["cards"].as_array().unwrap();
        let observer = seat_view(&game.current, Seat::Opponent).unwrap();
        assert!(observer.get("librarySearch").is_none());
        assert_eq!(observer["choices"], serde_json::json!([]));
        let names: Vec<_> = eligible
            .iter()
            .map(|c| c["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            ["Forest", "Forest", "Island", "Mountain", "Mountain"]
        );
        for card in eligible {
            assert!(game.current["choices"]
                .as_array()
                .unwrap()
                .iter()
                .any(|choice| choice["cardId"] == card["id"]));
        }
        choose(
            &mut game,
            if find {
                "Choose Mountain"
            } else {
                "Finish search"
            },
        );
        assert!(game.current.get("librarySearch").is_none());
        assert_eq!(has_card(&game, "player", "hand", "Mountain"), find);
        assert!(has_card(&game, "player", "graveyard", "Bushwhack"));
        assert_eq!(
            game.current["players"]["player"]["libraryCount"],
            if find { 5 } else { 6 }
        );
        assert!(game.current.get("revealedToYou").is_none());
        choose(&mut game, "Pass priority");
        choose(&mut game, "Attack Player 2 with Mild-Mannered Librarian");
        choose(&mut game, "Confirm attackers");
        assert_eq!(game.current["actor"], "opponent");
        let opponent_view = seat_view(&game.current, Seat::Opponent).unwrap();
        assert_eq!(
            opponent_view["players"]["player"]["hand"],
            serde_json::json!([])
        );
        let player_view = seat_view(&game.current, Seat::Player).unwrap();
        assert!(player_view.get("revealedToYou").is_none());
        assert!(game.current.get("librarySearch").is_none());
        if find {
            assert_eq!(
                opponent_view["revealedToYou"],
                serde_json::json!(["Mountain"])
            );
        } else {
            assert!(game.current.get("revealedToYou").is_none());
        }
        choose(&mut game, "No blocks");
        assert!(game.current.get("revealedToYou").is_none());
    }
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_bushwhack_can_fight_instead_of_searching() {
    let mut game = practice_engine(Scenario::Library, None);
    choose(&mut game, "Cast Bushwhack");
    choose(&mut game, "Target creature you control fights");
    assert!(has_search_choice(&game, "Target Mild-Mannered Librarian"));
    assert!(!has_search_choice(&game, "Target Runeclaw Bear"));
    choose(&mut game, "Target Mild-Mannered Librarian");
    assert!(has_search_choice(&game, "Target Runeclaw Bear"));
    assert!(!has_search_choice(&game, "Target Mild-Mannered Librarian"));
    choose(&mut game, "Target Runeclaw Bear");
    assert!(has_card(
        &game,
        "player",
        "graveyard",
        "Mild-Mannered Librarian"
    ));
    assert!(has_card(&game, "opponent", "battlefield", "Runeclaw Bear"));
    assert!(game.current.get("librarySearch").is_none());
    assert_eq!(game.current["players"]["player"]["libraryCount"], 6);
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_evolving_wilds_pays_its_sacrifice_and_finds_a_tapped_basic() {
    let mut game = practice_engine(Scenario::Library, None);
    choose(&mut game, "Play Evolving Wilds");
    choose(&mut game, "{T}, Sacrifice Evolving Wilds");
    assert!(has_card(&game, "player", "graveyard", "Evolving Wilds"));
    choose(&mut game, "Pass priority"); // The player can still activate the Librarian in response.
    assert!(game.current.get("librarySearch").is_some());
    choose(&mut game, "Choose Island");
    assert!(zone(&game, "player", "battlefield")
        .iter()
        .any(|c| c["name"] == "Island" && c["tapped"] == true));
    assert!(!has_card(&game, "player", "hand", "Island"));
    assert_eq!(game.current["players"]["player"]["libraryCount"], 5);
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_cultivate_selects_two_basics_then_assigns_their_destinations() {
    let mut game = practice_engine(Scenario::Library, None);
    choose(&mut game, "Cast Cultivate");
    choose(&mut game, "Choose Mountain");
    let remaining = game.current["librarySearch"]["cards"].as_array().unwrap();
    assert_eq!(
        remaining.iter().filter(|c| c["name"] == "Mountain").count(),
        1
    );
    assert!(has_search_choice(&game, "Finish search"));
    choose(&mut game, "Choose Forest");
    assert_eq!(
        game.current["librarySearch"]["cards"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(!has_search_choice(&game, "Finish search"));
    choose(&mut game, "Choose Mountain");
    assert!(zone(&game, "player", "battlefield")
        .iter()
        .any(|c| c["name"] == "Mountain" && c["tapped"] == true));
    assert!(has_card(&game, "player", "hand", "Forest"));
    assert_eq!(game.current["players"]["player"]["libraryCount"], 4);
}
