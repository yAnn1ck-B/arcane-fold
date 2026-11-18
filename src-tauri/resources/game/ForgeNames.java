// The match database loads just the decks. An unrestricted naming effect can name a card
// outside them, including one face of a split or double-faced card.
final class ForgeNames {
    private static final Path archive = Path.of(GuiBase.getInterface().getAssetsDir(), "res", "cardsfolder", "cardsfolder.zip");
    private static Map<String, String> scripts;

    static forge.card.ICardFace face(String name) {
        if (name.isBlank()) return null;
        var loaded = StaticData.instance().getCommonCards().getFaceByName(name);
        if (loaded != null) return loaded;
        try (var zip = new java.util.zip.ZipFile(archive.toFile())) {
            if (scripts == null) {
                var index = new java.util.TreeMap<String, String>(String.CASE_INSENSITIVE_ORDER);
                var entries = zip.entries();
                while (entries.hasMoreElements()) {
                    var entry = entries.nextElement();
                    if (!entry.getName().endsWith(".txt")) continue;
                    try (var lines = new BufferedReader(new InputStreamReader(zip.getInputStream(entry), StandardCharsets.UTF_8))) {
                        for (String line; (line = lines.readLine()) != null;) {
                            if (line.startsWith("Name:")) index.putIfAbsent(line.substring(5).strip(), entry.getName());
                        }
                    }
                }
                scripts = index;
            }
            String entry = scripts.get(name);
            if (entry == null) return null;
            try (var lines = new BufferedReader(new InputStreamReader(zip.getInputStream(zip.getEntry(entry)), StandardCharsets.UTF_8))) {
                var rules = new forge.card.CardRules.Reader().readCard(forge.util.FileUtil.readAllLines(lines, true));
                if (rules.isVariant()) return null;
                var front = rules.getMainPart();
                if (front.getName().equalsIgnoreCase(name)) return front;
                var back = rules.getOtherPart();
                return back != null && back.getName().equalsIgnoreCase(name) ? back : null;
            }
        } catch (IOException ex) {
            throw new IllegalStateException("Could not read Forge card names.", ex);
        }
    }
}
