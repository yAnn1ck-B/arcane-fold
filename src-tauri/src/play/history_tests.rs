use super::tests::{choose, practice_engine, zone};
use super::{seat_view, Scenario, Seat};

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_history_conceals_cards_exiled_face_down_by_pyxis() {
    let mut game = practice_engine(
        Scenario::Deck,
        Some("[Main]\n5 Forest\n5 Pyxis of Pandemonium\n"),
    );
    choose(&mut game, "Keep hand");
    choose(&mut game, "Play Forest");
    choose(&mut game, "Cast Pyxis of Pandemonium");
    choose(&mut game, "{T}: Each player exiles");
    for seat in ["player", "opponent"] {
        assert_eq!(zone(&game, seat, "exile")[0]["faceDown"], true);
        assert_eq!(zone(&game, seat, "exile")[0]["name"], "Face-down card");
    }
    let handoff = game.manual_position(&false.into()).unwrap();
    for player in handoff["match"]["players"].as_array().unwrap() {
        let exile = player["zones"]["exile"][0].as_str().unwrap();
        let card = &handoff["match"]["pieces"][exile];
        assert!(card["printing"].is_string());
        assert_eq!(card["faceDownVisibleTo"], serde_json::json!([]));
    }
    let history = &game.current["history"];
    let changes: Vec<_> = history
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["text"].as_str().unwrap())
        .filter(|text| text.ends_with("library to exile."))
        .collect();
    assert_eq!(changes.len(), 2);
    assert!(changes
        .iter()
        .all(|message| message.starts_with("A card moved from ")));
    // The solo controller can subsequently discard a different Island at cleanup.
    let rows = history.as_array().unwrap();
    let resolved = rows
        .iter()
        .position(|row| row["text"] == "The ability of Pyxis of Pandemonium resolved.")
        .unwrap();
    assert!(rows[..=resolved]
        .iter()
        .all(|row| !row["text"].as_str().unwrap().contains("Island")));
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_history_records_public_actions_and_keeps_search_choices_private() {
    let mut game = practice_engine(Scenario::Library, None);
    choose(&mut game, "Cast Bushwhack");
    choose(&mut game, "Search your library");
    let search = game.current["history"].clone();
    assert!(search.to_string().contains("searched a library"));
    assert!(!search.to_string().contains("Mountain"));
    assert!(!search.to_string().contains("Giant Growth"));
    choose(&mut game, "Choose Mountain");
    choose(&mut game, "Pass priority");
    choose(&mut game, "Attack Player 2 with Mild-Mannered Librarian");
    choose(&mut game, "Confirm attackers");
    choose(&mut game, "No blocks");
    let history = &game.current["history"];
    assert_eq!(
        seat_view(&game.current, Seat::Player).unwrap()["history"],
        *history
    );
    assert_eq!(
        seat_view(&game.current, Seat::Opponent).unwrap()["history"],
        *history
    );
    let rows = history.as_array().unwrap();
    assert!(rows.starts_with(search.as_array().unwrap()));
    let messages: Vec<_> = rows
        .iter()
        .map(|row| row["text"].as_str().unwrap())
        .collect();
    let mut remaining = messages.iter();
    for expected in [
        "Player 1 cast Bushwhack.",
        "Player 1 searched a library.",
        "Bushwhack resolved.",
        "Player 1 passed priority.",
        "Player 1 attacked Player 2 with Mild-Mannered Librarian.",
        "Player 2 left Mild-Mannered Librarian unblocked.",
        "Mild-Mannered Librarian dealt 1 damage to Player 2.",
        "Player 2 went from 20 to 19 life.",
        "Exercise complete",
    ] {
        assert!(
            remaining.any(|&message| message == expected),
            "{expected:?} in {messages:?}"
        );
    }
    assert!(!history.to_string().contains("Giant Growth"));
}
