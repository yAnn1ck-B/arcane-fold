// Isolated matches for decisions that can change which cards a player keeps.
final class IntegrityPosition {
    static void setup(ForgeMatch match, String mode) {
        match.put("Forest", match.player, ZoneType.Hand);
        if (mode.equals("integrity-vivien")) {
            match.put("Vivien Reid", match.player, ZoneType.Hand);
            for (int i = 0; i < 5; i++) match.put("Forest", match.player, ZoneType.Battlefield);
            for (String name : List.of("Healer's Hawk", "Swamp", "Negate", "Abrade")) {
                match.put(name, match.player, ZoneType.Library);
            }
        } else if (mode.equals("integrity-barrens")) {
            match.put("Crawling Barrens", match.player, ZoneType.Battlefield);
            for (int i = 0; i < 4; i++) match.put("Wastes", match.player, ZoneType.Battlefield);
        } else if (mode.startsWith("integrity-look-miss-")) {
            boolean loot = mode.endsWith("loot");
            match.put(loot ? "Loot, Exuberant Explorer" : "Squad Rallier", match.player, ZoneType.Battlefield)
                    .setSickness(false);
            for (int i = 0; i < (loot ? 6 : 3); i++) match.put(loot ? "Forest" : "Plains", match.player, ZoneType.Battlefield);
            for (String name : List.of("Negate", "Abrade", "Duress", "Unsummon", "Cancel", "Opt")) {
                match.put(name, match.player, ZoneType.Library);
            }
        } else if (mode.startsWith("integrity-juggernaut")) {
            match.put("Juggernaut", match.player, ZoneType.Battlefield).setSickness(false);
            if (mode.endsWith("walker")) {
                var walker = match.put("Chandra, Flameshaper", match.opponent, ZoneType.Battlefield);
                walker.setCounters(forge.game.card.CounterEnumType.LOYALTY, 6);
            } else if (mode.endsWith("companion")) {
                match.put("Savannah Lions", match.player, ZoneType.Battlefield).setSickness(false);
            }
            // The defender can still react after a forced attack is actually declared.
            match.put("Elspeth's Smite", match.opponent, ZoneType.Hand);
            match.put("Plains", match.opponent, ZoneType.Battlefield);
        } else if (mode.startsWith("integrity-menace")) {
            match.put("Nullpriest of Oblivion", match.player, ZoneType.Battlefield).setSickness(false);
            match.put("Runeclaw Bear", match.opponent, ZoneType.Battlefield);
            if (mode.endsWith("pair")) match.put("Grizzly Bears", match.opponent, ZoneType.Battlefield);
            else match.put("Grizzly Bears", match.opponent, ZoneType.Battlefield).setTapped(true);
        } else throw new IllegalArgumentException(mode);
    }
}
