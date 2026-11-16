import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function validateMigrationBytes(bytes, file = 'SQL migration') {
  if (bytes.includes(13)) throw new Error(`${file} contains CR/CRLF line endings. Save SQL migrations with LF only, as required by .gitattributes; SQLx hashes the exact bytes.`);
}

export function checkMigrations(root = projectRoot) {
  const directory = path.join(root, 'src-tauri/migrations');
  const files = readdirSync(directory).filter((file) => file.endsWith('.sql')).sort();
  if (!files.length) throw new Error('No SQL migrations were found.');
  for (const file of files) validateMigrationBytes(readFileSync(path.join(directory, file)), file);
  return files.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(`Validated ${checkMigrations()} canonical LF SQL migrations.`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
