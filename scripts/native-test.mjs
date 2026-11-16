import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
const cargoHome = path.join(root, '.tools', 'cargo');
const local = path.join(cargoHome, 'bin', 'cargo.exe');
if (existsSync(local)) {
  env.CARGO_HOME = cargoHome;
  env.RUSTUP_HOME = path.join(root, '.tools', 'rustup');
  env.PATH = `${path.dirname(local)}${path.delimiter}${env.PATH}`;
}
const child = spawn(existsSync(local) ? local : 'cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', ...process.argv.slice(2)], { cwd: root, env, stdio: 'inherit' });
child.on('error', (error) => { console.error(`Could not run Rust tests: ${error.message}`); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
