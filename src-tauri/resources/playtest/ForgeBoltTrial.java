import forge.CardStorageReader;
import forge.ImageKeys;
import forge.StaticData;
import forge.ai.ComputerUtil;
import forge.ai.ComputerUtilCost;
import forge.ai.LobbyPlayerAi;
import forge.ai.PlayerControllerAi;
import forge.deck.Deck;
import forge.game.Game;
import forge.game.GameRules;
import forge.game.GameStage;
import forge.game.GameType;
import forge.game.Match;
import forge.game.card.Card;
import forge.game.card.CardFactory;
import forge.game.phase.PhaseHandler;
import forge.game.phase.PhaseType;
import forge.game.player.Player;
import forge.game.player.RegisteredPlayer;
import forge.game.spellability.SpellAbility;
import forge.game.zone.ZoneType;
import forge.gui.GuiBase;
import forge.gui.interfaces.IGuiBase;
import forge.model.FModel;
import forge.util.Lang;
import forge.util.Localizer;
import io.sentry.JsonObjectWriter;
import io.sentry.NoOpLogger;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.StringWriter;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** A fixed, ephemeral match against the locally installed Forge 2.0.13 engine. */
public class ForgeBoltTrial {
    private final Game game;
    private final Player player;
    private final Player opponent;
    private final PhaseHandler phases;
    private SpellAbility spell;
    private String stage = "ready";

    // Only this fixture's two seats are supported. A call to the phase loop is
    // an explicit yield from the current seat; no AI chooses either player's moves.
    private static RegisteredPlayer seat(String name) {
        LobbyPlayerAi lobby = new LobbyPlayerAi(name, Set.of()) {
            @Override
            public Player createIngamePlayer(Game game, int id) {
                Player seat = new Player(getName(), game, id);
                seat.setFirstController(new PlayerControllerAi(game, seat, this) {
                    @Override
                    public List<SpellAbility> chooseSpellAbilityToPlay() {
                        return null; // Forge's controller contract for passing.
                    }
                });
                return seat;
            }
        };
        return new RegisteredPlayer(new Deck(name)).setPlayer(lobby);
    }

    private static void loadForge(Path install, Path scratch) {
        String assets = install.toString() + File.separator;
        // The adapter runs without a desktop window. Supply only the platform
        // hooks required by this fixture and surface unexpected UI requests.
        IGuiBase platform = (IGuiBase) Proxy.newProxyInstance(IGuiBase.class.getClassLoader(),
                new Class<?>[]{IGuiBase.class}, (proxy, method, args) -> switch (method.getName()) {
                    case "getAssetsDir" -> assets;
                    case "isRunningOnDesktop" -> true;
                    case "isLibgdxPort", "isGuiThread", "hasNetGame" -> false;
                    case "getCurrentVersion" -> "2.0.13";
                    default -> throw new UnsupportedOperationException("Unexpected Forge UI request: " + method.getName());
                });
        GuiBase.setInterface(platform);
        GuiBase.setUsingAppDirectory(true); // Ignore any user profile override in the installation.
        Path res = install.resolve("res");
        Localizer.getInstance().initialize("en-US", res.resolve("languages").toString());
        Lang.createInstance("en-US");
        FModel.loadDynamicGamedata(); // Includes the basic land subtypes that grant mana abilities.
        String images = scratch.resolve("images").toString() + File.separator;
        ImageKeys.initializeDirs(images, Map.of(), images, images, images, images, images, images, images);
        new StaticData(new CardStorageReader(res.resolve("cardsfolder").toString(), null, true),
                null, null, null, res.resolve("editions").toString(), scratch.resolve("editions").toString(),
                res.resolve("blockdata").toString(), res.resolve("setlookup").toString(),
                "Original Art All Editions", false, false, false, false);
    }

    private ForgeBoltTrial() {
        game = new Match(new GameRules(GameType.Constructed), List.of(seat("Player"), seat("Opponent")),
                "Lightning Bolt trial").createGame();
        player = game.getPlayers().get(0);
        opponent = game.getPlayers().get(1);
        for (Player seat : game.getPlayers()) {
            seat.setStartingLife(20);
            seat.setLife(20, null);
        }
        for (String name : List.of("Mountain", "Lightning Bolt")) {
            StaticData.instance().attemptToLoadCard(name);
            Card card = CardFactory.getCard(StaticData.instance().getCommonCards().getCard(name), player, game);
            player.getZone(ZoneType.Hand).add(card);
        }
        game.setStartingPlayer(player);
        game.setAge(GameStage.Play);
        phases = game.getPhaseHandler();
        phases.setupFirstTurn(player, null);
        for (int step = 0; step < 20 && phases.getPhase() != PhaseType.MAIN1; step++) {
            phases.mainLoopStep();
        }
        require(phases.is(PhaseType.MAIN1, player) && phases.getPriorityPlayer() == player,
                "Forge did not reach the first main phase.");
    }

    private Card inHand(String name) {
        return player.getCardsIn(ZoneType.Hand).stream().filter(c -> name.equals(c.getName()))
                .findFirst().orElseThrow(() -> new IllegalStateException(name + " is not in hand."));
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new IllegalStateException(message);
    }

    private void act(String action) {
        switch (action) {
            case "playMountain" -> {
                require(stage.equals("ready"), "Play Mountain from the opening hand.");
                Card land = inHand("Mountain");
                require(player.canPlayLand(land, false, null), "Forge rejected the land play.");
                require(player.playLand(land, null) != null, "Forge could not play Mountain.");
                stage = "landPlayed";
            }
            case "castBolt" -> {
                require(stage.equals("landPlayed"), "Play Mountain before casting Lightning Bolt.");
                spell = inHand("Lightning Bolt").getFirstSpellAbility();
                spell.setActivatingPlayer(player);
                require(spell.canPlay(), "Forge rejected Lightning Bolt at this time.");
                require(ComputerUtilCost.canPayCost(spell, player, false), "Forge could not pay for Lightning Bolt.");
                stage = "chooseTarget";
            }
            case "targetOpponent", "targetPlayer" -> {
                require(stage.equals("chooseTarget"), "Choose a target while casting Lightning Bolt.");
                Player target = action.equals("targetOpponent") ? opponent : player;
                require(spell.canTarget(target) && spell.getTargets().add(target) && spell.isTargetNumberValid(),
                        "Forge rejected the selected target.");
                require(ComputerUtil.playStack(spell, player, game), "Forge could not pay for and cast Lightning Bolt.");
                require(game.getStack().size() == 1, "Lightning Bolt did not reach the stack.");
                // The caster yields after casting. The phase handler determines
                // the next seat and whether the spell should resolve.
                phases.mainLoopStep();
                require(phases.getPriorityPlayer() == opponent && game.getStack().size() == 1,
                        "Forge did not offer the opponent priority.");
                stage = "opponentPriority";
            }
            case "passPriority" -> {
                require(stage.equals("opponentPriority") && phases.getPriorityPlayer() == opponent,
                        "The opponent does not have priority.");
                phases.mainLoopStep();
                require(game.getStack().isEmpty() && !player.getCardsIn(ZoneType.Graveyard).isEmpty(),
                        "Forge did not finish resolving Lightning Bolt.");
                stage = "resolved";
            }
            default -> throw new IllegalArgumentException("Unknown trial action.");
        }
    }

    private List<String> names(ZoneType zone) {
        return player.getCardsIn(zone).stream().map(Card::getName).toList();
    }

    private void emit() throws IOException {
        List<String> legalTargets = new ArrayList<>();
        if (stage.equals("chooseTarget")) {
            if (spell.canTarget(player)) legalTargets.add("player");
            if (spell.canTarget(opponent)) legalTargets.add("opponent");
        }
        List<String> stack = new ArrayList<>();
        game.getStack().forEach(entry -> stack.add(entry.getSourceCard().getName()));
        String target = null;
        if (!game.getStack().isEmpty()) {
            SpellAbility top = game.getStack().peekAbility();
            if (top.isTargeting(opponent)) target = "opponent";
            if (top.isTargeting(player)) target = "player";
        }
        Map<String, Object> state = new LinkedHashMap<>();
        state.put("stage", stage);
        state.put("playerLife", player.getLife());
        state.put("opponentLife", opponent.getLife());
        state.put("hand", names(ZoneType.Hand));
        state.put("battlefield", names(ZoneType.Battlefield));
        state.put("opponentBattlefield", opponent.getCardsIn(ZoneType.Battlefield).stream().map(Card::getName).toList());
        state.put("graveyard", names(ZoneType.Graveyard));
        state.put("stack", stack);
        state.put("mountainTapped", player.getCardsIn(ZoneType.Battlefield).stream().anyMatch(Card::isTapped));
        state.put("mana", player.getManaPool().totalMana());
        state.put("legalTargets", legalTargets);
        state.put("target", target);
        var json = new StringWriter();
        new JsonObjectWriter(json, 5).value(NoOpLogger.getInstance(), state);
        System.out.println("BOLT_STATE " + json);
        System.out.flush();
    }

    public static void main(String[] args) {
        try {
            loadForge(Path.of(args[0]), Path.of(args[1]));
            ForgeBoltTrial trial = new ForgeBoltTrial();
            trial.emit();
            var input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
            for (String action; (action = input.readLine()) != null;) {
                trial.act(action);
                trial.emit();
            }
        } catch (Exception | LinkageError ex) {
            Throwable cause = ex;
            while (cause.getCause() != null) cause = cause.getCause();
            String message = cause.getMessage();
            System.out.println("BOLT_ERROR " + (message == null ? cause.getClass().getSimpleName()
                    : message.replace('\n', ' ').replace('\r', ' ')));
            ex.printStackTrace(System.err);
            System.exit(1);
        }
    }
}
