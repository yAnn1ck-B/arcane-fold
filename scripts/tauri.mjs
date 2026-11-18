import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };
const localCargo = path.join(root, ".tools", "cargo");
if (existsSync(path.join(localCargo, "bin", "cargo.exe"))) {
  env.CARGO_HOME = localCargo;
  env.RUSTUP_HOME = path.join(root, ".tools", "rustup");
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = [path.join(localCargo, "bin"), env[pathKey]].filter(Boolean).join(path.delimiter);
}
const cli = path.join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
const cliArgs = process.argv.slice(2);
const separator = cliArgs.indexOf("--");
const optionArgs = separator < 0 ? cliArgs : cliArgs.slice(0, separator);
const explicitConfig = optionArgs.some(
  (arg) =>
    arg === "--config" ||
    arg.startsWith("--config=") ||
    arg === "-c" ||
    (arg.startsWith("-c") && arg.length > 2),
);
if (cliArgs[0] === "dev" && !explicitConfig) {
  // Keep existing development progress separate from the production profile.
  cliArgs.splice(
    separator < 0 ? cliArgs.length : separator,
    0,
    "--config",
    path.join(root, "src-tauri", "tauri.dev.conf.json"),
  );
}
const child = spawn(process.execPath, [cli, ...cliArgs], {
  cwd: root,
  env,
  stdio: "inherit",
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
