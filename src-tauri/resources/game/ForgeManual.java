// A private, read-only export of the suspended engine. Never include this in a seat view.
final class ForgeManual {
    private final Game game;
    private final Player first;
    private final Map<String, Object> pieces = new LinkedHashMap<>();
    private final Map<String, Object> catalog = new LinkedHashMap<>();
    private int nextId = 1;

    ForgeManual(Game game, Player first) {
        this.game = game;
        this.first = first;
    }

    // 2.0.13 exposes the active stack iterator, but no iterator for its deferred entries.
    // During an in-progress callback these still need to be placed by the manual players.
    // Read only these three pinned queues. Fail the export if their layout has changed.
    private List<?> queue(String name) {
        try {
            var field = forge.game.zone.MagicStack.class.getDeclaredField(name);
            if (field.trySetAccessible() && field.get(game.getStack()) instanceof List<?> contents) return contents;
        } catch (ReflectiveOperationException ex) {
            throw new IllegalStateException("Forge could not read the pending effects at this decision.", ex);
        }
        throw new IllegalStateException("Forge could not read the pending effects at this decision.");
    }

    List<String> pendingEffects() {
        var seen = new java.util.HashSet<Integer>();
        for (var item : game.getStack()) seen.add(item.getSpellAbility().getId());
        var pending = new ArrayList<String>();
        for (String name : List.of("frozenStack", "simultaneousStackEntryList", "activePlayerSAs")) {
            for (Object entry : queue(name)) {
                var spell = entry instanceof forge.game.spellability.SpellAbilityStackInstance frozen
                        ? frozen.getSpellAbility() : (SpellAbility) entry;
                if (!seen.add(spell.getId())) continue;
                Card host = spell.getHostCard();
                // Announcements for queued triggers must never expose another player's hidden source.
                if (host.getZone() == null || host.getZone().getZoneType().isHidden() || host.isFaceDown()) {
                    pending.add("An effect from a hidden card");
                } else {
                    String rules = spell.getTrigger() == null ? "" : spell.getTrigger().toString(true);
                    pending.add(rules.isBlank() ? host.getName() : host.getName() + " — " + rules);
                }
            }
        }
        return pending;
    }

    static String readAction(BufferedReader input, java.util.function.Supplier<Map<String, Object>> snapshot)
            throws IOException {
        String line;
        while ((line = input.readLine()) != null && line.startsWith("EXPORT_MANUAL ")) {
            String nonce = line.substring("EXPORT_MANUAL ".length());
            Map<String, Object> reply;
            try {
                reply = Map.of("match", snapshot.get());
            } catch (RuntimeException ex) {
                reply = Map.of("error", ex.getMessage() == null ? "Forge could not export this position." : ex.getMessage());
            }
            var json = new StringWriter();
            new JsonObjectWriter(json, 16).value(NoOpLogger.getInstance(), reply);
            System.out.println("GAME_MANUAL " + nonce + " " + json);
            System.out.flush();
        }
        return line;
    }

    private int seat(Player p) {
        return p == first ? 0 : 1;
    }

    private String id(Card card) {
        if (!card.isToken() && card.getPaperCard() != null) return "forge-card-" + card.getId();
        int serial = card.getId() + 1;
        nextId = Math.max(nextId, serial + 1);
        return "token-" + serial;
    }

    private static Map<String, Integer> counters(forge.game.GameEntity entity) {
        var values = new LinkedHashMap<String, Integer>();
        entity.getCounters().forEach((type, count) -> values.put(type.getName(), count));
        return values;
    }

    private String printing(Card card) {
        var paper = card.getPaperCard();
        if (paper == null || card.isToken()) return null;
        String key = "forge:" + paper.getEdition() + ":" + paper.getCollectorNumber() + ":" + paper.getName();
        if (catalog.containsKey(key)) return key;
        var rules = paper.getRules();
        var data = new LinkedHashMap<String, Object>();
        data.put("id", key);
        data.put("oracleId", "forge:" + paper.getName());
        data.put("name", paper.getName());
        data.put("setCode", paper.getEdition());
        data.put("setName", paper.getEdition());
        data.put("collectorNumber", paper.getCollectorNumber());
        data.put("rarity", paper.getRarity().toString().toLowerCase(java.util.Locale.ROOT));
        var faces = rules.getAllFaces();
        data.put("typeLine", String.join(" // ", faces.stream().map(f -> f.getType().toString()).toList()));
        data.put("manaCost", String.join(" // ", faces.stream()
                .map(f -> f.getManaCost().isNoCost() ? "" : f.getManaCost().toString()).toList()));
        data.put("oracleText", rules.getOracleText().replace("\\n", "\n"));
        data.put("cmc", rules.getManaCost().getCMC());
        var colors = new ArrayList<String>();
        for (var color : rules.getColor()) colors.add(color.getShortName());
        data.put("colors", colors);
        data.put("owned", 0);
        data.put("imageUri", null);
        data.put("backImageUri", null);
        catalog.put(key, data);
        return key;
    }

    private String piece(Card card) {
        String key = id(card);
        if (pieces.containsKey(key)) throw new IllegalStateException("A Forge card has two locations. Finish this decision and try again.");
        var out = new LinkedHashMap<String, Object>();
        String printing = printing(card);
        out.put("id", key);
        out.put("printing", printing);
        out.put("tokenName", printing == null ? card.getName() : null);
        out.put("owner", seat(card.getOwner()));
        out.put("controller", seat(card.getController()));
        out.put("tapped", card.isTapped());
        out.put("back", card.isBackSide() || card.getCurrentStateName() == forge.card.CardStateName.Flipped);
        out.put("faceDown", card.isFaceDown());
        if (card.isFaceDown()) out.put("faceDownVisibleTo", game.getPlayers().stream()
                .filter(p -> card.getView().canFaceDownBeShownTo(p.getView())).map(this::seat).toList());
        out.put("revealed", false);
        out.put("counters", counters(card));
        out.put("attachedTo", card.getAttachedTo() == null ? null : id(card.getAttachedTo()));
        if (card.getPlayerAttachedTo() != null) out.put("attachedToPlayer", seat(card.getPlayerAttachedTo()));
        if (card.isInZone(ZoneType.Battlefield)) {
            if (card.getDamage() > 0) out.put("damage", card.getDamage());
            if (card.hasChosenType()) out.put("chosenType", card.getChosenType());
            if (card.isCreature()) {
                out.put("power", card.getNetPower());
                out.put("toughness", card.getNetToughness());
                if (card.isSick()) out.put("summoningSick", true);
            }
            if (card.isPhasedOut()) out.put("phasedOut", true);
        }
        out.put("combat", null);
        var combat = game.getPhaseHandler().getCombat();
        if (combat != null && combat.isAttacking(card)) {
            out.put("combat", "attacking");
            var target = combat.getDefenderByAttacker(card);
            if (target instanceof Player p) out.put("combatTargets", List.of("P" + (seat(p) + 1)));
            if (target instanceof Card c) out.put("combatTargets", List.of(id(c)));
        } else if (combat != null && combat.getAllBlockers().contains(card)) {
            out.put("combat", "blocking");
            out.put("combatTargets", combat.getAttackersBlockedBy(card).stream().map(this::id).toList());
        }
        pieces.put(key, out);
        return key;
    }

    private Map<String, Object> player(Player p, String deckName, boolean kept, int mulligans, CardCollection bottom) {
        var piles = new LinkedHashMap<String, Object>();
        for (ZoneType zone : Player.ALL_ZONES) {
            var location = p.getZone(zone);
            if (location == null) continue;
            // getCards(false) includes phased-out permanents and preserves the library's top-first order.
            var cards = location.getCards(false);
            switch (zone) {
                case Hand, Library, Battlefield, Graveyard, Exile, Command -> {
                    if (zone != ZoneType.Command || !cards.isEmpty()) {
                        piles.put(zone.name().toLowerCase(java.util.Locale.ROOT), cards.stream().map(this::piece).toList());
                    }
                }
                default -> {
                    if (!cards.isEmpty()) throw new IllegalStateException("The manual table cannot represent an occupied " + zone.getName() + " zone.");
                }
            }
        }
        var out = new LinkedHashMap<String, Object>(Map.of("deckName", deckName, "life", p.getLife(), "zones", piles, "mana", ForgeMatch.manaByColor(p),
                "mulligans", mulligans, "kept", kept, "counters", counters(p)));
        if (bottom != null && !bottom.isEmpty()) out.put("openingBottom", bottom.stream().map(this::id).toList());
        return out;
    }

    private Map<String, Object> stackItem(SpellAbility spell, Card host, Set<Integer> spells) {
        boolean physical = spell.isSpell();
        boolean copy = spell.isCopied() || (physical && host.isCopiedSpell());
        var out = new LinkedHashMap<String, Object>();
        out.put("id", "stack-" + nextId++);
        out.put("kind", copy ? "copy" : physical ? "spell" : "ability");
        boolean hiddenSource = host.getZone() == null || host.getZone().getZoneType().isHidden();
        String name = !physical && hiddenSource ? "An ability from a hidden card" : ForgeMatch.publicName(host);
        String description = spell.getStackDescription();
        boolean publicText = !host.isFaceDown() && host.getZone() != null && host.getZone().getZoneType().isKnown();
        for (var group : spell.getAllTargetChoices()) {
            for (GameObject target : group) {
                if (target instanceof Card c && (c.isFaceDown() || c.getZone() == null || c.getZone().getZoneType().isHidden())) {
                    publicText = false;
                }
            }
        }
        String label = !physical && publicText && description != null && !description.isBlank() ? description : name;
        if (spell.getXManaCostPaid() != null && spell.getXManaCostPaid() > 0) label += " (X = " + spell.getXManaCostPaid() + ")";
        out.put("label", physical && host.isFaceDown() ? "Face-down spell" : label);
        if (publicText && description != null && !description.isBlank() && !description.equals(label)) {
            out.put("description", description);
        }
        out.put("controller", seat(spell.getActivatingPlayer() == null ? host.getController() : spell.getActivatingPlayer()));
        if (physical) spells.add(host.getId());
        out.put("card", physical && !copy ? piece(host) : null);
        out.put("source", !physical && pieces.containsKey(id(host)) ? id(host) : null);
        var targets = new ArrayList<String>();
        for (var group : spell.getAllTargetChoices()) {
            for (GameObject target : group) {
                String targetLabel;
                if (target instanceof Player p) targetLabel = "Player " + (seat(p) + 1);
                else if (target instanceof SpellAbility ability) {
                    Card source = ability.getHostCard();
                    targetLabel = source.getZone() == null || source.getZone().getZoneType().isHidden()
                            ? "An ability on the stack" : ForgeMatch.publicName(source) + " (stack)";
                }
                else if (target instanceof Card card) {
                    var zone = card.getZone();
                    if (zone != null && zone.getZoneType().isHidden()) {
                        targetLabel = "A card in Player " + (seat(card.getOwner()) + 1) + "'s " + zone.getZoneType().getName();
                    } else targetLabel = ForgeMatch.publicName(card) + " (" + id(card) + ")";
                } else continue;
                targets.add(ForgeMatch.targetWithAmount(targetLabel, group, target));
            }
        }
        out.put("targets", String.join(", ", targets));
        out.put("copyKind", copy ? physical ? "spell" : "ability" : null);
        out.put("copyPrinting", copy && physical && !host.isFaceDown() ? printing(host) : null);
        out.put("copyBack", copy && physical && !host.isFaceDown() && host.isBackSide());
        out.put("copyFaceDown", copy && physical && host.isFaceDown());
        return out;
    }

    Map<String, Object> snapshot(Player other, String[] deckNames, boolean[] kept, int[] mulligans, Map<Player, CardCollection> openingBottom) {
        var one = player(first, deckNames[0], kept[0], mulligans[0], openingBottom.get(first));
        var two = player(other, deckNames[1], kept[1], mulligans[1], openingBottom.get(other));
        var stack = new ArrayList<Map<String, Object>>();
        var spells = new java.util.HashSet<Integer>();
        for (var entry : game.getStack()) stack.add(stackItem(entry.getSpellAbility(), entry.getSourceCard(), spells));
        // A spell being announced or resolving can be physically on the stack before/after
        // its public MagicStack instance exists. Preserve the physical card exactly once.
        for (Card card : game.getStackZone().getCards()) {
            if (spells.contains(card.getId())) continue;
            var cast = card.getCastSA();
            if (cast == null) throw new IllegalStateException("Forge is moving a spell onto the stack. Finish this choice and try again.");
            stack.add(0, stackItem(cast, card, spells));
        }
        var phases = game.getPhaseHandler();
        PhaseType phase = phases.getPhase();
        int step = phase == null ? 0 : switch (phase) {
            case UNTAP -> 0;
            case UPKEEP -> 1;
            case DRAW -> 2;
            case MAIN1 -> 3;
            case COMBAT_BEGIN -> 4;
            case COMBAT_DECLARE_ATTACKERS -> 5;
            case COMBAT_DECLARE_BLOCKERS -> 6;
            case COMBAT_FIRST_STRIKE_DAMAGE, COMBAT_DAMAGE -> 7;
            case COMBAT_END -> 8;
            case MAIN2 -> 9;
            case END_OF_TURN -> 10;
            case CLEANUP -> 11;
        };
        var match = new LinkedHashMap<String, Object>(Map.of("version", 1, "players", List.of(one, two), "catalog", catalog, "pieces", pieces,
                "stack", stack, "turn", Math.max(1, phases.getTurn()), "active", phases.getPlayerTurn() == null ? 0 : seat(phases.getPlayerTurn()),
                "step", step, "nextId", nextId));
        if (phase == PhaseType.COMBAT_FIRST_STRIKE_DAMAGE) match.put("firstStrikeDamage", true);
        return match;
    }
}
