#!/usr/bin/env python3
"""QA-only real Linux AppImage upgrade. Never receives private signing material."""
import base64
import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
META = json.loads((ROOT / 'qa/linux-payload.json').read_text())
SIGNATURE = (ROOT / 'qa/linux-payload.AppImage.sig').read_text().strip()
IDENTIFIER = 'com.eternalleague.desktop'
TABLES = ['collection', 'decks', 'deck_cards', 'wildcards', 'booster_history', 'league_state', 'progression_operations', 'booster_pack_queue', 'expansion_reward_claims', 'set_booster_balances']


def digest(file):
    value = hashlib.sha256()
    with open(file, 'rb') as source:
        for part in iter(lambda: source.read(1024 * 1024), b''):
            value.update(part)
    return value.hexdigest()


def payload():
    file = Path(os.environ['LINUX_QA_PAYLOAD_DIR']) / META['filename']
    if not file.is_file() or file.stat().st_size != META['bytes'] or digest(file) != META['sha256']:
        raise RuntimeError('The downloaded public CI payload differs from its recorded hash/size.')
    return file


def prepare():
    if sys.platform != 'linux':
        raise RuntimeError('Run this QA only on Linux.')
    file = payload()
    config = json.loads((ROOT / 'src-tauri/tauri.conf.json').read_text())
    updater = config['plugins']['updater']
    if not updater.get('requireSignedVersion') or config['identifier'] != IDENTIFIER:
        raise RuntimeError('The real production updater policy is required.')
    public = base64.b64decode(updater['pubkey']).decode().strip().splitlines()[1]
    signed = base64.b64decode(SIGNATURE).decode()
    trusted = next(line for line in signed.splitlines() if line.startswith('trusted comment:'))
    if [field for field in trusted.split('\t') if field.startswith('version:')] != ['version:0.2.0']:
        raise RuntimeError('The public signature is not bound to version 0.2.0.')
    plain = Path(os.environ['RUNNER_TEMP']) / 'linux-qa-payload.minisig'
    plain.write_text(signed)
    verified = subprocess.run(['minisign', '-Vm', str(file), '-x', str(plain), '-P', public], capture_output=True)
    if verified.returncode:
        raise RuntimeError('Public signature verification of the CI payload failed.')
    patch = {
        'version': '0.1.9', 'identifier': IDENTIFIER,
        'app': {'windows': [{**window, 'title': 'Eternal League - Linux updater QA 0.1.9'} for window in config['app']['windows']]},
        'bundle': {'targets': ['appimage'], 'createUpdaterArtifacts': False},
        'plugins': {'updater': {**updater, 'endpoints': ['http://127.0.0.1:9232/latest.json'], 'dangerousInsecureTransportProtocol': True}},
    }
    Path(os.environ['LINUX_QA_OLD_CONFIG']).write_text(json.dumps(patch, indent=2) + '\n')
    # Instrument only this throwaway old build, never the main branch/tagged app.
    lib = ROOT / 'src-tauri/src/lib.rs'
    source = lib.read_text()
    needle = '        .run(tauri::generate_context!())'
    if source.count(needle) != 1:
        raise RuntimeError('Cannot safely inject the QA-only runtime version witness.')
    source = source.replace(needle, '        .setup(|app| { use tauri::Manager; println!("LINUX_QA_RUNTIME_VERSION={}", app.package_info().version); Ok(()) })\n' + needle)
    lib.write_text(source)
    print('Verified public CI payload/signature and prepared unsigned old 0.1.9 QA build. No private key is present.')


def exercise():
    new_image = payload()
    old_images = list((ROOT / 'src-tauri/target/release/bundle/appimage').glob('*0.1.9*.AppImage'))
    if len(old_images) != 1:
        raise RuntimeError('Exactly one genuinely built old 0.1.9 AppImage is required.')
    old_image = old_images[0]
    probe = ROOT / 'src-tauri/target/release/examples/linux_updater_probe'
    if not probe.is_file():
        raise RuntimeError('The native Linux updater probe has not been built.')
    old_hash = digest(old_image)
    if old_hash == META['sha256']:
        raise RuntimeError('The old and new AppImages must differ.')
    report = {'platform': 'linux-x86_64', 'oldVersion': '0.1.9', 'newVersion': '0.2.0', 'sourceCiRun': META['artifactRun'], 'payloadSha256': META['sha256'], 'oldSha256': old_hash, 'success': False, 'nativeInstaller': True, 'guiAutomation': False}
    report_file = Path(os.environ['LINUX_QA_REPORT'])
    deadline = time.monotonic() + 120
    with tempfile.TemporaryDirectory(prefix='eternal-linux-upgrade-', dir=os.environ['RUNNER_TEMP']) as temporary:
        root = Path(temporary)
        install = root / 'install'
        install.mkdir()
        installed = install / 'EternalLeague.AppImage'
        shutil.copy2(old_image, installed)
        installed.chmod(0o755)
        permissions = installed.stat().st_mode & 0o777
        env = os.environ.copy()
        for key in ['GH_TOKEN', 'GITHUB_TOKEN', 'TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD', 'NODE_AUTH_TOKEN', 'ETERNAL_LEAGUE_PREVIEW_WEEKS']:
            env.pop(key, None)
        for variable, folder in [('HOME','home'), ('XDG_CONFIG_HOME','config'), ('XDG_DATA_HOME','data'), ('XDG_CACHE_HOME','cache'), ('XDG_RUNTIME_DIR','runtime'), ('TMPDIR','tmp')]:
            directory = root / folder
            directory.mkdir(mode=0o700)
            env[variable] = str(directory)
        env.update(APPIMAGE_EXTRACT_AND_RUN='1', WEBKIT_DISABLE_DMABUF_RENDERER='1', LIBGL_ALWAYS_SOFTWARE='1', GDK_BACKEND='x11', LINUX_QA_ROOT=str(root))
        database = Path(env['XDG_CONFIG_HOME']) / IDENTIFIER / 'eternal-league.db'
        cache = Path(env['XDG_CACHE_HOME']) / IDENTIFIER / 'cards' / 'linux-upgrade-marker.png'
        forge = Path(env['HOME']) / '.forge/decks/constructed/Eternal League/LinuxUpgradeFixture.dck'
        mode = {'value':'unavailable'}
        logs = []
        running = None
        output = None

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def do_GET(self):
                if self.client_address[0] != '127.0.0.1' or self.headers.get('Host') != '127.0.0.1:9232':
                    self.send_error(403)
                    return
                if mode['value'] == 'unavailable':
                    self.send_error(503)
                    return
                if self.path == '/latest.json':
                    entry = {'url':'http://127.0.0.1:9232/payload.AppImage', 'signature':SIGNATURE}
                    body = json.dumps({'version':'0.2.0', 'notes':'Isolated Linux signed updater QA', 'platforms':{'linux-x86_64':entry, 'linux-x86_64-appimage':entry}}).encode()
                    self.send_response(200)
                    self.send_header('Content-Type','application/json')
                    self.send_header('Content-Length',str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                elif self.path == '/payload.AppImage':
                    self.send_response(200)
                    self.send_header('Content-Type','application/octet-stream')
                    self.send_header('Content-Length',str(new_image.stat().st_size))
                    self.end_headers()
                    with new_image.open('rb') as file:
                        first = True
                        while True:
                            block = file.read(1024 * 1024)
                            if not block:
                                break
                            if first and mode['value'] == 'tampered':
                                altered = bytearray(block)
                                altered[64] ^= 1
                                block = bytes(altered)
                            first = False
                            self.wfile.write(block)
                else:
                    self.send_error(404)

        server = http.server.ThreadingHTTPServer(('127.0.0.1',9232), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()

        def stop():
            nonlocal running, output
            if running:
                try: os.killpg(running.pid,signal.SIGTERM)
                except ProcessLookupError: pass
                try: running.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    try: os.killpg(running.pid,signal.SIGKILL)
                    except ProcessLookupError: pass
                    running.wait(timeout=2)
                running = None
            if output:
                output.close()
                output = None

        def launch(label, old=False):
            nonlocal running, output, database
            file = root / f'{label}.log'
            logs.append(file)
            output = file.open('wb')
            running = subprocess.Popen([str(installed)], cwd=install, env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            stable = None
            while time.monotonic() < deadline:
                if running.poll() is not None:
                    raise RuntimeError(f'{label} AppImage exited with status {running.returncode}.')
                ready = False
                for candidate in [Path(env['XDG_CONFIG_HOME'])/IDENTIFIER/'eternal-league.db', Path(env['XDG_DATA_HOME'])/IDENTIFIER/'eternal-league.db']:
                    if not candidate.is_file(): continue
                    try:
                        with sqlite3.connect(candidate, timeout=1) as db:
                            rows = db.execute('SELECT version,success FROM _sqlx_migrations ORDER BY version').fetchall()
                            ready = len(rows)==7 and rows[-1]==(7,1)
                        if ready:
                            database = candidate
                            break
                    except sqlite3.Error:
                        pass
                witnessed = not old or 'LINUX_QA_RUNTIME_VERSION=0.1.9' in file.read_text(errors='replace')
                if ready and witnessed:
                    stable = stable or time.monotonic()
                    if time.monotonic()-stable > 1.5:
                        return
                else: stable = None
                time.sleep(.2)
            raise RuntimeError(f'{label} did not reach schema7 and the required runtime version witness.')

        def snapshot():
            with sqlite3.connect(database, timeout=2) as db:
                result = {table:db.execute(f'SELECT * FROM {table} ORDER BY 1,2').fetchall() for table in TABLES}
                result['settings'] = db.execute("SELECT key,value FROM settings WHERE key IN ('app','phase5-signed-upgrade') OR key LIKE 'forge_export:%' ORDER BY key").fetchall()
                if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise RuntimeError('The isolated SQLite fixture lost integrity.')
            return result

        def verify_files():
            if cache.read_bytes() != b'linux-upgrade-artwork-cache-probe' or forge.read_text() != '[metadata]\nName=LinuxUpgradeFixture\n[Main]\n2 Llanowar Elves\n':
                raise RuntimeError('The cache or external Forge deck fixture changed.')

        def invoke_probe(test_mode):
            mode['value'] = test_mode
            command = [str(probe),'--appimage',str(installed),'--config',os.environ['LINUX_QA_OLD_CONFIG'],'--endpoint','http://127.0.0.1:9232/latest.json','--mode',test_mode]
            result = subprocess.run(command, env=env, cwd=ROOT, capture_output=True, text=True, timeout=60)
            if result.returncode:
                raise RuntimeError('Native updater probe failed: '+(result.stderr or result.stdout)[-1500:].replace(str(root),'<isolated>'))
            values = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
            if not values: raise RuntimeError('Native updater probe produced no evidence.')
            return values[-1]

        try:
            launch('old-fresh',old=True)
            stop()
            report['oldRuntimeWitnessed'] = True
            rules = json.loads((ROOT/'src-tauri/league-rules.json').read_text())
            current_period = max(0,(int(time.time())-rules['startedAt'])//604800)
            with sqlite3.connect(database, timeout=2) as db:
                if db.execute('SELECT COUNT(*) FROM collection').fetchone()[0] != 0:
                    raise RuntimeError('The isolated fixture inherited owned cards.')
                db.execute("INSERT INTO cards(id,oracle_id,name,set_code,collector_number,rarity,metadata_json,set_name,type_line,mana_cost,cmc,colors_json,league_eligible) VALUES('qa-elf','qa-elf-oracle','Llanowar Elves','fdn','227','common','{}','Foundations','Creature - Elf Druid','{G}',1,'[\"G\"]',1)")
                db.execute("INSERT INTO collection(card_id,quantity) VALUES('qa-elf',2)")
                db.execute("INSERT INTO decks(id,name) VALUES('linux-upgrade-deck','LinuxUpgradeFixture')")
                db.execute("INSERT INTO deck_cards(deck_id,card_id,section,quantity) VALUES('linux-upgrade-deck','qa-elf','main',2)")
                db.execute("UPDATE wildcards SET quantity=7 WHERE rarity='common'")
                db.execute('INSERT INTO league_state(id,started_at,available_packs,last_claimed_period) VALUES(1,?,3,?)',(rules['startedAt'],current_period))
                db.execute("INSERT INTO booster_pack_queue(id,set_code,source,earned_period,priority,remaining) VALUES('linux-upgrade-packs','fdn','general',0,0,3)")
                db.execute("INSERT INTO booster_history(id,set_code,contents_json) VALUES('linux-upgrade-history','fdn','[]')")
                db.execute("INSERT INTO progression_operations(id,kind,request_json,result_json,created_at) VALUES('linux-upgrade-receipt','craft','{}','{}','2026-11-17T00:00:00Z')")
                db.execute("INSERT INTO settings(key,value) VALUES('phase5-signed-upgrade','preserve-linux-fixture')")
            db.close()
            cache.parent.mkdir(parents=True,exist_ok=True)
            cache.write_bytes(b'linux-upgrade-artwork-cache-probe')
            forge.parent.mkdir(parents=True,exist_ok=True)
            forge.write_text('[metadata]\nName=LinuxUpgradeFixture\n[Main]\n2 Llanowar Elves\n')
            launch('old-seeded',old=True)
            stop()
            before = snapshot()
            verify_files()
            rejected = invoke_probe('tampered')
            if not rejected.get('tamperedRejected') or digest(installed)!=old_hash or snapshot()!=before:
                raise RuntimeError('Tampered updater bytes were not rejected without modifying the old application/data.')
            verify_files()
            report['tamperedRejected'] = True
            installed_result = invoke_probe('good')
            if not installed_result.get('installed') or installed_result.get('currentVersion')!='0.1.9' or installed_result.get('version')!='0.2.0':
                raise RuntimeError('Native updater did not report the real 0.1.9 to 0.2.0 upgrade.')
            if digest(installed)!=META['sha256'] or installed.stat().st_mode & 0o777 != permissions:
                raise RuntimeError('The native installer did not preserve permissions and replace the actual AppImage.')
            report['installedSha256'] = digest(installed)
            report['permissionsPreserved'] = True
            launch('new-signed')
            stop()
            if snapshot()!=before:
                raise RuntimeError('Game data or settings changed after signed installation/relaunch.')
            verify_files()
            report.update(success=True, upgradedLaunched=True, gameDataPreserved=True, settingsPreserved=True, cachePreserved=True, forgeDeckPreserved=True, ownedCards=2, decks=1, wildcards=7, historyRows=1, receiptRows=1, queuedPacks=3)
            print('PASS: actual Linux native signed 0.1.9 to 0.2.0 AppImage replacement, tamper rejection, relaunch, and game/settings/cache/deck preservation.')
        except Exception as error:
            report['error'] = str(error).replace(str(root),'<isolated>')
            for file in logs[-1:]:
                print(file.read_text(errors='replace')[-2500:].replace(str(root),'<isolated>'), file=sys.stderr)
            raise RuntimeError(report['error']) from None
        finally:
            stop()
            server.shutdown()
            report_file.write_text(json.dumps(report,indent=2)+'\n')


if __name__=='__main__':
    try:
        if sys.argv[1:] == ['prepare']: prepare()
        elif sys.argv[1:] == ['exercise']: exercise()
        else: raise RuntimeError('Usage: linux-upgrade-qa.py prepare|exercise')
    except Exception as error:
        print(str(error),file=sys.stderr)
        sys.exit(1)
