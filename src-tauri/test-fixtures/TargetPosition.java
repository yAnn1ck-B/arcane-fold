// Positions for target choices that require an opponent with a response.
class TargetPosition {
    static void setup(ForgeMatch table, String scenario) {
        Player player = table.player;
        Player opponent = table.opponent;
        // Both seats retain a play after the stack resolves so the test can inspect it.
        table.put("Forest", player, ZoneType.Hand);
        table.put("Mountain", opponent, ZoneType.Battlefield);
        table.put("Burst Lightning", opponent, ZoneType.Hand);
        if (scenario.equals("target-goggles")) {
            table.put("Mountain", player, ZoneType.Battlefield);
            table.put("Pyromancer's Goggles", player, ZoneType.Battlefield);
            table.put("Shock", player, ZoneType.Hand);
            return;
        }
        if (scenario.startsWith("target-eaten")) {
            table.put("Eaten Alive", player, ZoneType.Hand);
            table.put("Runeclaw Bear", opponent, ZoneType.Battlefield);
            if (!scenario.endsWith("none")) {
                table.put("Healer's Hawk", player, ZoneType.Battlefield);
                table.put("Elvish Visionary", player, ZoneType.Battlefield);
            }
            int swamps = scenario.endsWith("rich") ? 5 : 1;
            for (int i = 0; i < swamps; i++) table.put("Swamp", player, ZoneType.Battlefield);
            return;
        }
        if (scenario.startsWith("target-harbinger")) {
            table.put("Harbinger of the Tides", player, ZoneType.Hand);
            table.put("Opt", player, ZoneType.Hand);
            table.put("Runeclaw Bear", opponent, ZoneType.Battlefield).setTapped(true);
            table.put("Healer's Hawk", opponent, ZoneType.Battlefield);
            int islands = scenario.endsWith("rich") ? 4 : 2;
            for (int i = 0; i < islands; i++) table.put("Island", player, ZoneType.Battlefield);
            return;
        }
        if (scenario.equals("target-solemn") || scenario.equals("target-highborn")) {
            table.put(scenario.equals("target-solemn") ? "Solemn Simulacrum" : "Kalastria Highborn", player, ZoneType.Battlefield);
            table.put("Swamp", player, ZoneType.Battlefield);
            return;
        }
        if (scenario.startsWith("target-mentor")) {
            table.put("Mentor of the Meek", player, ZoneType.Battlefield);
            table.put("Healer's Hawk", player, ZoneType.Hand);
            table.put("Plains", player, ZoneType.Battlefield);
            if (!scenario.equals("target-mentor-spent")) table.put("Island", player, ZoneType.Battlefield);
            return;
        }
        if (scenario.equals("target-artist")) {
            table.put("Perforating Artist", player, ZoneType.Battlefield).setSickness(false);
            table.put("Healer's Hawk", opponent, ZoneType.Battlefield);
            table.put("Llanowar Elves", opponent, ZoneType.Battlefield);
            table.put("Forest", opponent, ZoneType.Hand);
            return;
        }
        if (scenario.equals("target-bend") || scenario.equals("target-no-change")) {
            for (int i = 0; i < 4; i++) table.put("Mountain", player, ZoneType.Battlefield);
            table.put("Bolt Bend", player, ZoneType.Hand);
            table.put("Shock", player, ZoneType.Hand);
            if (scenario.equals("target-no-change")) {
                table.put("Giant Growth", opponent, ZoneType.Hand);
                table.put("Forest", opponent, ZoneType.Battlefield);
                table.put("Healer's Hawk", opponent, ZoneType.Battlefield);
            }
            return;
        }
        table.put("Llanowar Elves", player, ZoneType.Battlefield);
        table.put("Runeclaw Bear", opponent, ZoneType.Battlefield);
        table.put("Elvish Visionary", player, ZoneType.Battlefield);
        if (scenario.equals("target-chandra")) {
            table.put("Chandra, Flameshaper", player, ZoneType.Hand);
            for (int i = 0; i < 7; i++) table.put("Mountain", player, ZoneType.Battlefield);
        } else {
            table.put("Biogenic Upgrade", player, ZoneType.Hand);
            for (int i = 0; i < 6; i++) table.put("Forest", player, ZoneType.Battlefield);
            table.put("Island", opponent, ZoneType.Battlefield);
            table.put("Unsummon", opponent, ZoneType.Hand);
            if (scenario.equals("target-copy")) {
                table.put("Teach by Example", player, ZoneType.Hand);
                for (int i = 0; i < 2; i++) table.put("Mountain", player, ZoneType.Battlefield);
            }
        }
    }
}
