use super::tests::{choose, play_until, seeded_deck, zone};
use super::{seat_view, Engine, Seat};
use serde_json::Value;

fn cards_named<'a>(game: &'a Engine, area: &str, name: &str) -> Vec<&'a Value> {
    zone(game, "player", area)
        .iter()
        .filter(|card| card["name"] == name)
        .collect()
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_foundations_wildwood_scourge_uses_chosen_x_and_triggers_once_for_kicked_colony() {
    // Wizards' Foundations release notes: a kicked Gnarlid Colony enters with two
    // counters. Wildwood Scourge triggers once per non-Hydra receiving counters.
    let deck = "[Main]\n12 Forest|FDN\n5 Wildwood Scourge|FDN|[236]\n4 Gnarlid Colony|FDN|[224]";
    for x in [0, 2] {
        let mut game = seeded_deck(deck, None, 19);
        choose(&mut game, "Keep hand");
        for _ in 0..3 {
            play_until(&mut game, "Play Forest", &["Pass priority"]);
            choose(&mut game, "Play Forest");
        }
        // Keep the next land drop available so the engine stops for priority
        // after resolution, even when the spell tapped every mana source.
        play_until(&mut game, "Play Forest", &["Pass priority"]);
        choose(&mut game, "Cast Wildwood Scourge");
        let offered: Vec<_> = game.current["choices"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["label"].as_str().unwrap())
            .collect();
        assert_eq!(offered, ["X = 0", "X = 1", "X = 2"]);
        choose(&mut game, &format!("X = {x}"));
        let tapped = cards_named(&game, "battlefield", "Forest")
            .iter()
            .filter(|c| c["tapped"] == true)
            .count();
        assert_eq!(tapped, x + 1);
        let hydras = cards_named(&game, "battlefield", "Wildwood Scourge");
        if x == 0 {
            assert!(hydras.is_empty());
            assert_eq!(cards_named(&game, "graveyard", "Wildwood Scourge").len(), 1);
            continue;
        }
        assert_eq!(hydras.len(), 1);
        assert_eq!(hydras[0]["counters"]["+1/+1"], 2);
        choose(&mut game, "Play Forest");
        play_until(&mut game, "Play Forest", &["Pass priority", "No attacks"]);
        choose(&mut game, "Play Forest");
        choose(&mut game, "Cast Gnarlid Colony");
        choose(&mut game, "Kicker");
        let colonies = cards_named(&game, "battlefield", "Gnarlid Colony");
        assert_eq!(colonies.len(), 1);
        assert_eq!(colonies[0]["counters"]["+1/+1"], 2);
        let hydra = cards_named(&game, "battlefield", "Wildwood Scourge")[0];
        assert_eq!(hydra["counters"]["+1/+1"], 3);
        assert_eq!(hydra["power"], 3);
        assert_eq!(hydra["toughness"], 3);
    }
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_double_x_is_paid_twice_and_announced_before_essence_scatter() {
    let mut game = seeded_deck(
        "[Main]\n43 Forest|FDN\n16 Walking Ballista|AER|[181]",
        Some("[Main]\n40 Island|FDN\n20 Essence Scatter|FDN|[153]"),
        19,
    );
    for _ in 0..21 {
        play_until(
            &mut game,
            "Play Forest",
            &[
                "Keep hand",
                "Play Island",
                "Pass priority",
                "Discard Island",
                "Discard Forest",
                "Discard Essence Scatter",
                "Discard Walking Ballista",
            ],
        );
        choose(&mut game, "Play Forest");
    }
    choose(&mut game, "Cast Walking Ballista");
    choose(&mut game, "Higher X values");
    let high = game.current["choices"].clone();
    choose(&mut game, "Lower X values");
    choose(&mut game, "Higher X values");
    for options in [&high, &game.current["choices"]] {
        let labels: Vec<_> = options
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["label"].as_str().unwrap())
            .collect();
        assert_eq!(labels, ["X = 10", "Lower X values"]);
    }
    choose(&mut game, "X = 10");
    let opponent = seat_view(&game.current, Seat::Opponent).unwrap();
    assert_eq!(opponent["actor"], "opponent");
    assert_eq!(opponent["stack"][0]["name"], "Walking Ballista");
    assert_eq!(opponent["stack"][0]["description"], "X = 10");
    let ballista = &opponent["stack"][0]["id"];
    let paid = cards_named(&game, "battlefield", "Forest")
        .iter()
        .filter(|card| card["tapped"] == true)
        .count();
    assert_eq!(paid, 20);
    choose(&mut game, "Cast Essence Scatter");
    choose(&mut game, "Target Walking Ballista");
    if !game.current["stack"].as_array().unwrap().is_empty() {
        choose(&mut game, "Pass priority");
    }
    assert!(cards_named(&game, "battlefield", "Walking Ballista").is_empty());
    assert!(zone(&game, "player", "graveyard")
        .iter()
        .any(|card| card["id"] == *ballista));
    assert!(zone(&game, "opponent", "graveyard")
        .iter()
        .any(|card| card["name"] == "Essence Scatter"));
}
