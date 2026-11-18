use super::tests::{choose, play_until, seeded_deck, zone};
use super::{seat_view, Engine, Seat};
use serde_json::Value;

fn cards_named<'a>(game: &'a Engine, area: &str, name: &str) -> Vec<&'a Value> {
    zone(game, "player", area)
        .iter()
        .filter(|card| card["name"] == name)
        .collect()
}

fn tapped_forests(game: &Engine) -> usize {
    cards_named(game, "battlefield", "Forest")
        .iter()
        .filter(|c| c["tapped"] == true)
        .count()
}

fn wildborn_counters(game: &Engine) -> u64 {
    let preserver = cards_named(game, "battlefield", "Wildborn Preserver")[0];
    preserver["counters"]["+1/+1"].as_u64().unwrap_or(0)
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_wildborn_preserver_chooses_payment_on_resolution_before_the_counter_trigger() {
    // The opponent holds Unsummon, so the table stops at both response windows.
    for (payment, bounce) in [
        (None, false),
        (Some(0), false),
        (Some(1), false),
        (Some(3), false),
        (Some(1), true),
    ] {
        let mut game = seeded_deck(
            "[Main]\n12 Forest|FDN\n5 Wildborn Preserver|FDN|[650]\n5 Llanowar Elves|FDN|[227]",
            Some("[Main]\n12 Island|FDN\n8 Unsummon|FDN|[599]"),
            19,
        );
        let setup = [
            "Keep hand",
            "Play Island",
            "Pass priority",
            "No attacks",
            "Discard",
        ];
        for _ in 0..4 {
            play_until(&mut game, "Play Forest", &setup);
            choose(&mut game, "Play Forest");
        }
        choose(&mut game, "Cast Wildborn Preserver");
        // Keep the next land drop available so we can inspect the same main
        // phase after the trigger, even when every Forest has been tapped.
        play_until(&mut game, "Play Forest", &setup);
        choose(&mut game, "Cast Llanowar Elves");
        play_until(&mut game, "Cast Unsummon", &["Pass priority"]);
        assert_eq!(game.current["stack"][0]["name"], "Llanowar Elves");
        choose(&mut game, "Pass priority");
        play_until(&mut game, "Cast Unsummon", &["Pass priority"]);
        assert_eq!(game.current["stack"][0]["name"], "Wildborn Preserver");
        let original_view = seat_view(&game.current, Seat::Opponent).unwrap();
        assert!(!original_view["stack"][0]["description"]
            .as_str()
            .unwrap()
            .contains("(X ="));
        let original_trigger = game.current["stack"][0]["id"].clone();
        let preserver_id = cards_named(&game, "battlefield", "Wildborn Preserver")[0]["id"].clone();
        assert_eq!(tapped_forests(&game), 1); // Only the Elves have been paid for.
        choose(&mut game, "Pass priority");
        assert_eq!(game.current["actor"], "player");
        let mut labels: Vec<_> = game.current["choices"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["label"].as_str().unwrap())
            .collect();
        labels.sort_unstable();
        assert_eq!(labels, ["Decline", "X = 0", "X = 1", "X = 2", "X = 3"]);
        assert_eq!(tapped_forests(&game), 1);
        assert_eq!(wildborn_counters(&game), 0);

        if let Some(x) = payment {
            choose(&mut game, &format!("X = {x}"));
            play_until(&mut game, "Cast Unsummon", &["Pass priority"]);
            assert_eq!(game.current["actor"], "opponent");
            assert_eq!(game.current["stack"][0]["name"], "Wildborn Preserver");
            assert_ne!(game.current["stack"][0]["id"], original_trigger);
            let opponent = seat_view(&game.current, Seat::Opponent).unwrap();
            assert!(opponent["stack"][0]["description"]
                .as_str()
                .unwrap()
                .contains(&format!("(X = {x})")));
            assert_eq!(tapped_forests(&game), 1 + x);
            assert_eq!(wildborn_counters(&game), 0);
            if bounce {
                choose(&mut game, "Cast Unsummon");
                choose(&mut game, "Target Wildborn Preserver");
            }
            // Resolve Unsummon, if cast, then the separate "when you do" trigger.
            play_until(&mut game, "Play Forest", &["Pass priority"]);
        } else {
            choose(&mut game, "Decline");
        }
        assert!(game.current["stack"].as_array().unwrap().is_empty());
        assert_eq!(game.current["phase"], "Precombat main phase");
        assert_eq!(tapped_forests(&game), 1 + payment.unwrap_or(0));
        if bounce {
            assert!(cards_named(&game, "battlefield", "Wildborn Preserver").is_empty());
            let returned = cards_named(&game, "hand", "Wildborn Preserver");
            assert!(returned
                .iter()
                .any(|c| c["id"] == preserver_id && c.get("counters").is_none()));
        } else {
            assert_eq!(wildborn_counters(&game), payment.unwrap_or(0) as u64);
        }
    }
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
        assert_eq!(tapped_forests(&game), x + 1);
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
    assert_eq!(tapped_forests(&game), 20);
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
