use super::tests::{choose, play_until, seeded_deck, zone};

const TEMPLE: &str = "Temple of Mystery";
const TATYOVA: &str = "Tatyova, Benthic Druid";

// Unsummon keeps a response available while the two land-entry triggers resolve.
fn resolve_landfall(first: &str, second: &str) -> (String, String) {
    let mut game = seeded_deck(
        "[Main]\n6 Island|FDN|[274]\n6 Forest|FDN|[280]\n4 Temple of Mystery|FDN|[702]\n4 Tatyova, Benthic Druid|FDN|[247]\n4 Unsummon|FDN|[599]",
        None,
        19,
    );
    play_until(
        &mut game,
        "Cast Tatyova",
        &["Keep hand", "Play Forest", "Play Island", "Pass priority"],
    );
    choose(&mut game, "Cast Tatyova");
    play_until(&mut game, "Play Temple of Mystery", &["Pass priority"]);
    choose(&mut game, "Play Temple of Mystery");
    assert_eq!(game.current["actor"], "player");
    assert_eq!(game.current["choices"].as_array().unwrap().len(), 2);
    let handoff = game.manual_position(&false.into()).unwrap();
    let decision = handoff["match"]["handoffDecision"]["text"].as_str().unwrap();
    assert!(decision.contains("Effects awaiting stack placement"));
    assert!(decision.contains(TEMPLE) && decision.contains(TATYOVA));
    assert_eq!(handoff["match"]["stack"], serde_json::json!([]));
    let original_hand = zone(&game, "player", "hand").clone();
    choose(&mut game, &format!("Resolve {first}"));
    let stack = game.current["stack"].as_array().unwrap();
    assert_eq!(stack.len(), 2);
    assert_eq!(stack[0]["name"], first);
    assert_eq!(stack[1]["name"], second);
    let handoff = game.manual_position(&false.into()).unwrap();
    let spells = handoff["match"]["stack"].as_array().unwrap();
    assert_eq!(spells.len(), 2);
    for (entry, expected) in spells.iter().zip([first, second]) {
        assert_eq!(entry["kind"], "ability");
        let source = entry["source"].as_str().unwrap();
        let printing = handoff["match"]["pieces"][source]["printing"].as_str().unwrap();
        assert_eq!(handoff["match"]["catalog"][printing]["name"], expected);
    }

    play_until(&mut game, "Keep remaining on top", &["Pass priority"]);
    assert_eq!(game.current["librarySearch"]["operation"], "Scry");
    let peeked = game.current["librarySearch"]["cards"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let drew_before_scry = first == TATYOVA;
    assert_eq!(
        zone(&game, "player", "hand").len(),
        original_hand.len() + usize::from(drew_before_scry)
    );
    assert_eq!(
        game.current["players"]["player"]["life"],
        20 + i32::from(drew_before_scry)
    );
    choose(&mut game, "Put ");
    if first == TEMPLE {
        assert_eq!(game.current["stack"][0]["name"], TATYOVA);
        choose(&mut game, "Pass priority");
    }
    assert_eq!(game.current["players"]["player"]["life"], 21);
    assert!(game.current["stack"].as_array().unwrap().is_empty());
    let final_hand = zone(&game, "player", "hand");
    assert_eq!(final_hand.len(), original_hand.len() + 1);
    let drawn = final_hand
        .iter()
        .find(|card| {
            !original_hand
                .iter()
                .any(|original| original["id"] == card["id"])
        })
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    (peeked, drawn)
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_foundations_tatyova_and_temple_resolve_in_either_order() {
    let (top, drawn_after_bottoming) = resolve_landfall(TEMPLE, TATYOVA);
    let (peeked_after_drawing, drawn_before_scry) = resolve_landfall(TATYOVA, TEMPLE);
    assert_ne!(drawn_after_bottoming, drawn_before_scry);
    assert_eq!(drawn_before_scry, top);
    assert_eq!(drawn_after_bottoming, peeked_after_drawing);
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_foundations_felidar_savior_accepts_zero_one_or_two_distinct_targets() {
    for count in 0..=2 {
        let mut game = seeded_deck(
            "[Main]\n9 Plains|FDN\n6 Healer's Hawk|FDN|[142]\n4 Felidar Savior|FDN|[12]",
            Some("[Main]\n9 Forest|FDN\n8 Llanowar Elves|FDN|[227]"),
            19,
        );
        let setup = [
            "Keep hand",
            "Play Plains",
            "Play Forest",
            "Cast Llanowar Elves",
            "No attacks",
            "Pass priority",
            "Discard",
        ];
        for spell in [
            "Cast Healer's Hawk",
            "Cast Healer's Hawk",
            "Cast Felidar Savior",
        ] {
            play_until(&mut game, spell, &setup);
            choose(&mut game, spell);
        }
        play_until(&mut game, "Confirm targets", &["Pass priority"]);
        assert_eq!(game.current["actor"], "player");
        assert!(zone(&game, "opponent", "battlefield")
            .iter()
            .any(|c| c["name"] == "Llanowar Elves"));
        let choices = game.current["choices"].as_array().unwrap();
        let targets: Vec<_> = choices.iter().filter(|c| c["kind"] == "target").collect();
        assert_eq!(targets.len(), 2);
        assert!(targets.iter().all(|c| c["label"] == "Target Healer's Hawk"));
        let first_id = targets[0]["cardId"].clone();
        let second_id = targets[1]["cardId"].clone();
        assert_ne!(first_id, second_id);
        if count > 0 {
            choose(&mut game, "Target Healer's Hawk");
            let remaining: Vec<_> = game.current["choices"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|c| c["kind"] == "target")
                .collect();
            assert_eq!(remaining.len(), 1);
            assert_eq!(remaining[0]["cardId"], second_id);
        }
        if count == 2 {
            choose(&mut game, "Target Healer's Hawk");
        } else {
            choose(&mut game, "Confirm targets");
        }
        assert!(game.current["stack"].as_array().unwrap().is_empty());
        let hawks: Vec<_> = zone(&game, "player", "battlefield")
            .iter()
            .filter(|c| c["name"] == "Healer's Hawk")
            .collect();
        assert_eq!(hawks.len(), 2);
        for hawk in hawks {
            let expected = i32::from(count == 2 || count == 1 && hawk["id"] == first_id);
            assert_eq!(hawk["power"], 1 + expected);
            assert_eq!(hawk["toughness"], 1 + expected);
            assert_eq!(
                hawk["counters"]["+1/+1"].as_i64().unwrap_or(0),
                i64::from(expected)
            );
        }
    }
}

// Foundations release notes: choose the Indrik's target on placement, then
// choose whether to fight on resolution if the target is still legal.
#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_foundations_indrik_targets_before_the_optional_fight() {
    for (decision, destination) in [
        ("Use ability", "graveyard"),
        ("Decline", "battlefield"),
        ("Cast Unsummon", "hand"),
    ] {
        let mut game = seeded_deck(
            "[Main]\n12 Forest|FDN\n5 Llanowar Elves|FDN|[227]\n4 Affectionate Indrik|FDN|[211]",
            Some("[Main]\n10 Island|FDN\n5 Spectral Sailor|FDN|[164]\n6 Unsummon|FDN|[599]"),
            19,
        );
        let setup = [
            "Keep hand",
            "Play Forest",
            "Play Island",
            "Cast Llanowar Elves",
            "No attacks",
            "Pass priority",
            "Discard",
        ];
        for spell in ["Cast Spectral Sailor", "Cast Affectionate Indrik"] {
            play_until(&mut game, spell, &setup);
            choose(&mut game, spell);
        }
        let target = "Target Spectral Sailor";
        play_until(&mut game, target, &["Pass priority"]);
        assert_eq!(game.current["actor"], "player");
        let choices = game.current["choices"].as_array().unwrap();
        assert_eq!(choices.len(), 1); // The target is mandatory, including when declining later.
        let sailor = choices[0]["cardId"].clone();
        choose(&mut game, target);
        assert_eq!(game.current["actor"], "opponent");
        assert_eq!(game.current["stack"][0]["name"], "Affectionate Indrik");
        assert_eq!(game.current["stack"][0]["target"], "Spectral Sailor");

        if decision == "Cast Unsummon" {
            choose(&mut game, decision);
            choose(&mut game, target);
            assert_eq!(game.current["stack"][0]["name"], "Unsummon");
            choose(&mut game, "Pass priority");
            assert_eq!(game.current["stack"][0]["name"], "Affectionate Indrik");
            choose(&mut game, "Pass priority");
        } else {
            choose(&mut game, "Pass priority");
            assert_eq!(game.current["actor"], "player");
            assert_eq!(game.current["choices"].as_array().unwrap().len(), 2);
            assert!(zone(&game, "opponent", "battlefield")
                .iter()
                .any(|c| c["id"] == sailor));
            choose(&mut game, decision);
        }
        assert!(game.current["stack"].as_array().unwrap().is_empty());
        assert!(zone(&game, "opponent", destination)
            .iter()
            .any(|c| c["id"] == sailor));
    }
}
