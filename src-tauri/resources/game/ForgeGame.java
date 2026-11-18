// Desktop adapter for a saved-deck game. Its inputs are prepared by the native Play command.
class ForgeGame {
    public static void main(String[] args) {
        try {
            Path install = Path.of(args[0]);
            Path scratch = Path.of(args[1]);
            loadForge(install, scratch, true);
            forge.util.MyRandom.setRandom(new java.util.Random(Long.parseLong(args[2])));
            new ForgeMatch(scratch, Files.isRegularFile(scratch.resolve("opponent.dck"))).run();
        } catch (Exception | LinkageError ex) {
            Throwable cause = ex;
            while (cause.getCause() != null) cause = cause.getCause();
            String message = cause.getMessage();
            System.out.println("GAME_ERROR " + (message == null ? cause.getClass().getSimpleName()
                    : message.replace('\n', ' ').replace('\r', ' ')));
            ex.printStackTrace(System.err);
            System.exit(1);
        }
    }
    static void loadForge(Path install, Path scratch, boolean includeTokens) {
        String assets = install.toString() + File.separator;
        // The adapter runs without a desktop window. Supply only the platform
        // hooks required by the headless game and surface unexpected UI requests.
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
        var tokens = includeTokens ? new CardStorageReader(res.resolve("tokenscripts").toString(), null, false) : null;
        new StaticData(new CardStorageReader(res.resolve("cardsfolder").toString(), null, true),
                tokens, null, null, res.resolve("editions").toString(), scratch.resolve("editions").toString(),
                res.resolve("blockdata").toString(), res.resolve("setlookup").toString(),
                "Original Art All Editions", false, false, false, false);
    }

}
