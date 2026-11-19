// Runs the saved decks through the installed Forge engine, pausing for human decisions.
class ForgeMatch {
    final Player player;
    final Player opponent;
    final Game game;
    final PhaseHandler phases;
    private final ForgeHistory history;
    private final Path scratch;
    private final BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    private final ForgeLibrary library = new ForgeLibrary(this);
    private CardCollectionView revealedHand;
    private int decision;
    private int yieldTurn = -1;
    private final String[] priorityStops = {"auto", "auto"};
    private static final String PRIORITY_STOP_PROMPT = "At your stop — choose a play or continue";
    private final boolean sharedSeats;
    private final String[] deckNames = {"Player 1", "Player 2"};
    private final boolean[] keptHands = {false, false};
    private final int[] mulligans = {0, 0};
    private final Map<Player, CardCollection> openingBottom = new java.util.IdentityHashMap<>();

    ForgeMatch(Path scratch, boolean sharedSeats) {
        this.scratch = scratch;
        this.sharedSeats = sharedSeats;
        game = new Match(new GameRules(GameType.Constructed),
                List.of(seat(sharedSeats ? "Player 1" : "Player"), seat(sharedSeats ? "Player 2" : "Opponent")),
                "Eternal League").createGame();
        player = game.getPlayers().get(0);
        opponent = game.getPlayers().get(1);
        phases = game.getPhaseHandler();
        game.setStartingPlayer(player);
        for (Player p : game.getPlayers()) {
            p.setStartingLife(20);
            p.setLife(20, null);
            p.setMaxHandSize(7);
            p.setStartingHandSize(7);
        }
        history = new ForgeHistory(game);
    }

    private RegisteredPlayer seat(String name) {
        LobbyPlayerAi lobby = new LobbyPlayerAi(name, Set.of()) {
            @Override
            public Player createIngamePlayer(Game match, int id) {
                Player p = new Player(getName(), match, id);
                p.setFirstController(new Controller(match, p, this));
                return p;
            }
        };
        return new RegisteredPlayer(new Deck(name)).setPlayer(lobby);
    }

    Card put(String name, Player p, ZoneType zone) {
        StaticData.instance().attemptToLoadCard(name);
        Card card = CardFactory.getCard(StaticData.instance().getCommonCards().getCard(name), p, game);
        p.getZone(zone).add(card);
        return card;
    }

    boolean human(Player p) {
        return p == player || sharedSeats;
    }

    private void loadLibrary(Player owner, Path file) throws IOException {
        boolean main = false;
        var catalog = StaticData.instance();
        for (String row : Files.readAllLines(file, StandardCharsets.UTF_8)) {
            String line = row.strip();
            if (line.startsWith("[")) {
                main = line.equalsIgnoreCase("[main]");
            } else if (!main && line.startsWith("Name=") && line.length() > 5) {
                deckNames[owner == player ? 0 : 1] = line.substring(5);
            } else if (main && !line.isEmpty() && !line.startsWith("#")) {
                String[] counted = line.split("\\s+", 2);
                String[] printing = counted[1].split("\\|", -1);
                String name = printing[0];
                String set = printing.length > 1 ? printing[1] : null;
                String collector = printing.length > 2 ? printing[2].replaceAll("^\\[|\\]$", "") : null;
                if (set == null) catalog.attemptToLoadCard(name);
                else catalog.attemptToLoadCard(name, set);
                var db = catalog.getCommonCards();
                PaperCard paper = collector != null ? db.getCard(name, set, collector)
                        : set != null ? db.getCard(name, set) : db.getCard(name);
                if (paper == null || paper.getRules().isUnsupported()
                        || set != null && !set.equalsIgnoreCase(paper.getEdition())
                        || collector != null && !collector.equals(paper.getCollectorNumber())) {
                    throw new IllegalArgumentException("Forge could not load the saved printing of " + counted[1]);
                }
                int copies = Integer.parseInt(counted[0]);
                for (int i = 0; i < copies; i++) {
                    owner.getZone(ZoneType.Library).add(CardFactory.getCard(paper, owner, game));
                }
            }
        }
        if (owner.getCardsIn(ZoneType.Library).size() < owner.getStartingHandSize()) {
            throw new IllegalArgumentException("Each deck needs at least seven main-deck cards.");
        }
    }

    private void prepareDeck() throws IOException {
        loadLibrary(player, scratch.resolve("practice.dck"));
        if (sharedSeats) loadLibrary(opponent, scratch.resolve("opponent.dck"));
        else for (int i = 0; i < 60; i++) put("Island", opponent, ZoneType.Library);
        game.setAge(GameStage.Mulligan);
        for (Player p : game.getPlayers()) {
            p.shuffle(null);
            p.drawCards(p.getStartingHandSize());
        }
        StaticData.instance().setMulliganRule(forge.MulliganDefs.MulliganRule.London);
        new MulliganService(player).perform();
    }

    void run() throws IOException {
        try {
            prepareDeck();
            game.setAge(GameStage.Play);
            Player first = runOpeningHandActions();
            game.getAction().checkStateEffects(true);
            game.setStartingPlayer(first);
            phases.setupFirstTurn(first, null);
            while (!game.isGameOver()) phases.mainLoopStep();
            emit(player, String.join(" ", game.getOutcome().getOutcomeStrings()), List.of(), true);
        } catch (EndInput closed) {
            // The table closed while Forge was waiting for a controller decision.
        }
    }

    private Player runOpeningHandActions() {
        // Forge 2.0.13 keeps this step of GameAction.startGame private. The saved-deck
        // table initializes its own decks, mulligans and priority loop around it.
        try {
            var action = game.getAction();
            var opening = forge.game.GameAction.class.getDeclaredMethod("runOpeningHandActions", Player.class);
            opening.setAccessible(true);
            return (Player) opening.invoke(action, player);
        } catch (java.lang.reflect.InvocationTargetException error) {
            if (error.getCause() instanceof RuntimeException cause) throw cause;
            throw new IllegalStateException("Forge failed to resolve an opening-hand action.", error.getCause());
        } catch (ReflectiveOperationException error) {
            throw new IllegalStateException("This Forge installation cannot run opening-hand actions.", error);
        }
    }

    static final class EndInput extends RuntimeException {}

    record Choice(String label, String kind, String cardId, Player seat, Runnable action, boolean manaAbility) {
        Choice(String label, String kind, String cardId, Player seat, Runnable action) {
            this(label, kind, cardId, seat, action, false);
        }
        void run() {
            if (action != null) action.run();
        }
    }

    Choice choice(String label, String kind, Card card, Player seat, Runnable action) {
        return new Choice(label, kind, card == null ? null : cardId(card), seat, action);
    }

    private boolean offersEndTurn(Player actor, String prompt, Choice choice) {
        return choice.kind().equals("pass") && phases.isPlayerTurn(actor) && game.getStack().isEmpty()
                && (!prompt.equals(PRIORITY_STOP_PROMPT) || phases.getPhase() == PhaseType.END_OF_TURN
                        || phases.getPhase() == PhaseType.CLEANUP);
    }

    Choice ask(Player actor, String prompt, List<Choice> choices) {
        if (choices.isEmpty()) throw new IllegalStateException("Forge supplied no choices for " + prompt);
        decision++;
        try {
            emit(actor, prompt, choices, false);
            String selected = ForgeManual.readAction(input, () -> {
                boolean opening = game.getAge() == GameStage.Mulligan;
                var export = new ForgeManual(game, player);
                var match = export.snapshot(opponent, deckNames,
                        opening ? keptHands : new boolean[]{true, true}, mulligans, openingBottom);
                var waiting = opening ? List.<String>of() : export.pendingEffects();
                boolean priority = prompt.equals("Choose a play") || prompt.equals(PRIORITY_STOP_PROMPT);
                if (!opening && (!priority || !waiting.isEmpty())) {
                    // E.g. a private scry still in progress inside a resolving spell. This is
                    // retained in the private checkpoint and projected only to the choosing seat.
                    String text = waiting.isEmpty() ? prompt : prompt + ". Effects awaiting stack placement: " + String.join("; ", waiting);
                    match.put("handoffDecision", Map.of("seat", actor == player ? 0 : 1, "text", text,
                            "choices", choices.stream().map(Choice::label).toList()));
                }
                return match;
            });
            if (selected == null) throw new EndInput();
            if (selected.startsWith("PRIORITY ")) {
                // Rust attaches both seats' pending settings to the move that resumes Forge.
                // Everything following the settings is the original choice, including free text.
                var parts = selected.split(" ", 4);
                for (int i = 0; i < priorityStops.length; i++) {
                    if (!parts[i + 1].equals("=")) priorityStops[i] = parts[i + 1];
                }
                selected = parts[3];
            }
            for (int i = 0; i < choices.size(); i++) {
                Choice choice = choices.get(i);
                if (selected.equals(choiceId(i) + "_end") && offersEndTurn(actor, prompt, choice)) {
                    yieldTurn = priorityStops[seatIndex(actor)].equals("auto") ? phases.getTurn() : -1;
                    history.add(actor.getName() + " chose to end the turn.");
                    return choice;
                }
                if (choices.get(i).kind().equals("name") && selected.startsWith(choiceId(i) + "|")) {
                    yieldTurn = -1;
                    return new Choice(selected.substring(choiceId(i).length() + 1).strip(), "name", null, null, null);
                }
                if (choiceId(i).equals(selected)) {
                    if (choice.kind().equals("pass")) history.pass(actor);
                    else yieldTurn = -1;
                    return choice;
                }
            }
            throw new IllegalArgumentException("This choice is no longer available.");
        } catch (IOException ex) {
            throw new IllegalStateException("Could not exchange the Forge decision.", ex);
        }
    }

    private String choiceId(int index) { return "p" + decision + "_" + index; }
    private String seatId(Player p) { return p == opponent ? "opponent" : "player"; }
    private int seatIndex(Player p) { return p == opponent ? 1 : 0; }
    private String cardId(Card c) { return "c" + c.getId(); }

    static String publicName(Card card) {
        return card.isFaceDown() ? "Face-down card" : card.getName();
    }

    private String phaseName(PhaseType phase) {
        if (phase == null) return "Opening hand";
        return switch (phase) {
            case UNTAP, UPKEEP, DRAW -> "Beginning phase";
            case MAIN1 -> "Precombat main phase";
            case MAIN2 -> "Postcombat main phase";
            case END_OF_TURN, CLEANUP -> "Ending phase";
            default -> "Combat phase";
        };
    }

    private String stepName(PhaseType phase) {
        if (phase == null || phase.isMain()) return "";
        return switch (phase) {
            case UNTAP -> "Untap step";
            case UPKEEP -> "Upkeep step";
            case DRAW -> "Draw step";
            case COMBAT_BEGIN -> "Beginning of combat step";
            case COMBAT_DECLARE_ATTACKERS -> "Declare attackers step";
            case COMBAT_DECLARE_BLOCKERS -> "Declare blockers step";
            case COMBAT_FIRST_STRIKE_DAMAGE -> "Combat damage step (first strike)";
            case COMBAT_DAMAGE -> "Combat damage step";
            case COMBAT_END -> "End of combat step";
            case END_OF_TURN -> "End step";
            case CLEANUP -> "Cleanup step";
            default -> "";
        };
    }

    private Map<String, Object> cardState(Card card) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", cardId(card));
        out.put("name", publicName(card));
        if (card.isToken()) out.put("token", true);
        if (card.getAttachedTo() != null) out.put("attachedTo", cardId(card.getAttachedTo()));
        if (card.getPlayerAttachedTo() != null) out.put("attachedToPlayer", seatId(card.getPlayerAttachedTo()));
        if (card.isFaceDown()) {
            out.put("faceDown", true);
        } else {
            String rules = card.isToken() ? card.getAbilityText() : card.getOracleText();
            out.put("oracleText", rules.replace("\\n", "\n").strip());
            out.put("typeLine", card.getType().toString());
            if (card.isInZone(ZoneType.Battlefield) && card.hasChosenType()) out.put("chosenType", card.getChosenType());
            if (card.isInZone(ZoneType.Battlefield) && card.hasNamedCard()) out.put("namedCards", card.getNamedCards());
            if (card.isInZone(ZoneType.Battlefield) && card.hasChosenColor()) out.put("chosenColors", card.getChosenColors());
            if (!card.getManaCost().isNoCost()) out.put("manaCost", card.getManaCost().toString());
            out.put("setCode", card.getSetCode());
            if (card.getPaperCard() != null) out.put("collectorNumber", card.getPaperCard().getCollectorNumber());
        }
        out.put("tapped", card.isTapped());
        if (card.isCreature()) {
            out.put("power", card.getNetPower());
            out.put("toughness", card.getNetToughness());
            if (card.getDamage() > 0) out.put("damage", card.getDamage());
        }
        if (!card.getCounters().isEmpty()) {
            Map<String, Integer> counters = new LinkedHashMap<>();
            card.getCounters().forEach((type, count) -> counters.put(type.getName(), count));
            out.put("counters", counters);
        }
        Combat combat = phases.getCombat();
        if (combat != null) {
            if (combat.isAttacking(card)) out.put("attacking", true);
            if (combat.getAllBlockers().contains(card)) {
                out.put("blocking", true);
                out.put("target", String.join(", ", combat.getAttackersBlockedBy(card).stream().map(ForgeMatch::publicName).toList()));
            }
        }
        return out;
    }

    static Map<String, Integer> manaByColor(Player player) {
        var amounts = new LinkedHashMap<String, Integer>();
        // ManaPool uses ManaAtom.COLORLESS (32), while colorless card identity uses 0.
        for (byte color : forge.card.mana.ManaAtom.MANATYPES) {
            String symbol = color == forge.card.mana.ManaAtom.COLORLESS ? "C" : forge.card.MagicColor.toShortString(color);
            amounts.put(symbol, player.getManaPool().getAmountOfColor(color));
        }
        return amounts;
    }

    private Map<String, Object> board(Player p, boolean revealHand) {
        var hand = p.getCardsIn(ZoneType.Hand);
        Map<String, Object> board = new LinkedHashMap<>(Map.of("life", p.getLife(), "mana", p.getManaPool().totalMana(),
                "manaByColor", manaByColor(p), "libraryCount", p.getCardsIn(ZoneType.Library).size(), "handCount", hand.size(),
                "hand", revealHand ? hand.stream().map(this::cardState).toList() : List.of(),
                "battlefield", p.getCardsIn(ZoneType.Battlefield).stream().map(this::cardState).toList(),
                "exile", p.getCardsIn(ZoneType.Exile).stream().map(this::cardState).toList(),
                "graveyard", p.getCardsIn(ZoneType.Graveyard).stream().map(this::cardState).toList()));
        for (Card top : p.getTopXCardsFromLibrary(1)) {
            Map<String, Object> visible = new LinkedHashMap<>();
            for (Player viewer : game.getPlayers()) {
                if (top.mayPlayerLook(viewer)) visible.put(seatId(viewer), cardState(top));
            }
            if (!visible.isEmpty()) board.put("libraryTopBySeat", visible);
        }
        return board;
    }

    private static String targetName(GameObject obj) {
        if (obj instanceof SpellAbility spell) return publicName(spell.getHostCard());
        if (obj instanceof Player p) return p.getName();
        return publicName((Card)obj);
    }

    static String targetWithAmount(String name, forge.game.spellability.TargetChoices group, GameObject target) {
        Integer amount = group.getDividedValue(target);
        return amount == null ? name : name + " (" + amount + ")";
    }

    void emit(Player actor, String prompt, List<Choice> choices, boolean finished) throws IOException {
        var stack = new ArrayList<Map<String, Object>>();
        for (var instance : game.getStack()) {
            var out = cardState(instance.getSourceCard());
            var spell = instance.getSpellAbility();
            if (!spell.isSpell()) {
                out.put("id", "s" + instance.getId());
                if (!instance.getSourceCard().isFaceDown()) out.put("description", spell.getStackDescription());
            }
            SpellAbility payment = spell;
            if (spell.isTrigger() && spell.getTrigger().getMode() == forge.game.trigger.TriggerType.Immediate) {
                // Forge records the specific ability that created this reflexive trigger.
                payment = spell.getTrigger().getSpawningAbility();
            }
            if (payment != null && payment.getXManaCostPaid() != null && announcesManaX(payment)) {
                String announcement = "X = " + payment.getXManaCostPaid();
                out.put("description", out.containsKey("description") ? out.get("description") + " (" + announcement + ")" : announcement);
            }
            var targets = new ArrayList<String>();
            for (var group : instance.getSpellAbility().getAllTargetChoices()) {
                for (GameObject t : group) {
                    targets.add(targetWithAmount(targetName(t), group, t));
                }
            }
            if (!targets.isEmpty()) out.put("target", String.join(", ", targets));
            stack.add(out);
        }
        var options = new ArrayList<Map<String, Object>>();
        for (Choice c : choices) {
            Map<String, Object> out = new LinkedHashMap<>();
            String id = choiceId(options.size());
            out.put("id", id);
            if (offersEndTurn(actor, prompt, c)) out.put("endTurnId", id + "_end");
            out.put("label", c.label());
            out.put("kind", c.kind());
            if (c.manaAbility()) out.put("manaAbility", true);
            if (c.cardId() != null) out.put("cardId", c.cardId());
            if (c.seat() != null) out.put("seat", seatId(c.seat()));
            options.add(out);
        }
        Map<String, Object> state = new LinkedHashMap<>(Map.of("stage", finished ? "finished" : "decision", "prompt", prompt,
                "actor", seatId(actor), "active", seatId(phases.getPlayerTurn()), "turn", phases.getTurn(),
                "phase", phaseName(phases.getPhase()), "step", stepName(phases.getPhase()),
                "players", Map.of("player", board(player, true), "opponent", board(opponent, sharedSeats)),
                "stack", stack, "choices", options));
        // Rust retains this snapshot and projects only the selected seat into the WebView.
        state.put("sharedSeats", sharedSeats);
        state.put("priorityStops", Map.of("player", priorityStops[0], "opponent", priorityStops[1]));
        if (finished) history.add(prompt);
        state.put("history", history.entries);
        if (library.candidates() != null) {
            state.put("librarySearch", Map.of("title", prompt, "operation", library.operation(),
                    "cards", library.candidates().stream().map(this::cardState).toList()));
        } else if (revealedHand != null) {
            state.put("librarySearch", Map.of("title", prompt, "operation", "Revealed hand",
                    "cards", revealedHand.stream().map(this::cardState).toList()));
        }
        List<String> revealed = library.takeReveal(actor);
        if (revealed != null) state.put("revealedToYou", revealed);
        state.put("replayState", ForgeReplay.fingerprint(player, opponent));
        var json = new StringWriter();
        new JsonObjectWriter(json, 12).value(NoOpLogger.getInstance(), state);
        System.out.println("GAME_STATE " + json);
        System.out.flush();
    }

    private List<GameObject> targets(SpellAbility ability) {
        var result = new ArrayList<GameObject>();
        var restrictions = ability.getTargetRestrictions();
        if (restrictions.getZone().contains(ZoneType.Stack)) {
            for (var entry : game.getStack()) {
                var spell = entry.getSpellAbility();
                if (ability.canTarget(spell)) result.add(spell);
            }
        }
        for (var entity : restrictions.getAllCandidates(ability)) {
            if (entity instanceof Card card && card.isInZone(ZoneType.Stack)) continue;
            if (ability.canTarget(entity)) result.add(entity);
        }
        return result;
    }

    private boolean hasTargets(SpellAbility root, Player actor) {
        for (var sa = root; sa != null; sa = sa.getSubAbility()) {
            sa.setActivatingPlayer(actor);
            if (sa.usesTargeting() && targets(sa).size() < sa.getMinTargets()) return false;
        }
        if (root.getApi() == forge.game.ability.ApiType.Charm) {
            return forge.game.ability.effects.CharmEffect.makePossibleOptions(root).stream().anyMatch(sa -> hasTargets(sa, actor));
        }
        return true;
    }

    private void selectTargets(SpellAbility root, Player actor) {
        for (var sa = root; sa != null; sa = sa.getSubAbility()) {
            if (!sa.usesTargeting()) continue;
            sa.setActivatingPlayer(actor);
            // This also initializes the total to distribute after X has been announced.
            sa.clearTargets();
            if (!pickTargets(sa, actor)) throw new IllegalStateException("Forge rejected the selected targets.");
        }
    }

    private Choice targetChoice(GameObject target, Runnable select) {
        String anchor = target instanceof Card c ? cardId(c) : null;
        if (target instanceof SpellAbility spell) {
            for (var entry : game.getStack()) {
                if (entry.getSpellAbility() == spell) {
                    anchor = spell.isSpell() ? cardId(entry.getSourceCard()) : "s" + entry.getId();
                    break;
                }
            }
        }
        return new Choice("Target " + targetName(target), "target", anchor, target instanceof Player p ? p : null, select);
    }

    private boolean pickTargets(SpellAbility ability, Player actor) {
        int max = ability.getMaxTargets();
        if (ability.isDividedAsYouChoose()) max = Math.min(max, ability.getDividedValue());
        while (ability.getTargets().size() < max) {
            List<Choice> choices = new ArrayList<>();
            for (GameObject target : targets(ability)) {
                if (ability.getTargets().contains(target)) continue;
                choices.add(targetChoice(target, () -> ability.getTargets().add(target)));
            }
            if (choices.isEmpty()) break;
            Choice done = choice("Confirm targets", "option", null, null, null);
            if (ability.isTargetNumberValid()) choices.add(done);
            Choice selected = ask(actor, "Choose a target for " + publicName(ability.getHostCard()), choices);
            if (selected == done) break;
            selected.run();
        }
        if (!ability.isTargetNumberValid()) return false;
        if (ability.isDividedAsYouChoose()) allocateTargets(ability, actor);
        return true;
    }

    private void allocateTargets(SpellAbility ability, Player actor) {
        var selected = ability.getTargets();
        for (int index = 0; index < selected.size(); index++) {
            GameObject target = selected.get(index);
            int remaining = ability.getStillToDivide();
            int later = selected.size() - index - 1;
            int maximum = remaining - later;
            if (later == 0 || maximum == 1) {
                ability.addDividedAllocation(target, maximum);
                continue;
            }
            String prompt = "Divide " + publicName(ability.getHostCard()) + " — amount for " + targetName(target);
            ability.addDividedAllocation(target, chooseAllocation(actor, prompt, maximum));
        }
    }

    private int chooseAllocation(Player actor, String prompt, int maximum) {
        int low = 1, high = maximum;
        // A divided X spell can announce a much larger amount than fits in one menu.
        while (high - low >= 16) {
            int middle = low + (high - low) / 2;
            Choice lower = choice("Assign " + low + "–" + middle, "option", null, null, null);
            Choice upper = choice("Assign " + (middle + 1) + "–" + high, "option", null, null, null);
            if (ask(actor, prompt, List.of(lower, upper)) == lower) high = middle;
            else low = middle + 1;
        }
        List<Choice> choices = new ArrayList<>();
        for (int offset = 0; offset <= high - low; offset++) {
            choices.add(choice("Assign " + (low + offset), "option", null, null, null));
        }
        return low + choices.indexOf(ask(actor, prompt, choices));
    }

    private static boolean announcesManaX(SpellAbility ability) {
        if (ability.getPayCosts() == null || !ability.costHasManaX()) return false;
        String x = ability.getSVar("X");
        return x.isEmpty() || x.equals("Count$xPaid");
    }

    private final class Controller extends PlayerControllerAi {
        private final Player seat;
        private Boolean keepAfterRedraw;
        private SpellAbility manualMana;
        private CardCollection shownForChoice;

        Controller(Game match, Player seat, LobbyPlayerAi lobby) {
            super(match, seat, lobby);
            this.seat = seat;
        }

        @Override
        public boolean isAI() {
            // AI strategy deliberately saves targeted creatures from tapping to pay for a pump
            // spell. A human choosing that target can legally pay with the same mana creature.
            return !human(seat);
        }

        private boolean keep(int bottom) {
            mulligans[seatIndex(seat)] = bottom;
            var keep = choice("Keep hand", "option", null, null, null);
            if (bottom >= seat.getMaxHandSize()) return true;
            var redraw = choice("Mulligan", "option", null, null, null);
            String prompt = bottom == 0 ? "Keep this hand?" : "Keep this hand and put " + bottom + " on the bottom?";
            boolean kept = ask(seat, prompt, List.of(keep, redraw)) == keep;
            if (kept) history.add(seat.getName() + " kept their hand.");
            return kept;
        }

        @Override
        public boolean mulliganKeepHand(Player first, int count) {
            boolean answer = !human(seat) || (keepAfterRedraw == null ? keep(count) : keepAfterRedraw);
            keepAfterRedraw = null;
            keptHands[seatIndex(seat)] = answer;
            return answer;
        }

        @Override
        public CardCollectionView tuckCardsViaMulligan(CardCollectionView hand, int count) {
            // In 2.0.13 the London service asks for bottom cards immediately
            // after each redraw, before its next keep callback.
            keepAfterRedraw = keep(count);
            if (!keepAfterRedraw) return CardCollection.EMPTY;
            var picked = new CardCollection();
            openingBottom.put(seat, picked);
            try {
                pickCards(hand, count, count, "Bottom", "Choose a card for the bottom of your library", picked);
                // The London service tucks these immediately, before asking the other seat.
                keptHands[seatIndex(seat)] = true;
                return picked;
            } finally {
                openingBottom.remove(seat);
            }
        }

        @Override
        public List<SpellAbility> chooseSaToActivateFromOpeningHand(List<SpellAbility> available) {
            if (!human(seat)) return super.chooseSaToActivateFromOpeningHand(available);
            var remaining = new ArrayList<>(available);
            var selected = new ArrayList<SpellAbility>();
            while (!remaining.isEmpty()) {
                var options = new ArrayList<Choice>();
                for (var ability : remaining) {
                    var card = ability.getHostCard();
                    options.add(choice("Use " + publicName(card), "card", card, null, null));
                }
                var done = choice("Finish opening hand actions", "option", null, null, null);
                options.add(done);
                var chosen = ask(seat, "Choose opening hand actions in the order to perform them", options);
                if (chosen == done) break;
                selected.add(remaining.remove(options.indexOf(chosen)));
            }
            return selected;
        }

        @Override
        public CardCollectionView chooseCardsToDiscardToMaximumHandSize(int count) {
            if (!human(seat)) return super.chooseCardsToDiscardToMaximumHandSize(count);
            return pickCards(seat.getCardsIn(ZoneType.Hand), count, "Discard", "Discard to your maximum hand size");
        }

        @Override
        public CardCollection chooseCardsToDiscardFrom(Player owner, SpellAbility effect, CardCollection eligible,
                int min, int max, CardCollectionView shown) {
            if (!human(seat)) return super.chooseCardsToDiscardFrom(owner, effect, eligible, min, max, shown);
            if (seat == owner && min >= eligible.size()) return new CardCollection(eligible);
            // Forge supplies the cards this chooser may see separately from those they may select.
            revealedHand = seat == owner ? null : shown;
            try {
                return pickCards(eligible, min, max, "Discard", effect.getHostCard().getName()
                        + " — Choose from " + owner.getName() + "'s hand");
            } finally {
                revealedHand = null;
            }
        }

        @Override
        public CardCollectionView choosePermanentsToSacrifice(SpellAbility effect, int min, int max,
                CardCollectionView eligible, String type) {
            if (!human(seat)) return super.choosePermanentsToSacrifice(effect, min, max, eligible, type);
            if (min >= eligible.size()) return new CardCollection(eligible);
            return pickCards(eligible, min, max, "Sacrifice",
                    effect.getHostCard().getName() + " — Choose permanents to sacrifice");
        }

        @Override
        public CardCollectionView chooseCardsForEffect(CardCollectionView cards, SpellAbility effect, String title,
                int min, int max, boolean optional, Map<String, Object> params) {
            if (!human(seat)) return super.chooseCardsForEffect(cards, effect, title, min, max, optional, params);
            if (optional && min > 1 && !cards.isEmpty()) {
                var select = choice("Choose cards", "option", null, null, null);
                var decline = choice("Decline", "option", null, null, null);
                if (ask(seat, title, List.of(select, decline)) == decline) return CardCollection.EMPTY;
            }
            int required = optional && min == 1 ? 0 : min;
            if (required >= cards.size()) return cards;
            if (effect.getApi() == forge.game.ability.ApiType.TwoPiles) {
                return library.showCards("Separate piles", cards, () -> pickCards(cards, required, max, "Choose", title));
            }
            return pickCards(cards, required, max, "Choose", effect.getHostCard().getName() + " — " + title);
        }

        @Override
        public boolean chooseCardsPile(SpellAbility effect, CardCollectionView first, CardCollectionView second, String faceDown) {
            if (!human(seat)) return super.chooseCardsPile(effect, first, second, faceDown);
            boolean hideBoth = faceDown.equals("True");
            boolean hideFirst = faceDown.equals("One") || hideBoth;
            var a = choice(pileLabel("First", first, hideFirst), "option", null, null, null);
            var b = choice(pileLabel("Second", second, hideBoth), "option", null, null, null);
            return ask(seat, "Choose a pile for " + publicName(effect.getHostCard()), List.of(a, b)) == a;
        }

        @Override
        public void tempShowCards(Iterable<Card> cards) {
            super.tempShowCards(cards);
            if (human(seat)) shownForChoice = new CardCollection(cards);
        }

        @Override
        public void endTempShowCards() {
            shownForChoice = null;
            super.endTempShowCards();
        }

        @Override
        public void notifyOfValue(SpellAbility effect, GameObject related, String message) {
            super.notifyOfValue(effect, related, message);
            // DigEffect skips the card picker when every card misses its filter. The controller still
            // gets to look. Only reconstruct a look at this player's own top cards, before Forge moves them.
            if (human(seat) && effect != null && effect.getActivatingPlayer() == seat
                    && effect.getApi() == forge.game.ability.ApiType.Dig && !effect.usesTargeting()
                    && "You".equals(effect.getParamOrDefault("Defined", "You"))
                    && "Library".equals(effect.getParamOrDefault("SourceZone", "Library"))
                    && !effect.hasParam("Chooser") && !effect.hasParam("NoLooking") && !effect.hasParam("FromBottom")
                    && message.equals(Localizer.getInstance().getMessage("lblNoValidCards"))) {
                int count = forge.game.ability.AbilityUtils.calculateAmount(effect.getHostCard(), effect.getParam("DigNum"), effect);
                library.revealTo(seat, seat.getTopXCardsFromLibrary(count));
            }
        }

        @Override
        public <T extends forge.game.GameEntity> List<T> chooseEntitiesForEffect(forge.util.collect.FCollectionView<T> eligible,
                int min, int max, forge.game.player.DelayedReveal reveal, SpellAbility effect, String title,
                Player related, Map<String, Object> params) {
            if (!human(seat) || effect == null || effect.getApi() != forge.game.ability.ApiType.Dig
                    || !eligible.allMatch(Card.class::isInstance)) {
                return super.chooseEntitiesForEffect(eligible, min, max, reveal, effect, title, related, params);
            }
            if (reveal != null) reveal(reveal);
            if (min >= eligible.size()) return List.copyOf(eligible);
            var cards = new CardCollection(eligible.stream().map(Card.class::cast).toList());
            // Looking at four cards and being allowed to take two of them are distinct permissions.
            var shown = shownForChoice == null ? cards : shownForChoice;
            var selected = library.showCards("Look at cards", shown,
                    () -> pickCards(cards, min, max, "Choose", publicName(effect.getHostCard()) + " — " + title));
            return selected.stream().map(c -> eligible.get(eligible.indexOf(c))).toList();
        }

        @Override
        public CardCollectionView orderMoveToZoneList(CardCollectionView cards, ZoneType zone, SpellAbility effect) {
            if (human(seat) && zone == ZoneType.Library && effect != null && effect.getApi() == forge.game.ability.ApiType.Dig) {
                return library.orderLibraryMoves(seat, cards);
            }
            return super.orderMoveToZoneList(cards, zone, effect);
        }

        private String pileLabel(String position, CardCollectionView cards, boolean hidden) {
            String count = cards.size() + (cards.size() == 1 ? " card" : " cards");
            if (hidden) return position + " pile (face down, " + count + ")";
            return position + " pile (" + count + ")"
                    + (cards.isEmpty() ? "" : " — " + String.join(", ", cards.stream().map(Card::getName).toList()));
        }

        private CardCollection pickCards(CardCollectionView available, int count, String verb, String prompt) {
            return pickCards(available, count, count, verb, prompt);
        }

        private CardCollection pickCards(CardCollectionView available, int min, int max, String verb, String prompt) {
            return pickCards(available, min, max, verb, prompt, new CardCollection());
        }

        private CardCollection pickCards(CardCollectionView available, int min, int max, String verb, String prompt, CardCollection picked) {
            int limit = Math.min(max, available.size());
            while (picked.size() < limit) {
                List<Choice> choices = new ArrayList<>();
                for (Card c : available) {
                    if (!picked.contains(c)) choices.add(choice(verb + " " + publicName(c), "card", c, null, () -> picked.add(c)));
                }
                var done = choice("Finish selection", "option", null, null, null);
                if (picked.size() >= min) choices.add(done);
                String progress = prompt + " (" + (picked.size() + 1) + " of " + limit + ")";
                if (!picked.isEmpty()) progress += " — Selected " + String.join(", ", picked.stream().map(ForgeMatch::publicName).toList());
                var selected = ask(seat, progress, choices);
                if (selected == done) break;
                selected.run();
            }
            return picked;
        }

        private boolean hasChosenCost(SpellAbility play) {
            return play.getPayCosts() != null && play.getPayCosts().getCostParts().stream().anyMatch(part ->
                    !part.payCostFromSource() && (part instanceof forge.game.cost.CostDiscard || part instanceof forge.game.cost.CostSacrifice
                            || part instanceof forge.game.cost.CostTapType));
        }

        @Override
        public forge.game.cost.CostDecisionMakerBase getCostDecisionMaker(Player payer, SpellAbility ability, boolean effect, String prompt) {
            if (!human(payer)) return super.getCostDecisionMaker(payer, ability, effect, prompt);
            return new forge.ai.AiCostDecision(payer, ability, effect) {
                private forge.game.cost.PaymentDecision payWithCards(forge.game.cost.CostPart part, ZoneType zone, String verb) {
                    var cards = forge.game.card.CardLists.getValidCards(payer.getCardsIn(zone), part.getType().split(";"),
                            payer, ability.getHostCard(), ability);
                    cards.removeIf(c -> zone == ZoneType.Hand ? !c.canBeDiscardedBy(ability, effect) : !c.canBeSacrificedBy(ability, effect));
                    int count = part.getAbilityAmount(ability);
                    if (count > cards.size()) return null;
                    var chosen = count == cards.size() ? cards : pickCards(cards, count, verb,
                            ability.getHostCard().getName() + " — Choose cards to pay the cost");
                    return forge.game.cost.PaymentDecision.card(chosen);
                }

                @Override public forge.game.cost.PaymentDecision visit(forge.game.cost.CostDiscard part) {
                    if (part.payCostFromSource() || Set.of("Hand", "Random", "LastDrawn").contains(part.getType())
                            || part.getType().contains("+With")) return super.visit(part);
                    return payWithCards(part, ZoneType.Hand, "Discard");
                }

                @Override public forge.game.cost.PaymentDecision visit(forge.game.cost.CostSacrifice part) {
                    if (part.payCostFromSource() || part.getType().equals("OriginalHost") || part.getAmount().equals("All")
                            || part.getType().contains("+With")) return super.visit(part);
                    return payWithCards(part, ZoneType.Battlefield, "Sacrifice");
                }

                @Override public forge.game.cost.PaymentDecision visit(forge.game.cost.CostTapType part) {
                    String type = part.getType();
                    if (part.payCostFromSource() || type.equals("OriginalHost") || type.contains(".sharesCreatureTypeWith")
                            || type.contains("+withTotalPowerGE")) return super.visit(part);
                    var cards = forge.game.card.CardLists.getValidCards(payer.getCardsIn(ZoneType.Battlefield),
                            type.split(";"), payer, ability.getHostCard(), ability);
                    if (!part.canTapSource) cards.remove(ability.getHostCard());
                    var eligible = forge.game.card.CardLists.filter(cards, ability.isCrew()
                            ? forge.game.card.CardPredicates.CAN_CREW : forge.game.card.CardPredicates.CAN_TAP);
                    int count = part.getAbilityAmount(ability);
                    if (count > eligible.size()) return null;
                    var chosen = count == eligible.size() ? eligible : pickCards(eligible, count, "Tap",
                            ability.getHostCard().getName() + " — Choose permanents to tap");
                    return forge.game.cost.PaymentDecision.card(chosen);
                }
            };
        }

        @Override
        public Map<Card, Integer> assignCombatDamage(Card source, CardCollectionView recipients, CardCollectionView attackers,
                int amount, forge.game.GameEntity defender, boolean overrideOrder) {
            if (!human(seat) || !overrideOrder || recipients.isEmpty() || source.hasKeyword("Trample:Planeswalker")
                    || source.hasKeyword("You may assign CARDNAME's combat damage divided as you choose among defending player and/or any number of creatures they control.")) {
                return super.assignCombatDamage(source, recipients, attackers, amount, defender, overrideOrder);
            }
            return ForgeCombat.damage(ForgeMatch.this, seat, source, recipients, attackers, amount, defender);
        }

        @Override
        public void declareAttackers(Player attacking, Combat combat) {
            ForgeCombat.attackers(ForgeMatch.this, attacking, combat);
        }

        @Override
        public void declareBlockers(Player defending, Combat combat) {
            ForgeCombat.blockers(ForgeMatch.this, defending, combat);
        }

        @Override
        public List<SpellAbility> orderSimultaneousSa(List<SpellAbility> abilities) {
            if (abilities.size() < 2) return abilities;
            if (!human(seat)) return super.orderSimultaneousSa(abilities);
            var remaining = new ArrayList<>(abilities);
            var resolutionOrder = new ArrayList<SpellAbility>();
            while (remaining.size() > 1) {
                List<Choice> options = new ArrayList<>();
                for (var ability : remaining) {
                    Card source = ability.getHostCard();
                    String label = "Resolve " + publicName(source);
                    if (!source.isFaceDown()) {
                        var trigger = ability.getTrigger();
                        String text = trigger == null ? ability.getDescription() : trigger.toString(true);
                        if (!text.isBlank()) label += " — " + text;
                    }
                    options.add(choice(label, "option", source, null, null));
                }
                var selected = ask(seat, "Choose which ability resolves next", options);
                resolutionOrder.add(remaining.remove(options.indexOf(selected)));
            }
            resolutionOrder.addAll(remaining);
            // PlayerControllerAi pushes the returned abilities in iteration order.
            java.util.Collections.reverse(resolutionOrder);
            return resolutionOrder;
        }

        @Override
        public void orderAndPlaySimultaneousSa(List<SpellAbility> abilities) {
            if (!human(seat)) {
                super.orderAndPlaySimultaneousSa(abilities);
                return;
            }
            for (var ability : orderSimultaneousSa(abilities)) {
                if (ability.isCopied() && ability.isMayChooseNewTargets()) {
                    // Preserve the copied number of targets and the announced amounts, as
                    // Forge's desktop human controller does when putting a copy on the stack.
                    if (ability.isSpell()) {
                        Card copy = ability.getHostCard();
                        if (copy.isInZone(ZoneType.Stack)) game.getStackZone().add(copy);
                        else ability.setHostCard(game.getAction().moveToStack(copy, ability));
                    }
                    ability.setupNewTargets(seat);
                    game.getStack().add(ability);
                } else if (ability.isTrigger() && !ability.isCopied() && !ability.getAllTargetChoices().isEmpty()) {
                    // The desktop human controller lets Forge set up each target group
                    // and its chooser. The AI controller picks trigger targets internally.
                    forge.game.player.PlaySpellAbility.playSpellAbility(this, seat, ability);
                } else {
                    super.orderAndPlaySimultaneousSa(List.of(ability));
                }
            }
        }

        @Override
        public boolean confirmTrigger(forge.game.trigger.WrappedAbility ability) {
            SpellAbility effect = ability.getWrappedAbility();
            var trigger = ability.getTrigger();
            // Forge 2.0.13 marks this raid trigger optional. The Foundations release notes
            // require the exile and choice after a qualifying attack. Only playing the
            // chosen card is optional. Forge still checks raid on entry and resolution.
            // https://magic.wizards.com/en/news/feature/foundations-release-notes
            if (effect.getHostCard().getName().equals("Strongbox Raider")
                    && trigger.getMode() == forge.game.trigger.TriggerType.ChangesZone
                    && "RaidTest".equals(trigger.getParam("CheckSVar"))
                    && "TrigExile".equals(trigger.getParam("Execute"))) return true;
            if (!human(seat)) return super.confirmTrigger(ability);
            if (seat == effect.getActivatingPlayer() && effect.hasParam("Cost") && effect.getPayCosts() != null) {
                // Forge pays this cost and runs the effect only if the decider accepts.
                // Paying zero can still create a separate "when you do" trigger.
                if (announcesManaX(effect) && effect.getPayCosts().isOnlyManaCost()) return chooseManaX(effect, true);
                if (!effect.getParam("Cost").equals("0")) return offerPayment(effect.getPayCosts(), effect);
            }
            if (!ability.getTrigger().hasParam("OptionalDecider")) return super.confirmTrigger(ability);
            // Forge asks the decider during resolution, after opponents can respond.
            var use = choice("Use ability", "option", null, null, null);
            var decline = choice("Decline", "option", null, null, null);
            return ask(seat, "Use the triggered ability of " + publicName(ability.getHostCard()) + "?",
                    List.of(use, decline)) == use;
        }

        private boolean offerPayment(forge.game.cost.Cost cost, SpellAbility effect) {
            if (!ComputerUtilCost.canPayCost(cost, effect, seat, true)) return false;
            var pay = choice("Pay " + cost.toSimpleString(), "option", null, null, null);
            var decline = choice("Decline", "option", null, null, null);
            return ask(seat, "Pay the cost for " + publicName(effect.getHostCard()) + "?", List.of(pay, decline)) == pay;
        }

        @Override
        public boolean payCostToPreventEffect(forge.game.cost.Cost cost, SpellAbility effect, boolean alreadyPaid,
                forge.util.collect.FCollectionView<Player> payers) {
            if (!human(seat)) return super.payCostToPreventEffect(cost, effect, alreadyPaid, payers);
            if (!offerPayment(cost, effect)) return false;
            return new forge.game.cost.CostPayment(cost, effect).payComputerCosts(getCostDecisionMaker(seat, effect, true, ""));
        }

        @Override
        public List<SpellAbility> chooseSpellAbilitiesForEffect(List<SpellAbility> abilities, SpellAbility effect,
                String prompt, int count, Map<String, Object> params) {
            if (!human(seat)) return super.chooseSpellAbilitiesForEffect(abilities, effect, prompt, count, params);
            var remaining = new ArrayList<>(abilities);
            var chosen = new ArrayList<SpellAbility>();
            while (chosen.size() < count && !remaining.isEmpty()) {
                List<Choice> options = new ArrayList<>();
                for (SpellAbility ability : remaining) {
                    options.add(choice(ability.getDescription(), "option", null, null, null));
                }
                var selected = ask(seat, publicName(effect.getHostCard()) + " — " + prompt, options);
                chosen.add(remaining.remove(options.indexOf(selected)));
            }
            return chosen;
        }

        @Override
        public boolean chooseTargetsFor(SpellAbility ability) {
            if (!human(seat)) return super.chooseTargetsFor(ability);
            return pickTargets(ability, seat);
        }

        @Override
        public forge.game.spellability.TargetChoices chooseNewTargetsFor(SpellAbility spell,
                java.util.function.Predicate<GameObject> restriction, boolean optional) {
            if (!human(seat)) return super.chooseNewTargetsFor(spell, restriction, optional);
            SpellAbility ability = spell instanceof forge.game.trigger.WrappedAbility wrapped ? wrapped.getWrappedAbility() : spell;
            if (!ability.usesTargeting()) return null;
            var original = ability.getTargets();
            var replacement = new forge.game.spellability.TargetChoices();
            for (GameObject old : original) {
                List<Choice> options = new ArrayList<>();
                // Forge considers the other selections in this group when determining
                // legal candidates. Keep the original stack visible until the choice finishes.
                ability.setTargets(replacement);
                try {
                    for (var target : targets(ability)) {
                        if (target.equals(old) || replacement.contains(target) || restriction != null && !restriction.test(target)) continue;
                        options.add(targetChoice(target, () -> replacement.add(target)));
                    }
                } finally {
                    ability.setTargets(original);
                }
                if (optional && !replacement.contains(old)) {
                    options.add(choice("Keep " + targetName(old), "option", null, null, () -> replacement.add(old)));
                }
                if (options.isEmpty()) return null; // A required change with no legal replacement does nothing.
                var restart = choice("Keep original targets", "option", null, null, null);
                if (optional && !replacement.isEmpty() && original.size() > 1) options.add(restart);
                Integer amount = original.getDividedValue(old);
                String prompt = "Choose a new target for " + publicName(ability.getHostCard()) + " in place of " + targetName(old);
                Choice selected = ask(seat, amount == null ? prompt : prompt + " (" + amount + " assigned)", options);
                if (selected == restart) return null;
                selected.run();
                if (amount != null) replacement.addDividedAllocation(replacement.get(replacement.size() - 1), amount);
            }
            ability.setTargets(replacement);
            return replacement;
        }

        private boolean continueManaStop;
        private boolean continueManaResponse;

        private boolean stopForPriority(Player actor) {
            int index = seatIndex(actor);
            String stop = priorityStops[index];
            if (stop.equals("auto")) return false;
            if (stop.equals("full")) return true;
            String step = switch (phases.getPhase()) {
                case UPKEEP -> "upkeep";
                case DRAW -> "draw";
                case MAIN1 -> "precombatMain";
                case COMBAT_BEGIN -> "beginCombat";
                case COMBAT_DECLARE_ATTACKERS -> "afterAttackers";
                case COMBAT_DECLARE_BLOCKERS -> "afterBlockers";
                case COMBAT_FIRST_STRIKE_DAMAGE -> "firstStrikeDamage";
                case COMBAT_DAMAGE -> "combatDamage";
                case COMBAT_END -> "endCombat";
                case MAIN2 -> "postcombatMain";
                case END_OF_TURN -> "endStep";
                default -> "";
            };
            if (!stop.equals("next") && !stop.equals(step)) return false;
            priorityStops[index] = "auto";
            return true;
        }

        @Override
        public List<SpellAbility> chooseSpellAbilityToPlay() {
            // Yield only this player's optional empty-stack windows. A new object on
            // the stack, a chosen action or a requested stop reopens normal decisions.
            if (!game.getStack().isEmpty()) yieldTurn = -1;
            if (!human(seat)) return null;
            if (yieldTurn == phases.getTurn() && phases.isPlayerTurn(seat)) {
                if (priorityStops[seatIndex(seat)].equals("auto")) return null;
                yieldTurn = -1;
            }
            List<Choice> choices = new ArrayList<>();
            Map<Choice, SpellAbility> plays = new java.util.IdentityHashMap<>();
            for (Card card : seat.getCardsIn(ZoneType.Hand)) {
                addZonePlays(card, choices, plays);
            }
            for (Card card : seat.getCardsIn(ZoneType.Battlefield)) {
                for (SpellAbility ability : card.getNonManaAbilities()) {
                    if (ability.isActivatedAbility()) addActivation(card, ability, choices, plays);
                }
            }
            for (Card card : seat.getCardsIn(ZoneType.Graveyard)) {
                addZonePlays(card, choices, plays);
            }
            for (Player owner : game.getPlayers()) {
                for (Card card : owner.getCardsIn(ZoneType.Exile)) {
                    if (!card.mayPlay(seat).isEmpty()) addZonePlays(card, choices, plays);
                }
                for (Card card : owner.getTopXCardsFromLibrary(1)) {
                    if (!card.mayPlay(seat).isEmpty()) addZonePlays(card, choices, plays);
                }
                if (owner != seat) {
                    for (Card card : owner.getCardsIn(ZoneType.Graveyard)) {
                        if (!card.mayPlay(seat).isEmpty()) addZonePlays(card, choices, plays);
                    }
                }
            }
            boolean fullControl = priorityStops[seatIndex(seat)].equals("full");
            boolean stopped = stopForPriority(seat) || continueManaStop;
            continueManaStop = false;
            boolean manaResponse = continueManaResponse || (!stopped && choices.isEmpty() && hasManaResponseToStack());
            continueManaResponse = false;
            boolean ownMain = seat == phases.getPlayerTurn() && phases.getPhase().isMain() && game.getStack().isEmpty();
            if (choices.isEmpty() && !stopped && !manaResponse && !ownMain) return null;
            // Once priority opens, players can sequence all of their legal mana abilities.
            for (Card card : seat.getCardsIn(ZoneType.Battlefield)) {
                for (SpellAbility ability : card.getManaAbilities()) addActivation(card, ability, choices, plays);
            }
            // Keep floated mana visible and spendable until the active player advances.
            if (choices.isEmpty() && !stopped && !(ownMain && seat.getManaPool().totalMana() > 0)) return null;
            choices.add(choice("Pass priority", "pass", null, null, null));
            Choice selected = ask(seat, stopped ? PRIORITY_STOP_PROMPT : "Choose a play", choices);
            var play = plays.get(selected);
            // Floating mana does not pass priority. A one-shot stop must leave room
            // to activate a second mana source and actually spend the floated mana.
            continueManaStop = stopped && !fullControl && play != null && play.isManaAbility();
            continueManaResponse = manaResponse && play != null && play.isManaAbility();
            return play == null ? null : List.of(play);
        }

        private boolean hasManaResponseToStack() {
            if (game.getStack().isEmpty()) return false;
            SpellAbility top = game.getStack().peekAbility();
            if (top instanceof forge.game.trigger.WrappedAbility wrapped) top = wrapped.getWrappedAbility();
            for (var effect = top; effect != null; effect = effect.getSubAbility()) {
                if (effect.getApi() == forge.game.ability.ApiType.DestroyAll && massDestructionAffectsManaSource(effect)) return true;
                if (!effect.usesTargeting()) continue;
                // A hostile spell can remove a mana ability as well as the permanent itself.
                // For the player's own effects, save the window before removal or tap/untap.
                if (top.getActivatingPlayer() == seat && (effect.getApi() == null || !switch (effect.getApi()) {
                    case Destroy, ChangeZone, DealDamage, Fight, GainControl, Tap, Untap, TapOrUntap -> true;
                    default -> false;
                })) continue;
                for (Card target : effect.getTargets().getTargetCards()) {
                    Card current = game.getCardState(target);
                    if (current == null || !target.equalsWithGameTimestamp(current) || !current.isInPlay()
                            || current.getController() != seat) continue;
                    if (current.getManaAbilities().stream().anyMatch(this::canOfferPlay)) return true;
                }
            }
            return false;
        }

        private boolean massDestructionAffectsManaSource(SpellAbility effect) {
            // Match Forge's DestroyAllEffect target-player scope and ValidCards filter on the current battlefield.
            var targetPlayer = effect.getTargets().getFirstTargetedPlayer();
            if (targetPlayer != null && targetPlayer != seat) return false;
            String valid = effect.getParamOrDefault("ValidCards", "");
            if (valid.contains("X")) {
                int x = forge.game.ability.AbilityUtils.calculateAmount(effect.getHostCard(), "X", effect);
                valid = valid.replace("X", Integer.toString(x));
            }
            var affected = forge.game.ability.AbilityUtils.filterListByType(seat.getCardsIn(ZoneType.Battlefield), valid, effect);
            return affected.stream().anyMatch(card -> card.canBeDestroyed() && card.getManaAbilities().stream().anyMatch(this::canOfferPlay));
        }

        @Override
        public <T extends forge.game.GameEntity> T chooseSingleEntityForEffect(
                forge.util.collect.FCollectionView<T> candidates, forge.game.player.DelayedReveal reveal,
                SpellAbility effect, String title, boolean optional, Player related, Map<String, Object> params) {
            boolean playEffect = effect != null && effect.getApi() == forge.game.ability.ApiType.Play;
            if (!human(seat) || effect == null || !playEffect && effect.getApi() != forge.game.ability.ApiType.ChooseCard) {
                return super.chooseSingleEntityForEffect(candidates, reveal, effect, title, optional, related, params);
            }
            if (reveal != null) reveal(reveal);
            if (candidates.isEmpty()) return null;
            if (!optional && candidates.size() == 1) return candidates.getFirst();
            var choices = new ArrayList<Choice>();
            for (T candidate : candidates) {
                Card card = (Card) candidate; // Both effects supply their filtered card candidates.
                choices.add(choice((playEffect ? "Play " : "Choose ") + publicName(card), "card", card, null, null));
            }
            var skip = choice("Decline", "option", null, null, null);
            if (optional) choices.add(skip);
            String prompt = title == null || title.isBlank() ? "Choose a card" : title;
            Choice selected = ask(seat, publicName(effect.getHostCard()) + " — " + prompt, choices);
            return selected == skip ? null : candidates.get(choices.indexOf(selected));
        }

        @Override
        public SpellAbility getAbilityToPlay(Card card, List<SpellAbility> routes, forge.util.ITriggerEvent event) {
            if (!human(seat) || routes.size() < 2) return super.getAbilityToPlay(card, routes, event);
            var options = new ArrayList<Choice>();
            for (SpellAbility route : routes) {
                options.add(choice(route.toString(), "option", card, null, null));
            }
            return routes.get(options.indexOf(ask(seat, "Choose how to play " + publicName(card), options)));
        }

        @Override
        public boolean playSaFromPlayEffect(SpellAbility spell) {
            if (!human(seat)) return super.playSaFromPlayEffect(spell);
            // PlayEffect has already granted permission and supplied the casting cost.
            // The same Forge flow used by its desktop human controller obtains targets
            // and additional payments while the original effect is still resolving.
            return forge.game.player.PlaySpellAbility.playSpellAbility(this, seat, spell);
        }

        private void addZonePlays(Card card, List<Choice> choices, Map<Choice, SpellAbility> plays) {
            ZoneType zone = card.getZone().getZoneType();
            // Each route carries its own payment and zone permission. In particular, the
            // chosen Muldrotha route consumes the allowance for that permanent type.
            for (SpellAbility ability : card.getAllPossibleAbilities(seat, true)) {
                if (ability.isLandAbility() || ability.isSpell()) {
                    String verb = ability.isLandAbility() ? "Play " : ability.isFlashback() ? "Flashback " : "Cast ";
                    String label = verb + publicName(card);
                    if (zone != ZoneType.Hand) label += " from " + zone.name().toLowerCase(java.util.Locale.ROOT);
                    if (ability.getMayPlay() != null) {
                        var source = ability.getMayPlay();
                        label += " via " + publicName(source.getHostCard());
                        if (source.hasParam("MayPlayText")) label += " (" + source.getParam("MayPlayText") + ")";
                    }
                    var base = ability.copy();
                    base.setActivatingPlayer(seat);
                    for (var route : forge.game.GameActionUtil.getAdditionalCostSpell(base)) {
                        boolean showCost = !route.isLandAbility() && (zone != ZoneType.Hand || !route.isBasicSpell() || route.getMayPlay() != null);
                        String cost = showCost ? route.getPayCosts().toSimpleString() : "";
                        addPlay(card, route, showCost ? label + " (" + (cost.isBlank() ? "{0}" : cost) + ")" : label, choices, plays);
                        // A timing-granting payment must be considered before discarding a
                        // creature spell that cannot be cast at this priority for its base cost.
                        if (route.isSpell() && card.hasStartOfKeyword("MayFlashCost")) {
                            for (var extra : forge.game.GameActionUtil.getOptionalCostValues(route)) {
                                if (extra.getType() != forge.game.spellability.OptionalCost.Flash) continue;
                                var flash = forge.game.GameActionUtil.addOptionalCosts(route, List.of(extra));
                                addPlay(card, flash, label + " with flash (" + flash.getPayCosts().toSimpleString() + ")", choices, plays);
                            }
                        }
                    }
                } else if (ability.isActivatedAbility() && !ability.isManaAbility() && card.getOwner() == seat) {
                    addActivation(card, ability, choices, plays);
                }
            }
        }

        private void addPlay(Card card, SpellAbility sa, String label, List<Choice> choices, Map<Choice, SpellAbility> plays) {
            if (!canOfferPlay(sa)) return;
            String kind = sa.isActivatedAbility() && !sa.isLandAbility() ? "ability" : "card";
            Choice c = new Choice(label, kind, cardId(card), null, null, sa.isManaAbility());
            choices.add(c);
            plays.put(c, sa);
        }

        private boolean canOfferPlay(SpellAbility sa) {
            sa.setActivatingPlayer(seat);
            return sa.canPlay() && (!sa.isActivatedAbility() || sa.checkRestrictions(seat))
                    && (sa.isLandAbility() || canPayWithTargets(sa));
        }

        private void addActivation(Card card, SpellAbility ability, List<Choice> choices, Map<Choice, SpellAbility> plays) {
            // Activation limits and paid costs belong to this Forge ability instance.
            String label = ability.getDescription().replace("CARDNAME", publicName(card)).replace("NICKNAME", publicName(card));
            addPlay(card, ability, label, choices, plays);
        }

        private boolean canPayWithTargets(SpellAbility ability) {
            if (announcesManaX(ability)) return !payableXValues(ability, 0, 1, false).isEmpty();
            return forge.ai.ComputerUtilMana.canPayManaCost(ability, seat, 0, false)
                    && payableAdditionalCosts(ability, false) && hasTargets(ability, seat);
        }

        private boolean payableAdditionalCosts(SpellAbility ability, boolean resolving) {
            // The AI's canPayCost also rejects strategic choices, including spending
            // a planeswalker's last loyalty, sometimes by a coin flip.
            return forge.game.cost.CostPayment.canPayAdditionalCosts(ability.getPayCosts(), ability, resolving, seat);
        }

        private List<Integer> payableXValues(SpellAbility ability, int start, int limit, boolean resolving) {
            // Probe a copy. Activated abilities on permanents are reused across priority windows.
            SpellAbility probe = ability.copy();
            var bounds = forge.game.ability.AbilityUtils.getAnnouncementBounds(probe, "X");
            List<Integer> values = new ArrayList<>();
            for (int x = Math.max(start, bounds.getMinimum()); x <= bounds.getMaximum(); x++) {
                probe.setXManaCostPaid(x);
                if (!forge.ai.ComputerUtilMana.canPayManaCost(probe, seat, x, resolving)) break;
                if (payableAdditionalCosts(probe, resolving) && (resolving || hasTargets(probe, seat))) {
                    values.add(x);
                    if (values.size() == limit) break;
                }
                if (x == bounds.getMaximum()) break;
            }
            return values;
        }

        private boolean chooseManaX(SpellAbility play, boolean optionalPayment) {
            // Show one page at a time even if a mana engine can pay a very large X.
            int pageSize = 10;
            var starts = new ArrayList<>(List.of(0));
            while (true) {
                List<Integer> values = payableXValues(play, starts.get(starts.size() - 1), pageSize + 1, optionalPayment);
                List<Choice> options = new ArrayList<>();
                values.stream().limit(pageSize).forEach(x -> options.add(
                        choice("X = " + x, "option", null, null, () -> play.setXManaCostPaid(x))));
                Choice lower = choice("Lower X values", "option", null, null, null);
                Choice higher = choice("Higher X values", "option", null, null, null);
                Choice decline = choice("Decline", "option", null, null, null);
                if (starts.size() > 1) options.add(lower);
                if (values.size() > pageSize) options.add(higher);
                if (optionalPayment) options.add(decline);
                Choice answer = ask(seat, "Choose X for " + publicName(play.getHostCard()), options);
                if (answer == decline) return false;
                if (answer == higher) starts.add(values.get(pageSize));
                else if (answer == lower) starts.remove(starts.size() - 1);
                else {
                    answer.run();
                    return true;
                }
            }
        }

        @Override
        public List<forge.game.spellability.OptionalCostValue> chooseOptionalCosts(SpellAbility spell,
                List<forge.game.spellability.OptionalCostValue> options) {
            if (!human(seat)) return super.chooseOptionalCosts(spell, options);
            // PlayEffect has already authorized the cast during resolution.
            return pickOptionalCosts(spell, options, true);
        }

        private List<forge.game.spellability.OptionalCostValue> pickOptionalCosts(SpellAbility spell,
                List<forge.game.spellability.OptionalCostValue> options, boolean duringEffect) {
            var selected = new ArrayList<forge.game.spellability.OptionalCostValue>();
            var withCosts = spell;
            for (var extra : options) {
                if (extra.getType() == forge.game.spellability.OptionalCost.Flash) continue; // chosen with the cast timing
                var payable = forge.game.GameActionUtil.addOptionalCosts(withCosts, List.of(extra));
                if ((!duringEffect && !payable.canPlay()) || !canPayWithTargets(payable)) continue;
                var pay = choice(extra.toString(), "option", null, null, null);
                var skip = choice("Skip optional cost", "option", null, null, null);
                if (ask(seat, "Optional cost for " + spell.getHostCard().getName(), List.of(pay, skip)) == pay) {
                    withCosts = payable;
                    selected.add(extra);
                }
            }
            return selected;
        }

        @Override
        public boolean playChosenSpellAbility(SpellAbility sa) {
            if (sa.isLandAbility()) return super.playChosenSpellAbility(sa);
            final var play = sa.isSpell() ? forge.game.GameActionUtil.addOptionalCosts(sa,
                    pickOptionalCosts(sa, forge.game.GameActionUtil.getOptionalCostValues(sa), false)) : sa;
            if (announcesManaX(play)) chooseManaX(play, false);
            if (play.isManaAbility()) {
                manualMana = play;
                play.getManaPart().clearExpressChoice();
            }
            try {
                // ComputerUtil always installs its own AI cost visitor. The normal human
                // cast path asks this controller which cards to spend and Forge pays them.
                boolean played = hasChosenCost(play)
                        ? new forge.game.player.PlaySpellAbility(this, play).playAbility(true, false, false)
                        : ComputerUtil.handlePlayingSpellAbility(seat, play, () -> selectTargets(play, seat));
                if (!played) {
                    throw new IllegalStateException("Forge could not complete the cost or choices for " + play.getHostCard().getName() + ".");
                }
            } finally {
                manualMana = null;
            }
            return true;
        }

        @Override
        public byte chooseColor(String prompt, SpellAbility ability, forge.card.ColorSet colors) {
            if (manualMana == null || ability != manualMana || colors.countColors() <= 1) {
                return super.chooseColor(prompt, ability, colors);
            }
            List<Choice> options = new ArrayList<>();
            List<Byte> masks = new ArrayList<>();
            for (var color : colors) {
                options.add(choice(color.getName(), "manaColor", null, null, null));
                masks.add(color.getColorMask());
            }
            return masks.get(options.indexOf(ask(seat, "Choose mana for " + publicName(ability.getHostCard()), options)));
        }

        @Override
        public forge.card.ColorSet chooseColors(String prompt, SpellAbility ability, int min, int max, forge.card.ColorSet colors) {
            if (!human(seat)) return super.chooseColors(prompt, ability, min, max, colors);
            int mask = 0;
            for (int count = 0; count < Math.min(max, colors.countColors()); count++) {
                List<Choice> options = new ArrayList<>();
                List<Byte> masks = new ArrayList<>();
                for (var color : colors) {
                    if ((color.getColorMask() & mask) == 0) {
                        options.add(choice(color.getName(), "option", null, null, null));
                        masks.add(color.getColorMask());
                    }
                }
                Choice finish = choice("Finish choosing colors", "option", null, null, null);
                if (count >= min) options.add(finish);
                Choice answer = ask(seat, "Choose a color for " + publicName(ability.getHostCard()), options);
                if (answer == finish) break;
                mask |= masks.get(options.indexOf(answer));
            }
            return forge.card.ColorSet.fromMask(mask);
        }

        @Override
        public String chooseCardName(SpellAbility effect, List<forge.card.ICardFace> valid, String message) {
            if (!human(seat)) return super.chooseCardName(effect, valid, message);
            List<Choice> names = valid.stream().map(forge.card.ICardFace::getName).distinct().sorted()
                    .map(name -> choice(name, "option", null, null, null)).toList();
            return names.isEmpty() ? "" : ask(seat, "Choose a card name for " + publicName(effect.getHostCard()), names).label();
        }

        @Override
        public String chooseCardName(SpellAbility effect, java.util.function.Predicate<forge.card.ICardFace> valid,
                String description, String message) {
            if (!human(seat)) return super.chooseCardName(effect, valid, description, message);
            // Only suggest names the player already knows. The lazy-loaded database includes opponents' hidden cards.
            List<String> revealed = library.peekReveal(seat);
            var suggestions = new java.util.TreeSet<String>(revealed);
            for (Card c : seat.getCardsIn(ZoneType.Hand)) suggestions.add(c.getName());
            for (Card c : game.getCardsIn(ZoneType.Battlefield)) if (!c.isFaceDown()) suggestions.add(c.getName());
            List<Choice> options = new ArrayList<>();
            for (String name : suggestions) {
                var face = StaticData.instance().getCommonCards().getFaceByName(name);
                if (face != null && valid.test(face)) options.add(choice(name, "option", null, null, null));
            }
            options.add(choice("Enter a card name", "name", null, null, null));
            String prompt = "Choose a card name for " + publicName(effect.getHostCard());
            while (true) {
                Choice answer = ask(seat, prompt, options);
                if (!answer.kind().equals("name")) return answer.label();
                var face = ForgeNames.face(answer.label());
                if (face != null && valid.test(face)) return face.getName();
                library.repeatReveal(seat, revealed);
                prompt = "That name is unavailable. Choose a card name for " + publicName(effect.getHostCard());
            }
        }

        @Override
        public String chooseSomeType(String type, SpellAbility ability, java.util.Collection<String> valid, boolean optional) {
            if (!human(seat) || valid.isEmpty()) return super.chooseSomeType(type, ability, valid, optional);
            List<Choice> options = new ArrayList<>();
            valid.stream().sorted().forEach(name -> options.add(choice(name, "type", null, null, null)));
            Choice skip = choice("Skip", "option", null, null, null);
            if (optional) options.add(skip);
            String prompt = "Choose a " + type.toLowerCase(java.util.Locale.ROOT) + " type";
            Choice selected = ask(seat, ability == null ? prompt : prompt + " for " + publicName(ability.getHostCard()), options);
            return selected == skip ? null : selected.label();
        }

        @Override
        public Card chooseSingleCardForZoneChange(ZoneType destination, List<ZoneType> origins, SpellAbility effect,
                CardCollection options, forge.game.player.DelayedReveal delayedReveal, String title, boolean optional, Player decider) {
            if (!human(seat)) {
                return super.chooseSingleCardForZoneChange(destination, origins, effect, options, delayedReveal, title, optional, decider);
            }
            if (delayedReveal != null) reveal(delayedReveal);
            if (!origins.contains(ZoneType.Library)) {
                if (options.isEmpty()) return null;
                if (!optional && options.size() == 1) return options.getFirst();
                return pickCards(options, optional ? 0 : 1, 1, "Choose", effect.getHostCard().getName() + " — " + title).stream().findFirst().orElse(null);
            }
            history.add(seat.getName() + " searched a library.");
            return library.choose(seat, effect, options, title, optional);
        }

        @Override
        public List<Card> chooseCardsForZoneChange(ZoneType destination, List<ZoneType> origins, SpellAbility effect,
                CardCollection options, int min, int max, forge.game.player.DelayedReveal delayedReveal, String title, Player decider) {
            if (!human(seat)) {
                return super.chooseCardsForZoneChange(destination, origins, effect, options, min, max, delayedReveal, title, decider);
            }
            if (delayedReveal != null) reveal(delayedReveal);
            if (!origins.contains(ZoneType.Library)) {
                if (min >= options.size()) return options;
                return pickCards(options, min, max, "Choose", effect.getHostCard().getName() + " — " + title);
            }
            history.add(seat.getName() + " searched a library.");
            return library.chooseMany(seat, effect, options, min, max, title);
        }

        @Override
        public boolean confirmAction(SpellAbility effect, forge.game.player.PlayerActionConfirmMode mode, String message,
                List<String> options, Card display, Map<String, Object> params) {
            if (human(seat) && mode == null && effect != null && effect.getApi() == forge.game.ability.ApiType.Animate
                    && effect.hasParam("Optional")) {
                var animate = choice("Animate", "option", null, null, null);
                var decline = choice("Decline", "option", null, null, null);
                return ask(seat, message, List.of(animate, decline)) == animate;
            }
            if (human(seat) && effect != null && effect.getApi() == forge.game.ability.ApiType.Play && display != null && mode == null) {
                var play = choice("Play " + publicName(display), "card", display, null, null);
                var decline = choice("Decline", "option", null, null, null);
                return ask(seat, message, List.of(play, decline)) == play;
            }
            return library.confirmedFinish(effect, mode) || super.confirmAction(effect, mode, message, options, display, params);
        }

        @Override
        public void reveal(CardCollectionView cards, ZoneType zone, Player owner, String message, boolean revealDialog) {
            super.reveal(cards, zone, owner, message, revealDialog);
            // Forge calls this on the actual recipients. Its private search preview uses DelayedReveal instead.
            if (owner != seat) library.revealTo(seat, cards);
        }

        @Override
        public org.apache.commons.lang3.tuple.ImmutablePair<CardCollection, CardCollection> arrangeForScry(CardCollection cards) {
            return human(seat) ? library.arrange(seat, cards, false) : super.arrangeForScry(cards);
        }

        @Override
        public org.apache.commons.lang3.tuple.ImmutablePair<CardCollection, CardCollection> arrangeForSurveil(CardCollection cards) {
            return human(seat) ? library.arrange(seat, cards, true) : super.arrangeForSurveil(cards);
        }

        @Override
        public List<forge.game.spellability.AbilitySub> chooseModeForAbility(SpellAbility sa,
                List<forge.game.spellability.AbilitySub> modes, int min, int max, boolean repeats) {
            List<forge.game.spellability.AbilitySub> chosen = new ArrayList<>();
            while (chosen.size() < max) {
                List<Choice> choices = new ArrayList<>();
                for (var ability : modes) {
                    if ((repeats || !chosen.contains(ability)) && hasTargets(ability, seat)) {
                        String text = ability.getDescription().replace("CARDNAME", sa.getHostCard().getName());
                        choices.add(choice(text, "option", null, null, () -> chosen.add(ability)));
                    }
                }
                var done = choice("Confirm modes", "option", null, null, null);
                if (chosen.size() >= min) choices.add(done);
                if (choices.isEmpty()) return null;
                var selected = ask(seat, "Choose a mode for " + sa.getHostCard().getName(), choices);
                if (selected == done) break;
                selected.run();
            }
            return chosen;
        }
    }
}
