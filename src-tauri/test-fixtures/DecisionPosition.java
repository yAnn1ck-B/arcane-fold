// Real-controller fixtures used by the Foundations human-decision regressions.
final class DecisionPosition {
    static void setup(ForgeMatch match, String mode) {
        Player seat = match.player;
        match.put("Forest", seat, ZoneType.Hand); // An action after the stack resolves.
        for (int i = 0; i < 6; i++) match.put("Island", seat, ZoneType.Battlefield);
        switch (mode) {
            case "decision-discard" -> {
                match.put("Mountain", seat, ZoneType.Battlefield);
                for (String card : List.of("Thrill of Possibility", "Unsummon", "Fleeting Distraction"))
                    match.put(card, seat, ZoneType.Hand);
            }
            case "decision-sacrifice" -> {
                for (String card : List.of("Hungry Ghoul", "Llanowar Elves", "Healer's Hawk"))
                    match.put(card, seat, ZoneType.Battlefield);
            }
            case "decision-curator" -> {
                match.put("Curator of Destinies", seat, ZoneType.Hand);
                for (String card : List.of("Llanowar Elves", "Plains", "Goldvein Pick", "Mountain", "Healer's Hawk"))
                    match.put(card, seat, ZoneType.Library);
            }
            case "decision-grave" -> {
                match.put("Inspiration from Beyond", seat, ZoneType.Hand);
                match.put("Unsummon", seat, ZoneType.Graveyard);
                match.put("Fleeting Distraction", seat, ZoneType.Graveyard);
            }
            case "decision-color" -> {
                match.put("Heraldic Banner", seat, ZoneType.Hand);
                match.put("Aegis Turtle", seat, ZoneType.Battlefield);
                match.put("Fanatical Firebrand", seat, ZoneType.Battlefield);
            }
            case "decision-name" -> {
                match.put("Sorcerous Spyglass", seat, ZoneType.Hand);
                match.put("Soul-Guide Lantern", match.opponent, ZoneType.Hand);
                match.put("Opt", match.opponent, ZoneType.Hand);
                match.put("Reassembling Skeleton", match.opponent, ZoneType.Graveyard);
                match.put("Swamp", match.opponent, ZoneType.Battlefield);
                match.put("Island", match.opponent, ZoneType.Battlefield);
            }
            default -> throw new IllegalArgumentException("Unknown human decision fixture " + mode);
        }
    }
}
