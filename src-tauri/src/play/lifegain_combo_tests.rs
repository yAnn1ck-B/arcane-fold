use super::tests::{choose, play_until, seeded_deck, zone};
use super::Engine;

const PRIEST: &str = "Marauding Blight-Priest";
const CONQUEROR: &str = "Bloodthirsty Conqueror";

// FDN #178 drains once per life-gain event. FDN #58 gains the amount lost.
// See https://magic.wizards.com/en/news/feature/foundations-release-notes
fn attack_with_the_combo() -> Engine {
    let mut game = seeded_deck(
        "[Main]\n10 Swamp|FDN\n3 Marauding Blight-Priest|FDN|[178]\n3 Bloodthirsty Conqueror|FDN|[58]",
        Some("[Main]\n12 Island|FDN\n8 Unsummon|FDN|[599]"),
        19,
    );
    let setup = [
        "Keep hand",
        "Play Swamp",
        "Play Island",
        "No attacks",
        "Pass priority",
        "Discard",
    ];
    for spell in [
        "Cast Marauding Blight-Priest",
        "Cast Bloodthirsty Conqueror",
    ] {
        play_until(&mut game, spell, &setup);
        choose(&mut game, spell);
    }
    let attack = "Attack Player 2 with Marauding Blight-Priest";
    play_until(&mut game, attack, &setup);
    choose(&mut game, attack);
    choose(&mut game, "Confirm attackers");
    for _ in 0..12 {
        if game.current["stack"][0]["name"] == CONQUEROR {
            assert_eq!(game.current["actor"], "opponent");
            assert_eq!(game.current["players"]["opponent"]["life"], 17);
            assert_eq!(game.current["players"]["player"]["life"], 20);
            return game;
        }
        choose(&mut game, "Pass priority");
    }
    panic!("Combat damage never put the Conqueror trigger on the stack");
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_foundations_blight_priest_conqueror_drains_to_a_win() {
    let mut game = attack_with_the_combo();
    // The first Conqueror trigger gains three life from combat damage, and
    // the Priest turns that single event into just one life lost.
    choose(&mut game, "Pass priority");
    assert_eq!(game.current["players"]["player"]["life"], 23);
    for remaining in (1..=17).rev() {
        assert_eq!(game.current["stack"][0]["name"], PRIEST);
        assert_eq!(game.current["players"]["opponent"]["life"], remaining);
        choose(&mut game, "Pass priority");
        if remaining > 1 {
            assert_eq!(game.current["stack"][0]["name"], CONQUEROR);
            assert_eq!(game.current["players"]["opponent"]["life"], remaining - 1);
            choose(&mut game, "Pass priority");
        }
    }
    assert_eq!(game.current["stage"], "finished");
    assert_eq!(game.current["players"]["opponent"]["life"], 0);
    assert_eq!(game.current["players"]["player"]["life"], 39);
    assert!(game.current["prompt"]
        .as_str()
        .unwrap()
        .contains("Player 1 has won"));
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_foundations_unsummon_breaks_the_loop_but_the_pending_trigger_resolves() {
    let mut game = attack_with_the_combo();
    let conqueror_id = zone(&game, "player", "battlefield")
        .iter()
        .find(|card| card["name"] == CONQUEROR)
        .unwrap()["id"]
        .clone();
    choose(&mut game, "Cast Unsummon");
    choose(&mut game, "Target Bloodthirsty Conqueror");
    // Player 2 may still have another Unsummon. Pass all responses and
    // inspect the board in the second main phase of this same combat turn.
    let turn = game.current["turn"].clone();
    for _ in 0..14 {
        if game.current["phase"] == "Postcombat main phase" {
            break;
        }
        choose(&mut game, "Pass priority");
    }
    assert_eq!(game.current["turn"], turn);
    assert_eq!(game.current["phase"], "Postcombat main phase");
    assert_eq!(game.current["stage"], "decision");
    assert!(game.current["stack"].as_array().unwrap().is_empty());
    assert!(!zone(&game, "player", "battlefield")
        .iter()
        .any(|c| c["name"] == CONQUEROR));
    assert!(zone(&game, "player", "hand")
        .iter()
        .any(|c| c["id"] == conqueror_id));
    assert!(zone(&game, "opponent", "graveyard")
        .iter()
        .any(|c| c["name"] == "Unsummon"));
    assert_eq!(game.current["players"]["player"]["life"], 23);
    assert_eq!(game.current["players"]["opponent"]["life"], 16);
}
