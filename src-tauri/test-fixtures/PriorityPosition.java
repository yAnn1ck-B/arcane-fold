final class PriorityPosition {
    static void setup(ForgeMatch table, String mode) {
        Player player = table.player, opponent = table.opponent;
        table.put("Forest", player, ZoneType.Hand);
        switch (mode) {
            case "priority-dual-land" -> table.put("Blossoming Sands", player, ZoneType.Battlefield);
            case "priority-loyalty", "priority-loyalty-short" -> {
                var chandra = table.put("Chandra, Flameshaper", player, ZoneType.Battlefield);
                chandra.setCounters(forge.game.card.CounterEnumType.LOYALTY, mode.endsWith("short") ? 3 : 4);
                table.put("Vivien Reid", opponent, ZoneType.Battlefield).setCounters(forge.game.card.CounterEnumType.LOYALTY, 5);
                table.put("Opt", opponent, ZoneType.Hand);
                table.put("Island", opponent, ZoneType.Battlefield);
            }
            case "priority-mana-target", "priority-mana-target-tapped" -> {
                table.put("Hero's Downfall", player, ZoneType.Hand);
                for (int i = 0; i < 3; i++) table.put("Swamp", player, ZoneType.Battlefield);
                table.put("Opt", player, ZoneType.Hand);
                table.put("Island", player, ZoneType.Battlefield);
                Card elves = table.put("Llanowar Elves", opponent, ZoneType.Battlefield);
                elves.setSickness(false);
                elves.setTapped(mode.endsWith("tapped"));
                table.put("Island", opponent, ZoneType.Battlefield);
            }
            case "priority-counter" -> {
                table.put("Plains", player, ZoneType.Battlefield);
                table.put("Savannah Lions", player, ZoneType.Hand);
                table.put("Essence Scatter", opponent, ZoneType.Hand);
                table.put("Island", opponent, ZoneType.Battlefield);
                table.put("Island", opponent, ZoneType.Battlefield);
            }
            case "priority-yield" -> {
                table.put("Negate", player, ZoneType.Hand);
                table.put("Island", player, ZoneType.Battlefield);
                table.put("Island", player, ZoneType.Battlefield);
                table.put("Opt", opponent, ZoneType.Hand);
                table.put("Island", opponent, ZoneType.Battlefield);
            }
            case "priority-wrath", "priority-wrath-tapped" -> {
                table.put("Day of Judgment", player, ZoneType.Hand);
                for (int i = 0; i < 4; i++) table.put("Plains", player, ZoneType.Battlefield);
                table.put("Liliana, Dreadhorde General", opponent, ZoneType.Battlefield).setCounters(forge.game.card.CounterEnumType.LOYALTY, 6);
                Card elves = table.put("Llanowar Elves", opponent, ZoneType.Battlefield);
                elves.setSickness(false);
                elves.setTapped(mode.endsWith("tapped"));
                table.put("Island", opponent, ZoneType.Battlefield);
                table.put("Think Twice", opponent, ZoneType.Library);
            }
            case "priority-upkeep" -> {
                table.put("Phyrexian Arena", player, ZoneType.Battlefield);
                table.put("Burst Lightning", player, ZoneType.Hand);
                table.put("Negate", player, ZoneType.Hand);
                table.put("Mountain", player, ZoneType.Battlefield);
                table.put("Island", player, ZoneType.Battlefield);
                table.put("Island", player, ZoneType.Battlefield);
            }
            case "priority-end-step" -> {
                table.put("Reassembling Skeleton", opponent, ZoneType.Graveyard);
                table.put("Island", opponent, ZoneType.Battlefield);
                table.put("Swamp", opponent, ZoneType.Battlefield);
            }
            default -> throw new IllegalArgumentException(mode);
        }
    }
}
