import forge.CardStorageReader;
import forge.StaticData;
import forge.ImageKeys;
import forge.deck.Deck;
import forge.deck.DeckFormat;
import forge.deck.DeckSection;
import forge.deck.io.DeckSerializer;
import forge.item.PaperCard;
import forge.util.Localizer;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Manual integration check against an installed Forge desktop JAR and its real
 * card scripts. The check reads the supplied deck; it never launches Forge,
 * plays a match, writes a deck, or changes Forge settings.
 *
 * Requires a JDK compatible with the installed Forge desktop release (tested
 * with JDK 17 and Forge 2.0.13). This uses Forge's Java API, so a future Forge
 * release may require adapting the initialization call below.
 *
 * Run from the Forge installation folder: some Forge resources are relative
 * to the working directory. Use absolute paths and quote any paths with spaces:
 *
 * java -cp "<forge desktop jar>" "<project>/scripts/ForgeDeckCheck.java" "<forge installation folder>" "<exported .dck file>"
 *
 * The desktop JAR is forge-gui-desktop-<version>-jar-with-dependencies.jar in
 * the Forge installation folder. The check expects exactly 60 main-deck cards
 * and at most 15 sideboard cards. A successful run prints PASS and exits with
 * code 0. This verifies parsing, card support, and constructed conformance;
 * it does not simulate gameplay. Lines specifying name|SET|[collector] must
 * resolve to that exact edition and collector number, in the requested section.
 * Name-only Phase 1 fixtures remain supported without imposing a printing.
 */
public class ForgeDeckCheck {
    public static void main(String[] args) {
        try {
            if (args.length != 2) {
                throw new IllegalArgumentException("Expected: <Forge install folder> <deck file>");
            }
            Path install = Path.of(args[0]).toAbsolutePath();
            File deckFile = Path.of(args[1]).toAbsolutePath().toFile();
            String res = install.resolve("res").toString() + File.separator;
            Localizer.getInstance().initialize("en-US", res + "languages");
            String noImages = install.resolve("no-image-cache").toString() + File.separator;
            ImageKeys.initializeDirs(noImages, Map.of(), noImages, noImages,
                    noImages, noImages, noImages, noImages, noImages);

            // Reuse Forge's real archived scripts and edition metadata, while
            // excluding optional custom cards/tokens and user preferences.
            CardStorageReader cards = new CardStorageReader(res + "cardsfolder", null, true);
            new StaticData(cards, null, null, null,
                    res + "editions", install.resolve("no-custom-editions").toString(),
                    res + "blockdata", res + "setlookup", "Original Art All Editions",
                    false, false, false, false);

            // With lazy scripts, Forge can fall back to a card's first artwork
            // on its first lookup. Load each requested name/edition before the
            // deck parser so the exact collector checks below remain meaningful.
            for (List<RequestedCard> section : readRequestedPrintings(deckFile.toPath()).values()) {
                for (RequestedCard wanted : section) {
                    if (wanted.edition() == null) StaticData.instance().attemptToLoadCard(wanted.name());
                    else StaticData.instance().attemptToLoadCard(wanted.name(), wanted.edition());
                }
            }
            Deck deck = DeckSerializer.fromFile(deckFile);
            if (deck == null) throw new IllegalStateException("Forge could not parse deck metadata");
            if (deck.getMain().countAll() != 60) {
                throw new IllegalStateException("Expected 60 main-deck cards, found " + deck.getMain().countAll());
            }
            for (Map.Entry<PaperCard, Integer> entry : deck.getMain()) {
                if (entry.getKey().getRules().isUnsupported()) {
                    throw new IllegalStateException("Unsupported card: " + entry.getKey().getName());
                }
            }
            int sideCount = deck.has(DeckSection.Sideboard) ? deck.get(DeckSection.Sideboard).countAll() : 0;
            if (sideCount > 15) throw new IllegalStateException("Sideboard exceeds 15 cards");
            if (deck.has(DeckSection.Sideboard)) {
                for (Map.Entry<PaperCard, Integer> entry : deck.get(DeckSection.Sideboard)) {
                    if (entry.getKey().getRules().isUnsupported()) {
                        throw new IllegalStateException("Unsupported sideboard card: " + entry.getKey().getName());
                    }
                }
            }
            String problem = DeckFormat.Constructed.getDeckConformanceProblem(deck);
            if (problem != null) throw new IllegalStateException("Forge legality check: " + problem);
            int exactCopies = verifyRequestedPrintings(deckFile.toPath(), deck);
            System.out.println("PASS Forge parsed \"" + deck.getName() + "\": main="
                    + deck.getMain().countAll() + ", sideboard=" + sideCount
                    + ", every card supported, constructed conformance passed, exact printing copies verified="
                    + exactCopies + ".");
            // Forge's shared worker pool can keep the standalone JVM alive.
            System.exit(0);
        } catch (Throwable error) {
            error.printStackTrace();
            System.exit(1);
        }
    }

    private record RequestedCard(String name, String edition, String collectorNumber,
                                 int quantity, int lineNumber) {
        int specificity() {
            return collectorNumber != null ? 2 : edition != null ? 1 : 0;
        }

        String description() {
            return name + (edition == null ? "" : "|" + edition)
                    + (collectorNumber == null ? "" : "|[" + collectorNumber + "]");
        }
    }

    private static Map<DeckSection, List<RequestedCard>> readRequestedPrintings(Path source) throws Exception {
        Map<DeckSection, List<RequestedCard>> requested = new LinkedHashMap<>();
        requested.put(DeckSection.Main, new ArrayList<>());
        requested.put(DeckSection.Sideboard, new ArrayList<>());
        Pattern cardLine = Pattern.compile("^(\\d+)\\s+(.+)$");
        DeckSection section = null;
        int lineNumber = 0;
        for (String raw : Files.readAllLines(source, StandardCharsets.UTF_8)) {
            lineNumber++;
            String line = raw.strip();
            if (lineNumber == 1 && line.startsWith("\uFEFF")) line = line.substring(1).strip();
            if (line.isEmpty() || line.startsWith("#")) continue;
            if (line.startsWith("[") && line.endsWith("]")) {
                section = line.equalsIgnoreCase("[Main]") ? DeckSection.Main
                        : line.equalsIgnoreCase("[Sideboard]") ? DeckSection.Sideboard : null;
                continue;
            }
            if (section == null) continue;
            Matcher match = cardLine.matcher(line);
            if (!match.matches()) throw new IllegalStateException("Invalid card line " + lineNumber + ": " + line);
            int quantity = Integer.parseInt(match.group(1));
            if (quantity < 1) throw new IllegalStateException("Non-positive quantity on line " + lineNumber);
            String[] fields = match.group(2).split("\\|", -1);
            if (fields.length > 3 || fields[0].isBlank()) {
                throw new IllegalStateException("Unsupported printing syntax on line " + lineNumber + ": " + line);
            }
            String edition = fields.length >= 2 ? fields[1].strip() : null;
            String collector = null;
            if (edition != null && edition.isEmpty()) {
                throw new IllegalStateException("Missing edition on line " + lineNumber);
            }
            if (fields.length == 3) {
                String token = fields[2].strip();
                if (!token.startsWith("[") || !token.endsWith("]") || token.length() < 3) {
                    throw new IllegalStateException("Expected [collector] on line " + lineNumber + ": " + line);
                }
                collector = token.substring(1, token.length() - 1).strip();
                if (collector.isEmpty()) throw new IllegalStateException("Missing collector number on line " + lineNumber);
            }
            requested.get(section).add(new RequestedCard(fields[0].strip(), edition, collector, quantity, lineNumber));
        }

        return requested;
    }

    private static int verifyRequestedPrintings(Path source, Deck deck) throws Exception {
        Map<DeckSection, List<RequestedCard>> requested = readRequestedPrintings(source);
        int exactCopies = 0;
        for (Map.Entry<DeckSection, List<RequestedCard>> sectionEntry : requested.entrySet()) {
            DeckSection requestedSection = sectionEntry.getKey();
            Map<PaperCard, Integer> remaining = new LinkedHashMap<>();
            if (deck.has(requestedSection)) {
                for (Map.Entry<PaperCard, Integer> entry : deck.get(requestedSection)) {
                    remaining.merge(entry.getKey(), entry.getValue(), Integer::sum);
                }
            }
            // Exact printing requests consume first so a name-only line cannot
            // accidentally satisfy the printing constraint of another line.
            List<RequestedCard> lines = sectionEntry.getValue();
            lines.sort(Comparator.comparingInt(RequestedCard::specificity).reversed());
            for (RequestedCard wanted : lines) {
                int needed = wanted.quantity();
                for (Map.Entry<PaperCard, Integer> actual : remaining.entrySet()) {
                    PaperCard card = actual.getKey();
                    if (!matchesName(wanted.name(), card)
                            || wanted.edition() != null && !wanted.edition().equalsIgnoreCase(card.getEdition())
                            || wanted.collectorNumber() != null && !wanted.collectorNumber().equals(card.getCollectorNumber())) continue;
                    int consumed = Math.min(needed, actual.getValue());
                    actual.setValue(actual.getValue() - consumed);
                    needed -= consumed;
                    if (needed == 0) break;
                }
                if (needed != 0) {
                    throw new IllegalStateException("Printing mismatch in " + requestedSection
                            + " on line " + wanted.lineNumber() + ": requested " + wanted.quantity()
                            + " " + wanted.description() + ", but Forge resolved " + needed
                            + " fewer matching copies. Resolved section: " + describeSection(deck, requestedSection));
                }
                if (wanted.collectorNumber() != null) exactCopies += wanted.quantity();
            }
            int extras = remaining.values().stream().mapToInt(Integer::intValue).sum();
            if (extras != 0) {
                throw new IllegalStateException("Forge resolved " + extras + " unrequested cards in "
                        + requestedSection + ": " + describeSection(deck, requestedSection));
            }
        }
        return exactCopies;
    }

    private static boolean matchesName(String requested, PaperCard actual) {
        String expected = normalizeName(requested);
        if (expected.equals(normalizeName(actual.getName()))) return true;
        // Forge can expose a transform/meld card by its front-face name while
        // catalog metadata uses "Front // Back". Keep the edition and collector
        // checks exact, and compare the canonical playable front face.
        if (actual.getMainFace() != null && expected.equals(normalizeName(actual.getMainFace().getName()))) return true;
        if (actual.hasBackFace() && requested.contains("//")) {
            String front = requested.split("\\s*//\\s*", 2)[0];
            return normalizeName(front).equals(normalizeName(actual.getName()))
                    || actual.getMainFace() != null && normalizeName(front).equals(normalizeName(actual.getMainFace().getName()));
        }
        return false;
    }

    private static String normalizeName(String value) {
        return value == null ? "" : value.strip().replaceAll("\\s+", " ").toLowerCase(Locale.ROOT);
    }

    private static String describeSection(Deck deck, DeckSection section) {
        if (!deck.has(section)) return "(empty)";
        List<String> cards = new ArrayList<>();
        for (Map.Entry<PaperCard, Integer> entry : deck.get(section)) {
            PaperCard card = entry.getKey();
            cards.add(entry.getValue() + " " + card.getName() + "|" + card.getEdition()
                    + "|[" + card.getCollectorNumber() + "]");
        }
        return String.join(", ", cards);
    }
}
