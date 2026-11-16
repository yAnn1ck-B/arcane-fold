use crate::catalog::CatalogCard;
use serde_json::Value;

pub const MAIN_TYPES: [&str; 9] = [
    "Artifact",
    "Battle",
    "Creature",
    "Enchantment",
    "Instant",
    "Kindred",
    "Land",
    "Planeswalker",
    "Sorcery",
];

// Keep this predicate and eligible() aligned. Metadata is retained in storage;
// ineligible printings simply cannot enter collection/deck/progression views.
pub const ELIGIBLE_SQL: &str = "(COALESCE(json_extract(c.metadata_json,'$.digital'),0)=0 AND COALESCE(json_extract(c.metadata_json,'$.oversized'),0)=0 AND (json_type(c.metadata_json,'$.games') IS NULL OR EXISTS(SELECT 1 FROM json_each(c.metadata_json,'$.games') g WHERE g.value='paper')) AND lower(COALESCE(json_extract(c.metadata_json,'$.border_color'),'black')) IN ('black','white','borderless') AND lower(COALESCE(json_extract(c.metadata_json,'$.security_stamp'),'')) NOT IN ('acorn','heart') AND lower(COALESCE(json_extract(c.metadata_json,'$.set_type'),'')) NOT IN ('funny','memorabilia','minigame','token','art_series') AND lower(c.set_code) NOT IN ('ugl','unh','ust','und','unf','punh','pust','punf','cmb1','cmb2','cmb3','phtr','htr') AND lower(COALESCE(json_extract(c.metadata_json,'$.layout'),'')) NOT IN ('token','double_faced_token','emblem','art_series','planar','scheme','vanguard','augment','host') AND c.cmc=CAST(c.cmc AS INTEGER) AND instr(c.mana_cost,'{H')=0 AND instr(COALESCE(json_extract(c.metadata_json,'$.power'),''),'.')=0 AND instr(COALESCE(json_extract(c.metadata_json,'$.toughness'),''),'.')=0 AND instr(COALESCE(json_extract(c.metadata_json,'$.power'),''),'/')=0 AND instr(COALESCE(json_extract(c.metadata_json,'$.toughness'),''),'/')=0 AND instr(COALESCE(json_extract(c.metadata_json,'$.power'),''),'½')=0 AND instr(COALESCE(json_extract(c.metadata_json,'$.toughness'),''),'½')=0 AND instr(COALESCE(json_extract(c.metadata_json,'$.power'),''),'¼')=0 AND instr(COALESCE(json_extract(c.metadata_json,'$.toughness'),''),'¼')=0 AND instr(COALESCE(json_extract(c.metadata_json,'$.power'),''),'¾')=0 AND instr(COALESCE(json_extract(c.metadata_json,'$.toughness'),''),'¾')=0 AND lower(c.type_line) NOT LIKE '%token%' AND lower(c.type_line) NOT LIKE '%emblem%')";

pub fn eligible(metadata: &Value, card: &CatalogCard) -> bool {
    let text = |key: &str| metadata.get(key).and_then(Value::as_str).unwrap_or("");
    let fractional_stat = |key: &str| text(key).contains(['.', '/', '½', '¼', '¾']);
    !metadata
        .get("digital")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && !metadata
            .get("oversized")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        && !metadata
            .get("games")
            .and_then(Value::as_array)
            .is_some_and(|games| !games.iter().any(|g| g.as_str() == Some("paper")))
        && matches!(
            metadata
                .get("border_color")
                .and_then(Value::as_str)
                .unwrap_or("black")
                .to_lowercase()
                .as_str(),
            "black" | "white" | "borderless"
        )
        && !matches!(
            text("security_stamp").to_lowercase().as_str(),
            "acorn" | "heart"
        )
        && !matches!(
            text("set_type").to_lowercase().as_str(),
            "funny" | "memorabilia" | "minigame" | "token" | "art_series"
        )
        && ![
            "ugl", "unh", "ust", "und", "unf", "punh", "pust", "punf", "cmb1", "cmb2", "cmb3",
            "phtr", "htr",
        ]
        .contains(&card.set_code.to_lowercase().as_str())
        && !matches!(
            text("layout").to_lowercase().as_str(),
            "token"
                | "double_faced_token"
                | "emblem"
                | "art_series"
                | "planar"
                | "scheme"
                | "vanguard"
                | "augment"
                | "host"
        )
        && card.cmc.is_finite()
        && card.cmc.fract() == 0.0
        && !card.mana_cost.contains("{H")
        && !fractional_stat("power")
        && !fractional_stat("toughness")
        && !card.type_line.to_lowercase().contains("token")
        && !card.type_line.to_lowercase().contains("emblem")
        && (card.type_line.is_empty() || !main_types(&card.type_line).is_empty())
}

pub fn regular_type_sql() -> String {
    let main = "' ' || lower(substr(c.type_line,1,instr(c.type_line || '—','—')-1)) || ' '";
    let mut types = MAIN_TYPES.to_vec();
    types.push("Tribal");
    format!(
        "(c.type_line='' OR {})",
        types
            .iter()
            .map(|kind| format!("instr({main},' {} ')>0", kind.to_lowercase()))
            .collect::<Vec<_>>()
            .join(" OR ")
    )
}

pub fn main_types(type_line: &str) -> Vec<String> {
    let mut types = Vec::new();
    for face in type_line.split(" // ") {
        for word in face
            .split('—')
            .next()
            .unwrap_or_default()
            .split_whitespace()
        {
            let word = if word.eq_ignore_ascii_case("Tribal") {
                "Kindred"
            } else {
                word
            };
            if let Some(kind) = MAIN_TYPES
                .iter()
                .find(|kind| kind.eq_ignore_ascii_case(word))
            {
                if !types.iter().any(|existing| existing == kind) {
                    types.push(kind.to_string());
                }
            }
        }
    }
    types
}

pub fn creature_types(type_line: &str) -> Vec<String> {
    let mut types = Vec::new();
    for face in type_line.split(" // ") {
        let Some((main, subtypes)) = face.split_once('—') else {
            continue;
        };
        if !main
            .split_whitespace()
            .any(|kind| kind.eq_ignore_ascii_case("Creature"))
        {
            continue;
        }
        let mut words = subtypes.split_whitespace().peekable();
        while let Some(word) = words.next() {
            if word == "Time" && words.peek() == Some(&"Lord") {
                words.next();
                types.push("Time Lord".into());
            } else {
                types.push(word.to_owned());
            }
        }
    }
    types
}
