// Start with a specific Forge permission available (or about to become available).
final class PermissionPosition {
    static void setup(ForgeMatch table, String mode) {
        Player actor = table.player, other = table.opponent;
        table.put("Island", actor, ZoneType.Hand);
        switch (mode) {
            case "permission-lathril", "permission-lathril-short" -> {
                table.put("Lathril, Blade of the Elves", actor, ZoneType.Battlefield).setSickness(false);
                for (int i = 0; i < (mode.endsWith("-short") ? 9 : 10); i++) {
                    table.put("Llanowar Elves", actor, ZoneType.Battlefield);
                }
                var spare = table.put("Reclamation Sage", actor, ZoneType.Battlefield);
                if (mode.endsWith("-short")) {
                    spare.setTapped(true);
                    spare.setCounters(forge.game.card.CounterEnumType.STUN, 1);
                }
                table.put("Savannah Lions", actor, ZoneType.Battlefield);
                table.put("Llanowar Elves", other, ZoneType.Battlefield);
                table.put("Forest", other, ZoneType.Battlefield);
                table.put("Giant Growth", other, ZoneType.Hand);
            }
            case "permission-raider" -> {
                table.put("Savannah Lions", actor, ZoneType.Battlefield).setSickness(false);
                table.put("Strongbox Raider", actor, ZoneType.Hand);
                for (int i = 0; i < 4; i++) table.put("Mountain", actor, ZoneType.Battlefield);
                table.put("Plains", actor, ZoneType.Library);
                table.put("Mountain", actor, ZoneType.Library);
                table.put("Forest", other, ZoneType.Battlefield);
                table.put("Giant Growth", other, ZoneType.Hand);
            }
            case "permission-etali", "permission-etali-land", "permission-etali-kicker" -> {
                table.put("Etali, Primal Storm", actor, ZoneType.Battlefield).setSickness(false);
                table.put("Burst Lightning", actor, ZoneType.Library);
                table.put(mode.equals("permission-etali") ? "Giant Growth" : "Mountain", other, ZoneType.Library);
                if (mode.endsWith("-kicker")) {
                    for (int i = 0; i < 4; i++) table.put("Plains", actor, ZoneType.Battlefield);
                }
                // A response window after Etali finishes casting exposes the full stack.
                table.put("Forest", other, ZoneType.Battlefield);
                table.put("Giant Growth", other, ZoneType.Hand);
            }
            case "permission-vizier" -> {
                table.put("Vizier of the Menagerie", actor, ZoneType.Battlefield);
                table.put("Swamp", actor, ZoneType.Battlefield);
                table.put("Llanowar Elves", actor, ZoneType.Library);
                table.put("Giant Growth", actor, ZoneType.Library);
            }
            case "permission-free" -> {
                table.put("Omniscience", actor, ZoneType.Battlefield);
                table.put("Llanowar Elves", actor, ZoneType.Hand);
            }
            case "permission-edict" -> {
                table.put("Swamp", actor, ZoneType.Battlefield);
                table.put("Blasphemous Edict", actor, ZoneType.Hand);
                for (int i = 0; i < 12; i++) table.put("Llanowar Elves", other, ZoneType.Battlefield);
                table.put("Ornithopter", actor, ZoneType.Hand);
            }
            case "permission-muldrotha" -> {
                table.put("Muldrotha, the Gravetide", actor, ZoneType.Battlefield);
                table.put("Evolving Wilds", actor, ZoneType.Graveyard);
                table.put("Mountain", actor, ZoneType.Graveyard);
                table.put("Llanowar Elves", other, ZoneType.Graveyard);
            }
            case "permission-chandra" -> {
                table.put("Chandra, Flameshaper", actor, ZoneType.Hand);
                for (int i = 0; i < 7; i++) table.put("Mountain", actor, ZoneType.Battlefield);
                for (String name : List.of("Mountain", "Plains", "Swamp", "Forest", "Forest")) {
                    table.put(name, actor, ZoneType.Library);
                }
                // A legal play on later turns keeps the position inspectable after expiry.
                table.put("Evolving Wilds", other, ZoneType.Hand);
                table.put("Forest", other, ZoneType.Library);
            }
            case "permission-tinybones" -> {
                table.put("Tinybones, Bauble Burglar", actor, ZoneType.Battlefield);
                table.put("Swamp", actor, ZoneType.Battlefield);
                table.put("Swamp", actor, ZoneType.Battlefield);
                table.put("Burglar Rat", actor, ZoneType.Hand);
                table.put("Plains", other, ZoneType.Hand);
                table.put("Forest", other, ZoneType.Exile);
            }
            default -> throw new IllegalArgumentException("Unknown permission position: " + mode);
        }
        for (Player seat : table.game.getPlayers()) {
            for (int i = 0; i < 3; i++) table.put("Forest", seat, ZoneType.Library);
        }
    }
}
