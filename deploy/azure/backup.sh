#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 077

[[ $EUID == 0 ]] || { echo 'Run the backup as root.' >&2; exit 1; }
source /etc/arcane-fold/backup.env
: "${BACKUP_STORAGE_ACCOUNT:?}" "${BACKUP_STORAGE_CONTAINER:?}"
[[ $# == 1 && $1 == upload || $# == 2 && $1 == verify ]] ||
  { echo "Usage: $0 upload | verify BLOB_NAME" >&2; exit 1; }
mountpoint -q /var/lib/arcane-fold
app_dir=/var/lib/arcane-fold/app
postgres=(runuser -u postgres --)
connection=(--host=/var/run/postgresql --port=55433 --no-password)
scratch=$(mktemp -d)
restore_db=''
cleanup() {
  if [[ -n $restore_db ]]; then
    "${postgres[@]}" dropdb "${connection[@]}" --if-exists "$restore_db" >&2 || :
  fi
  rm -rf -- "$scratch"
}
trap cleanup EXIT

if [[ $1 == upload ]]; then
  blob="arcane-fold-$(date -u +%Y%m%dT%H%M%S)-$$.tar.gz"
  "${postgres[@]}" pg_dump "${connection[@]}" --format=custom --dbname=arcane_fold >"$scratch/database.dump"
  tar -czf "$scratch/backup.tar.gz" -C "$scratch" database.dump -C "$app_dir" player-logins.json
else
  blob=$2
  [[ $blob =~ ^arcane-fold-[0-9]{8}T[0-9]{6}-[0-9]+\.tar\.gz$ ]] ||
    { echo 'Invalid backup blob name.' >&2; exit 1; }
fi

python3 - "$1" "$scratch/backup.tar.gz" "$BACKUP_STORAGE_ACCOUNT" "$BACKUP_STORAGE_CONTAINER" "$blob" <<'PY'
import base64
import hashlib
import json
import pathlib
import sys
import urllib.error
import urllib.request
from email.utils import formatdate


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


mode, file_path, account, container, name = sys.argv[1:]
archive = pathlib.Path(file_path)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
token_url = "http://169.254.169.254/metadata/identity/oauth2/token"
token_query = "api-version=2018-02-01&resource=https%3A%2F%2Fstorage.azure.com%2F"
blob_url = f"https://{account}.blob.core.windows.net/{container}/{name}"

try:
    request = urllib.request.Request(f"{token_url}?{token_query}", headers={"Metadata": "true"})
    with opener.open(request, timeout=15) as response:
        token = json.load(response)["access_token"]

    headers = {
        "Authorization": f"Bearer {token}",
        "x-ms-date": formatdate(usegmt=True),
        "x-ms-version": "2023-11-03",
    }
    sha = hashlib.sha256()
    if mode == "upload":
        md5 = hashlib.md5(usedforsecurity=False)
        with archive.open("rb") as data:
            for chunk in iter(lambda: data.read(1024 * 1024), b""):
                sha.update(chunk)
                md5.update(chunk)
            data.seek(0)
            headers.update({
                "x-ms-blob-type": "BlockBlob",
                "x-ms-meta-sha256": sha.hexdigest(),
                "Content-Length": str(archive.stat().st_size),
                "Content-MD5": base64.b64encode(md5.digest()).decode("ascii"),
                "Content-Type": "application/gzip",
                "If-None-Match": "*",
            })
            request = urllib.request.Request(blob_url, data=data, headers=headers, method="PUT")
            with opener.open(request, timeout=120) as response:
                if response.status != 201 or response.headers.get("x-ms-request-server-encrypted") != "true":
                    raise SystemExit("Azure did not confirm the encrypted upload.")
    else:
        request = urllib.request.Request(blob_url, headers=headers)
        with opener.open(request, timeout=120) as response, archive.open("wb") as data:
            for chunk in iter(lambda: response.read(1024 * 1024), b""):
                sha.update(chunk)
                data.write(chunk)
            if response.headers.get("x-ms-meta-sha256") != sha.hexdigest():
                raise SystemExit("The downloaded backup failed SHA-256 verification.")
except urllib.error.HTTPError as error:
    raise SystemExit(f"Azure backup request failed: HTTP {error.code}") from None
PY

if [[ $1 == upload ]]; then
  printf '%s\n' "$blob"
  exit 0
fi

tar -xOzf "$scratch/backup.tar.gz" player-logins.json | python3 -c '
import json, sys
accounts = json.load(sys.stdin)
valid = {row["email"] for row in accounts if isinstance(row["password"], str) and row["password"]}
if valid != {"yannick@arcane-fold.test", "jef@arcane-fold.test"}:
    raise SystemExit("The backup does not contain both player logins.")
'
restore_db="arcane_restore_check_$(date -u +%s)_$$"
"${postgres[@]}" createdb "${connection[@]}" "$restore_db"
tar -xOzf "$scratch/backup.tar.gz" database.dump |
  "${postgres[@]}" pg_restore "${connection[@]}" --exit-on-error --no-owner --no-acl --dbname="$restore_db"
restored=$("${postgres[@]}" psql "${connection[@]}" -X --set=ON_ERROR_STOP=1 --dbname="$restore_db" -Atc "
  SELECT count(*) = 2 AND EXISTS (SELECT 1 FROM web_cards)
  FROM web_accounts WHERE email IN ('yannick@arcane-fold.test','jef@arcane-fold.test')")
[[ $restored == t ]] || { echo 'The restored database is missing the player accounts or catalog.' >&2; exit 1; }
echo 'Verified Azure Blob download and isolated PostgreSQL restore.'
