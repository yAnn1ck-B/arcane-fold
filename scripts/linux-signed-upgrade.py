#!/usr/bin/env python3
"""Verification-only Linux upgrade of official artifacts in temporary profiles.

prepare is the only network/authenticated mode. exercise launches applications
with a small environment allowlist, never GitHub or signing credentials.
"""
import argparse
import base64
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
IDENTIFIER = 'com.eternalleague.desktop'
OLD_VERSION = '0.2.1'
OLD_FILENAME = 'Eternal.League_0.2.1_amd64.AppImage'
OLD_SHA256 = '115090fb3757f1940246a7fa7a0f91a7ff2ae42ae3cd1a4a58c582f5a17084ee'
REWARD_LEDGER_KEY = 'league_reward_entitlements_v1'
MAX_BYTES = 512 * 1024 * 1024
TABLES = ['collection', 'decks', 'deck_cards', 'wildcards', 'booster_history',
          'league_state', 'progression_operations', 'booster_pack_queue',
          'expansion_reward_claims', 'set_booster_balances']


def version(value):
    if not isinstance(value, str) or not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', value):
        raise ValueError('Expected an exact stable X.Y.Z version.')
    return tuple(map(int, value.split('.')))


def digest(file):
    value = hashlib.sha256()
    with open(file, 'rb') as source:
        for part in iter(lambda: source.read(1024 * 1024), b''):
            value.update(part)
    return value.hexdigest()


def current_reward_ledger(rules):
    """Seed current entitlement policy for a pure data-preservation fixture.

    Compensation for historical policy is tested separately in native tests and
    Windows QA. It must not race this artifact-only probe's strict snapshots.
    """
    ledger = {'version': 1, 'startingPacks': rules['startingPacks'],
              'weeklyPacks': rules['weeklyPacks'],
              'startingWildcards': {rarity: rules['startingWildcards'][rarity]
                                   for rarity in ['common', 'uncommon', 'rare', 'mythic']}}
    quantities = [ledger['startingPacks'], ledger['weeklyPacks'], *ledger['startingWildcards'].values()]
    if any(type(value) is not int or value < 0 for value in quantities):
        raise ValueError('Current reward entitlements must be nonnegative integer amounts.')
    return ledger


def runner_temp():
    root = Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
    if not root.is_absolute() or root == Path('/') or not root.is_dir():
        raise RuntimeError('RUNNER_TEMP must be an existing isolated runner directory.')
    return root


def prepared_file():
    return runner_temp() / 'linux-signed-upgrade-prepared.json'


def signature_version(encoded, expected):
    try:
        text = base64.b64decode(encoded.strip(), validate=True).decode('utf-8')
    except (ValueError, UnicodeError):
        raise RuntimeError('The public updater signature is malformed.') from None
    trusted = [line for line in text.splitlines() if line.startswith('trusted comment:')]
    if len(trusted) != 1 or [field for field in trusted[0].split('\t') if field.startswith('version:')] != [f'version:{expected}']:
        raise RuntimeError('The updater signature does not bind the expected release version.')


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def public_download_url(url):
    parsed = urlparse(url)
    host = parsed.hostname or ''
    return (parsed.scheme == 'https' and not parsed.username and not parsed.password
            and parsed.port in (None, 443)
            and (host == 'github.com' or host.endswith('.githubusercontent.com')))


def get(url, *, token=None, binary=False, maximum=4 * 1024 * 1024):
    """Follow GitHub binary redirects without forwarding authorization."""
    opener = build_opener(NoRedirect)
    for _ in range(6):
        headers = {'User-Agent': 'Eternal-League-release-verification',
                   'Accept': 'application/octet-stream' if binary else 'application/vnd.github+json',
                   'X-GitHub-Api-Version': '2022-11-28'}
        if token:
            if not url.startswith('https://api.github.com/repos/'):
                raise RuntimeError('Authenticated requests must use the GitHub release API.')
            headers['Authorization'] = f'Bearer {token}'
        try:
            with opener.open(Request(url, headers=headers), timeout=120) as response:
                content = response.read(maximum + 1)
                if len(content) > maximum:
                    raise RuntimeError('Release verification response exceeds its size limit.')
                return content
        except HTTPError as error:
            if error.code not in (301, 302, 303, 307, 308):
                raise RuntimeError(f'Release verification request failed: HTTP {error.code}.') from None
            destination = error.headers.get('Location', '')
            if not binary or not public_download_url(destination):
                raise RuntimeError('Unexpected release asset redirect.') from None
            url, token = destination, None
        except (URLError, TimeoutError, OSError):
            raise RuntimeError('Release verification request could not finish.') from None
    raise RuntimeError('Too many release asset redirects.')


def prepare(args):
    if sys.platform != 'linux':
        raise RuntimeError('This verification runs only on Linux.')
    repository = os.environ.get('GITHUB_REPOSITORY', '')
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise RuntimeError('GITHUB_REPOSITORY must identify this release repository.')
    # The old payload hash is pinned to the actual established public release.
    if repository != 'yAnn1ck-B/eternal-league':
        raise RuntimeError('The pinned historical artifact belongs to the established release repository.')
    new_version = args.tag.removeprefix('v')
    if args.tag != f'v{new_version}' or version(new_version) <= version(OLD_VERSION):
        raise RuntimeError('The new stable tag must be newer than the published old artifact.')
    config = json.loads((ROOT / 'src-tauri/tauri.conf.json').read_text())
    if (config.get('version') != new_version or config.get('identifier') != IDENTIFIER
            or config.get('plugins', {}).get('updater', {}).get('requireSignedVersion') is not True):
        raise RuntimeError('The checked-out production version/updater policy differs from this release.')
    local = args.local_appimage.resolve(strict=True)
    bundle = (ROOT / 'src-tauri/target/release/bundle/appimage').resolve(strict=True)
    if not local.is_relative_to(bundle) or not local.is_file() or local.suffix != '.AppImage':
        raise RuntimeError('The local payload must be the freshly built release AppImage.')
    if not 4 <= local.stat().st_size <= MAX_BYTES:
        raise RuntimeError('The release AppImage has an invalid size.')
    token = os.environ.get('GH_TOKEN') or os.environ.get('GITHUB_TOKEN')
    if not token:
        raise RuntimeError('A download-scoped draft token is required only for prepare.')
    api = f'https://api.github.com/repos/{repository}'
    release = json.loads(get(f'{api}/releases/{args.release_id}', token=token))
    if release.get('id') != args.release_id or release.get('tag_name') != args.tag or release.get('draft') is not True or release.get('prerelease'):
        raise RuntimeError('The payload must belong to the exact unpublished stable draft.')
    assets = json.loads(get(f'{api}/releases/{args.release_id}/assets?per_page=100', token=token))
    candidates = [asset for asset in assets if asset.get('name', '').endswith('.AppImage') and f'_{new_version}_' in asset['name']]
    if len(candidates) != 1:
        raise RuntimeError('Expected one uploaded versioned Linux AppImage.')
    payload = candidates[0]
    signatures = [asset for asset in assets if asset.get('name') == f'{payload["name"]}.sig']
    if len(signatures) != 1 or not 4 <= payload.get('size', 0) <= MAX_BYTES:
        raise RuntimeError('The uploaded Linux payload/signature is incomplete.')
    for asset in [payload, signatures[0]]:
        if not isinstance(asset.get('id'), int) or asset['id'] <= 0 or asset.get('url') != f'{api}/releases/assets/{asset["id"]}':
            raise RuntimeError('Unexpected draft asset API coordinates.')
    directory = Path(tempfile.mkdtemp(prefix='linux-upgrade-payload-', dir=runner_temp()))
    new = directory / 'new.AppImage'
    new.write_bytes(get(payload['url'], token=token, binary=True, maximum=MAX_BYTES))
    new_hash = digest(new)
    if new.stat().st_size != payload['size'] or new_hash != digest(local):
        raise RuntimeError('The downloaded draft AppImage differs from the exact locally built/uploaded payload.')
    if payload.get('digest') and payload['digest'] != f'sha256:{new_hash}':
        raise RuntimeError('The downloaded AppImage differs from GitHub asset SHA-256 metadata.')
    signature = get(signatures[0]['url'], token=token, binary=True, maximum=1024 * 1024).decode('utf-8').strip()
    signature_version(signature, new_version)
    # The release job already generated this file. Verify that the actual public
    # signature attached to the draft is byte-identical, not merely well formed.
    if local.with_suffix(local.suffix + '.sig').read_text().strip() != signature:
        raise RuntimeError('The uploaded signature differs from the freshly generated signature.')
    old = directory / 'old.AppImage'
    old.write_bytes(get(f'https://github.com/{repository}/releases/download/v{OLD_VERSION}/{quote(OLD_FILENAME)}', binary=True, maximum=MAX_BYTES))
    if digest(old) != OLD_SHA256 or old.read_bytes()[:4] != b'\x7fELF':
        raise RuntimeError('The old public AppImage differs from the pinned, previously verified 0.2.1 artifact.')
    metadata = {'schema': 1, 'oldVersion': OLD_VERSION, 'newVersion': new_version,
                'tag': args.tag, 'releaseId': args.release_id, 'assetId': payload['id'],
                'oldImage': str(old), 'newImage': str(new), 'localImage': str(local),
                'oldSha256': OLD_SHA256, 'newSha256': new_hash, 'signature': signature}
    prepared_file().write_text(json.dumps(metadata, indent=2) + '\n')
    print('Prepared actual public old and exact uploaded signed new AppImages; no signing key was used.')


def child_environment(root):
    # Do not pass ambient runner/GitHub/signing credentials to either app or
    # native probe. HOME/XDG/TMPDIR are all owned temporary directories.
    inherited = ['PATH', 'DISPLAY', 'XAUTHORITY', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'LD_LIBRARY_PATH']
    result = {key: os.environ[key] for key in inherited if key in os.environ}
    for key, folder in [('HOME', 'home'), ('XDG_CONFIG_HOME', 'config'),
                        ('XDG_DATA_HOME', 'data'), ('XDG_CACHE_HOME', 'cache'),
                        ('XDG_RUNTIME_DIR', 'runtime'), ('TMPDIR', 'tmp')]:
        directory = root / folder
        directory.mkdir(mode=0o700)
        result[key] = str(directory)
    result.update(APPIMAGE_EXTRACT_AND_RUN='1', WEBKIT_DISABLE_DMABUF_RENDERER='1',
                  LIBGL_ALWAYS_SOFTWARE='1', GDK_BACKEND='x11', LINUX_QA_ROOT=str(root))
    return result


def exercise(args):
    if sys.platform != 'linux':
        raise RuntimeError('This verification runs only on Linux.')
    metadata = json.loads(prepared_file().read_text())
    old, new, local = (Path(metadata[key]).resolve(strict=True) for key in ['oldImage', 'newImage', 'localImage'])
    for image in [old, new]:
        if not image.is_relative_to(runner_temp()):
            raise RuntimeError('Downloaded fixtures must stay inside RUNNER_TEMP.')
    if digest(old) != metadata['oldSha256'] or digest(new) != metadata['newSha256'] or digest(local) != metadata['newSha256']:
        raise RuntimeError('The prepared/frozen artifact hashes changed before the updater probe.')
    signature_version(metadata['signature'], metadata['newVersion'])
    probe = args.probe.resolve(strict=True)
    expected_schema = max(int(file.name.split('_', 1)[0]) for file in (ROOT / 'src-tauri/migrations').glob('[0-9][0-9][0-9]_*.sql'))
    report_file = Path(os.environ.get('LINUX_UPGRADE_REPORT', str(runner_temp() / 'linux-signed-upgrade.json')))
    report = {'platform': 'linux-x86_64', 'oldVersion': metadata['oldVersion'],
              'newVersion': metadata['newVersion'], 'releaseId': metadata['releaseId'],
              'assetId': metadata['assetId'], 'oldSha256': metadata['oldSha256'],
              'payloadSha256': metadata['newSha256'], 'schema': expected_schema,
              'success': False, 'nativeInstaller': True, 'guiAutomation': False,
              'privateSigningMaterialUsed': False,
              'rewardCompensationExercised': False,
              'normalUseVerificationExercised': False,
              'preservationScope': 'Current reward entitlements are pre-recorded; verify native artifact replacement and fixture preservation, not online-gate UI or compensation.'}
    with tempfile.TemporaryDirectory(prefix='eternal-signed-linux-upgrade-', dir=runner_temp()) as temporary:
        root = Path(temporary).resolve()
        install = root / 'install'
        install.mkdir()
        installed = install / 'EternalLeague.AppImage'
        shutil.copy2(old, installed)
        installed.chmod(0o700)
        permissions = installed.stat().st_mode & 0o777
        env = child_environment(root)
        database = None
        cache = Path(env['XDG_CACHE_HOME']) / IDENTIFIER / 'cards/linux-signed-upgrade-marker'
        forge = Path(env['HOME']) / '.forge/decks/constructed/Eternal League/LinuxUpgradeFixture.dck'
        cache_bytes = b'linux-signed-upgrade-artwork-probe'
        forge_text = '[metadata]\nName=LinuxUpgradeFixture\n[Main]\n2 Llanowar Elves\n'
        mode = {'value': 'unavailable'}
        logs = []
        running, output = None, None

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                if self.client_address[0] != '127.0.0.1' or self.headers.get('Host') != f'127.0.0.1:{server.server_address[1]}':
                    self.send_error(403)
                    return
                if mode['value'] == 'unavailable':
                    self.send_error(503)
                    return
                if self.path == '/latest.json':
                    entry = {'url': f'{origin}/payload.AppImage', 'signature': metadata['signature']}
                    body = json.dumps({'version': metadata['newVersion'], 'platforms': {'linux-x86_64': entry, 'linux-x86_64-appimage': entry}}).encode()
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Content-Length', str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                elif self.path == '/payload.AppImage':
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/octet-stream')
                    self.send_header('Content-Length', str(new.stat().st_size))
                    self.end_headers()
                    try:
                        with new.open('rb') as source:
                            first = True
                            while block := source.read(1024 * 1024):
                                if first and mode['value'] == 'tampered':
                                    altered = bytearray(block)
                                    altered[64] ^= 1
                                    block = bytes(altered)
                                first = False
                                self.wfile.write(block)
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                else:
                    self.send_error(404)

        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        origin = f'http://127.0.0.1:{server.server_address[1]}'
        threading.Thread(target=server.serve_forever, daemon=True).start()

        def stop():
            nonlocal running, output
            if running:
                try:
                    os.killpg(running.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    running.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(running.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    running.wait(timeout=3)
                running = None
            if output:
                output.close()
                output = None

        def connection():
            return sqlite3.connect(f'file:{quote(str(database))}?mode=ro', uri=True, timeout=2)

        def launch(label):
            nonlocal running, output, database
            file = root / f'{label}.log'
            logs.append(file)
            output = file.open('wb')
            running = subprocess.Popen([str(installed)], cwd=install, env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            deadline, stable = time.monotonic() + 60, None
            while time.monotonic() < deadline:
                if running.poll() is not None:
                    raise RuntimeError(f'{label} AppImage exited with status {running.returncode}.')
                ready = False
                for folder in ['XDG_CONFIG_HOME', 'XDG_DATA_HOME']:
                    candidate = Path(env[folder]) / IDENTIFIER / 'eternal-league.db'
                    if not candidate.is_file():
                        continue
                    try:
                        with sqlite3.connect(f'file:{quote(str(candidate))}?mode=ro', uri=True, timeout=1) as db:
                            rows = db.execute('SELECT version,success FROM _sqlx_migrations ORDER BY version').fetchall()
                            ready = len(rows) == expected_schema and rows[-1] == (expected_schema, 1)
                        if ready:
                            database = candidate
                            break
                    except sqlite3.Error:
                        pass
                if ready:
                    stable = stable or time.monotonic()
                    if time.monotonic() - stable > 1.5:
                        return
                else:
                    stable = None
                time.sleep(0.2)
            raise RuntimeError(f'{label} did not reach the expected production schema.')

        def snapshot():
            with connection() as db:
                value = {table: db.execute(f'SELECT * FROM {table} ORDER BY 1,2').fetchall() for table in TABLES}
                value['card'] = db.execute("SELECT id,oracle_id,name,set_code,collector_number,rarity FROM cards WHERE id='linux-upgrade-elf'").fetchall()
                value['settings'] = db.execute("SELECT key,value FROM settings WHERE key IN ('linux-signed-upgrade-probe',?) OR key LIKE 'forge_export:%' ORDER BY key", (REWARD_LEDGER_KEY,)).fetchall()
                if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise RuntimeError('The isolated SQLite fixture lost integrity.')
            return value

        def verify_files():
            if cache.read_bytes() != cache_bytes or forge.read_text() != forge_text:
                raise RuntimeError('The cache or external Forge deck fixture changed.')

        def invoke_probe(test_mode):
            mode['value'] = test_mode
            command = [str(probe), '--appimage', str(installed), '--config', str(ROOT / 'src-tauri/tauri.conf.json'),
                       '--endpoint', f'{origin}/latest.json', '--mode', test_mode,
                       '--old-version', metadata['oldVersion'], '--new-version', metadata['newVersion']]
            result = subprocess.run(command, env=env, cwd=ROOT, capture_output=True, text=True, timeout=150)
            if result.returncode:
                raise RuntimeError('Native updater probe failed: ' + (result.stderr or result.stdout)[-1500:].replace(str(root), '<isolated>'))
            values = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
            if not values:
                raise RuntimeError('The native updater probe produced no evidence.')
            return values[-1]

        try:
            launch('official-old-fresh')
            stop()
            report['officialOldLaunched'] = True
            rules = json.loads((ROOT / 'src-tauri/league-rules.json').read_text())
            ledger = current_reward_ledger(rules)
            report['preRecordedRewardEntitlements'] = ledger
            current_period = max(0, (int(time.time()) - rules['startedAt']) // 604800)
            with sqlite3.connect(database, timeout=2) as db:
                for table in ['collection', 'decks', 'deck_cards', 'booster_history', 'progression_operations', 'league_state', 'booster_pack_queue']:
                    if db.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]:
                        raise RuntimeError('The isolated old application inherited game progress.')
                if db.execute('SELECT COALESCE(SUM(quantity),0) FROM wildcards').fetchone()[0]:
                    raise RuntimeError('The isolated old application inherited wildcards.')
                db.execute("INSERT INTO cards(id,oracle_id,name,set_code,collector_number,rarity,metadata_json,set_name,type_line,mana_cost,cmc,colors_json,league_eligible) VALUES('linux-upgrade-elf','linux-upgrade-elf-oracle','Llanowar Elves','fdn','227','common','{}','Foundations','Creature — Elf Druid','{G}',1,'[\"G\"]',1)")
                db.execute("INSERT INTO collection(card_id,quantity) VALUES('linux-upgrade-elf',2)")
                db.execute("INSERT INTO decks(id,name) VALUES('linux-upgrade-deck','LinuxUpgradeFixture')")
                db.execute("INSERT INTO deck_cards(deck_id,card_id,section,quantity) VALUES('linux-upgrade-deck','linux-upgrade-elf','main',2)")
                db.execute("UPDATE wildcards SET quantity=7 WHERE rarity='common'")
                db.execute('INSERT INTO league_state(id,started_at,available_packs,last_claimed_period) VALUES(1,?,3,?)', (rules['startedAt'], current_period))
                db.execute("INSERT INTO booster_pack_queue(id,set_code,source,earned_period,priority,remaining) VALUES('linux-upgrade-packs','fdn','general',0,0,3)")
                db.execute("INSERT INTO booster_history(id,set_code,contents_json) VALUES('linux-upgrade-history','fdn','[]')")
                db.execute("INSERT INTO progression_operations(id,kind,request_json,result_json,created_at) VALUES('linux-upgrade-receipt','craft','{}','{}','2026-11-17T00:00:00Z')")
                db.execute("INSERT INTO settings(key,value) VALUES('linux-signed-upgrade-probe','preserve-official-linux-upgrade-fixture')")
                # The published old application ignores this additive key. The
                # candidate sees no policy top-up due, so the timing of its
                # mandatory online verification cannot alter this fixture.
                db.execute('INSERT INTO settings(key,value) VALUES(?,?)',
                           (REWARD_LEDGER_KEY, json.dumps(ledger, sort_keys=True)))
                for expansion in rules.get('expansionSchedule', []):
                    if 0 < expansion['week'] <= current_period:
                        db.execute('INSERT INTO expansion_reward_claims(set_code,week,quantity,claimed_at) VALUES(?,?,?,?)',
                                   (expansion['code'].lower(), expansion['week'], expansion['bonusPacks'], '2026-11-17T00:00:00Z'))
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_bytes(cache_bytes)
            forge.parent.mkdir(parents=True, exist_ok=True)
            forge.write_text(forge_text)
            launch('official-old-seeded')
            stop()
            before = snapshot()
            verify_files()
            rejected = invoke_probe('tampered')
            if not rejected.get('tamperedRejected') or digest(installed) != metadata['oldSha256'] or snapshot() != before:
                raise RuntimeError('Tampered bytes were not rejected without preserving the old executable/data.')
            verify_files()
            report['tamperedRejected'] = True
            accepted = invoke_probe('good')
            if not accepted.get('installed') or accepted.get('currentVersion') != metadata['oldVersion'] or accepted.get('version') != metadata['newVersion']:
                raise RuntimeError('The native installer did not perform the exact expected upgrade.')
            if digest(installed) != metadata['newSha256'] or installed.stat().st_mode & 0o777 != permissions:
                raise RuntimeError('The real native install did not preserve permissions and replace the AppImage.')
            report['installedSha256'] = digest(installed)
            report['permissionsPreserved'] = True
            launch('official-new-signed')
            stop()
            if snapshot() != before:
                raise RuntimeError('The game or settings fixture changed after signed installation/relaunch.')
            verify_files()
            if digest(local) != metadata['newSha256'] or digest(new) != metadata['newSha256']:
                raise RuntimeError('Verification modified the frozen signed release payload.')
            report.update(success=True, upgradedLaunched=True, gameDataPreserved=True,
                          settingsProbePreserved=True, cachePreserved=True, forgeDeckPreserved=True,
                          frozenUploadedPayloadUnchanged=True, ownedCards=2, decks=1,
                          commonWildcards=7, historyRows=1, receiptRows=1, queuedPacks=3)
            print('PASS: actual official Linux signed upgrade, tamper rejection, relaunch, and fixture preservation with current reward entitlements pre-recorded; compensation and online-gate UI not exercised.')
        except Exception as error:
            report['error'] = str(error).replace(str(root), '<isolated>')[-2500:]
            if logs:
                print(logs[-1].read_text(errors='replace')[-2000:].replace(str(root), '<isolated>'), file=sys.stderr)
            raise RuntimeError(report['error']) from None
        finally:
            stop()
            server.shutdown()
            server.server_close()
            report_file.write_text(json.dumps(report, indent=2) + '\n')


def self_test():
    assert version('0.3.0') > version('0.2.1')
    ledger = current_reward_ledger({'startingPacks': 20, 'weeklyPacks': 6,
                                   'startingWildcards': {'common': 10, 'uncommon': 5, 'rare': 2, 'mythic': 1}})
    assert ledger == {'version': 1, 'startingPacks': 20, 'weeklyPacks': 6,
                      'startingWildcards': {'common': 10, 'uncommon': 5, 'rare': 2, 'mythic': 1}}
    with sqlite3.connect(':memory:') as db:
        db.execute('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)')
        db.execute('INSERT INTO settings VALUES(?,?)', (REWARD_LEDGER_KEY, json.dumps(ledger)))
        assert json.loads(db.execute('SELECT value FROM settings WHERE key=?', (REWARD_LEDGER_KEY,)).fetchone()[0]) == ledger
    for invalid in ['v0.3.0', '0.03.0', '0.3.0-beta', '../0.3.0']:
        try:
            version(invalid)
        except ValueError:
            pass
        else:
            raise AssertionError('Invalid version was accepted.')
    encoded = base64.b64encode(b'untrusted comment: public fixture\nabc\ntrusted comment: timestamp:1\tversion:0.3.0\ndef\n').decode()
    signature_version(encoded, '0.3.0')
    try:
        signature_version(encoded, '0.2.1')
    except RuntimeError:
        pass
    else:
        raise AssertionError('Wrong signed version was accepted.')
    assert public_download_url('https://release-assets.githubusercontent.com/file?public=1')
    for invalid in ['http://github.com/file', 'https://github.com.attacker.test/file', 'https://user:secret@github.com/file']:
        assert not public_download_url(invalid)
    with tempfile.TemporaryDirectory() as temporary:
        env = child_environment(Path(temporary))
        assert set(env) <= {'PATH', 'DISPLAY', 'XAUTHORITY', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'LD_LIBRARY_PATH',
                            'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR',
                            'APPIMAGE_EXTRACT_AND_RUN', 'WEBKIT_DISABLE_DMABUF_RENDERER', 'LIBGL_ALWAYS_SOFTWARE', 'GDK_BACKEND', 'LINUX_QA_ROOT'}
        assert all(Path(env[key]).is_relative_to(temporary) for key in ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR'])
    print('PASS: reward-ledger fixture, stable version, signature version, redirect host, and credential-free temporary environment checks.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    prepare_parser = commands.add_parser('prepare')
    prepare_parser.add_argument('--tag', required=True)
    prepare_parser.add_argument('--release-id', required=True, type=int)
    prepare_parser.add_argument('--local-appimage', required=True, type=Path)
    exercise_parser = commands.add_parser('exercise')
    exercise_parser.add_argument('--probe', required=True, type=Path)
    commands.add_parser('self-test')
    args = parser.parse_args()
    try:
        if args.command == 'prepare':
            prepare(args)
        elif args.command == 'exercise':
            exercise(args)
        else:
            self_test()
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
