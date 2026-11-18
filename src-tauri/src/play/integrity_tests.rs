use super::tests::{choose, play_until, practice_engine, zone};
use super::{seat_view, Scenario, Seat};

#[test]
#[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
fn real_forge_foundations_crawling_barrens_can_keep_its_counters_without_animating() {
    for animate in [false, true] {
        let mut game = practice_engine(Scenario::Position("integrity-barrens"), None);
        play_until(&mut game, "{4}: Put two", &["Pass priority"]);
        choose(&mut game, "{4}: Put two");
        play_until(&mut game, "Animate", &["Pass priority"]);
        choose(&mut game, if animate { "Animate" } else { "Decline" });
        play_until(&mut game, "Play Forest", &["Pass priority"]);
        let card = zone(&game, "player", "battlefield")
            .iter()
            .find(|c| c["name"] == "Crawling Barrens")
            .unwrap();
        assert_eq!(card["counters"]["+1/+1"], 2);
        assert_eq!(
            card["typeLine"].as_str().unwrap().contains("Creature"),
            animate
        );
        if animate {
            assert_eq!(card["power"], 2);
        }
    }
}

#[test]
#[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
fn real_forge_foundations_vivien_looks_privately_and_orders_the_cards_left_behind() {
    for take in [false, true] {
        let mut game = practice_engine(Scenario::Position("integrity-vivien"), None);
        play_until(&mut game, "Cast Vivien Reid", &["Pass priority"]);
        choose(&mut game, "Cast Vivien Reid");
        play_until(&mut game, "+1:", &["Pass priority"]);
        choose(&mut game, "+1:");
        play_until(&mut game, "Choose Swamp", &["Pass priority"]);
        assert_eq!(game.current["actor"], "player");
        let visible = game.current["librarySearch"]["cards"].as_array().unwrap();
        assert_eq!(visible.len(), 4);
        for name in ["Swamp", "Healer's Hawk", "Negate", "Abrade"] {
            assert!(visible.iter().any(|c| c["name"] == name));
        }
        let choices = game.current["choices"].to_string();
        assert!(choices.contains("Choose Healer's Hawk"));
        assert!(!choices.contains("Choose Negate"));
        assert!(!choices.contains("Choose Abrade"));
        let peer = seat_view(&game.current, Seat::Opponent)
            .unwrap()
            .to_string();
        assert!(!peer.contains("Negate") && !peer.contains("Abrade"));
        choose(
            &mut game,
            if take {
                "Choose Swamp"
            } else {
                "Finish selection"
            },
        );
        assert_eq!(
            game.current["librarySearch"]["operation"],
            "Order library cards"
        );
        choose(&mut game, "Place Abrade next");
        choose(&mut game, "Place Negate next");
        if !take {
            choose(&mut game, "Place Swamp next");
        }
        play_until(&mut game, "Play Forest", &["Pass priority"]);
        assert_eq!(
            zone(&game, "player", "hand")
                .iter()
                .any(|c| c["name"] == "Swamp"),
            take
        );
        let export = game.manual_position(&false.into()).unwrap();
        let table = &export["match"];
        let library = table["players"][0]["zones"]["library"].as_array().unwrap();
        let names: Vec<_> = library
            .iter()
            .map(|id| {
                let printing = table["pieces"][id.as_str().unwrap()]["printing"]
                    .as_str()
                    .unwrap();
                table["catalog"][printing]["name"].as_str().unwrap()
            })
            .collect();
        let expected = if take {
            vec!["Abrade", "Negate", "Healer's Hawk"]
        } else {
            vec!["Abrade", "Negate", "Swamp", "Healer's Hawk"]
        };
        assert!(names.ends_with(&expected), "{names:?}");
    }
}

#[test]
#[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
fn real_forge_foundations_menace_skips_a_lone_blocker_and_preserves_a_legal_pair() {
    for pair in [false, true] {
        let scenario = if pair {
            "integrity-menace-pair"
        } else {
            "integrity-menace-alone"
        };
        let mut game = practice_engine(Scenario::Position(scenario), None);
        let attack = "Attack Player 2 with Nullpriest";
        play_until(&mut game, attack, &["Pass priority"]);
        choose(&mut game, attack);
        choose(&mut game, "Confirm attackers");
        if pair {
            let block = "Block Nullpriest of Oblivion with";
            play_until(&mut game, block, &["Pass priority"]);
            choose(&mut game, &format!("{block} Grizzly Bears"));
            assert!(!game.current["choices"]
                .to_string()
                .contains("Confirm blockers"));
            choose(&mut game, &format!("{block} Runeclaw Bear"));
            choose(&mut game, "Confirm blockers");
            play_until(
                &mut game,
                "Play Forest",
                &["Pass priority", "Assign 2 to Runeclaw Bear"],
            );
            assert!(zone(&game, "opponent", "graveyard")
                .iter()
                .any(|c| c["name"] == "Runeclaw Bear"));
        } else {
            // A bogus "No blocks" question stops here before damage.
            play_until(&mut game, "Play Forest", &["Pass priority"]);
        }
        assert_eq!(
            game.current["players"]["opponent"]["life"],
            if pair { 20 } else { 18 }
        );
    }
}

#[test]
#[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
fn real_forge_foundations_loot_and_squad_rallier_still_show_an_unsuccessful_look_privately() {
    let top = ["Negate", "Abrade", "Duress", "Unsummon", "Cancel", "Opt"];
    for (scenario, activation, count) in [
        ("integrity-look-miss-loot", "{4}{G}{G}", 6),
        ("integrity-look-miss-squad", "{2}{W}:", 4),
    ] {
        let mut game = practice_engine(Scenario::Position(scenario), None);
        play_until(&mut game, activation, &["Pass priority"]);
        choose(&mut game, activation);
        // There are no eligible creatures, so the engine resolves straight through to priority.
        assert_eq!(game.current["prompt"], "Choose a play");
        assert!(game.current.get("librarySearch").is_none());
        assert_eq!(
            game.current["revealedToYou"],
            serde_json::json!(top[..count])
        );
        let peer = seat_view(&game.current, Seat::Opponent).unwrap();
        for name in top {
            assert!(!peer.to_string().contains(name));
        }
    }
}

#[test]
#[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
fn real_forge_foundations_juggernaut_skips_only_a_forced_attack_and_keeps_the_defenders_response() {
    let mut forced = practice_engine(Scenario::Position("integrity-juggernaut"), None);
    play_until(&mut forced, "Play Forest", &["Pass priority"]);
    choose(&mut forced, "Pass priority");
    // There is exactly one legal declaration; the defender's spell now has a legal target.
    play_until(&mut forced, "Cast Elspeth's Smite", &["Pass priority"]);
    assert_eq!(forced.current["actor"], "opponent");
    choose(&mut forced, "Cast Elspeth's Smite");
    choose(&mut forced, "Target Juggernaut");
    play_until(&mut forced, "Play Forest", &["Pass priority"]);
    assert!(zone(&forced, "player", "exile")
        .iter()
        .any(|c| c["name"] == "Juggernaut"));
    assert_eq!(forced.current["players"]["opponent"]["life"], 20);

    let mut walker = practice_engine(Scenario::Position("integrity-juggernaut-walker"), None);
    play_until(
        &mut walker,
        "Attack Player 2 with Juggernaut",
        &["Pass priority"],
    );
    assert!(!walker.current["choices"].to_string().contains("No attacks"));
    choose(&mut walker, "Attack Chandra, Flameshaper with Juggernaut");
    choose(&mut walker, "Confirm attackers");
    play_until(&mut walker, "Play Forest", &["Pass priority"]);
    assert_eq!(walker.current["players"]["opponent"]["life"], 20);
    let chandra = zone(&walker, "opponent", "battlefield")
        .iter()
        .find(|c| c["name"] == "Chandra, Flameshaper")
        .unwrap();
    assert_eq!(chandra["counters"]["Loyalty"], 1, "{chandra}");

    for send_lions in [false, true] {
        let mut game = practice_engine(Scenario::Position("integrity-juggernaut-companion"), None);
        play_until(
            &mut game,
            "Attack Player 2 with Juggernaut",
            &["Pass priority"],
        );
        assert!(!game.current["choices"].to_string().contains("No attacks"));
        choose(&mut game, "Attack Player 2 with Juggernaut");
        if send_lions {
            choose(&mut game, "Attack Player 2 with Savannah Lions");
        }
        choose(&mut game, "Confirm attackers");
        play_until(&mut game, "Play Forest", &["Pass priority"]);
        assert_eq!(
            game.current["players"]["opponent"]["life"],
            if send_lions { 13 } else { 15 }
        );
    }
}
