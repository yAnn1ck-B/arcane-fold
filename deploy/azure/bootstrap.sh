#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 022

fail() {
  echo "$*" >&2
  exit 1
}

initialize=false
if [[ ${1:-} == --initialize-data-disk ]]; then
  initialize=true
  shift
fi
[[ $# == 1 || $# == 3 ]] ||
  fail "Usage: $0 [--initialize-data-disk] HOSTNAME [BACKUP_STORAGE_ACCOUNT BACKUP_CONTAINER]"
[[ $EUID == 0 ]] || fail 'Run the bootstrap as root.'
hostname=$1
[[ $hostname =~ ^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+$ ]] ||
  fail 'Use a fully qualified DNS hostname.'
storage_account=${2:-}
storage_container=${3:-}
if [[ $# == 3 ]]; then
  [[ $storage_account =~ ^[a-z0-9]{3,24}$ && $storage_container =~ ^[a-z0-9]+(-[a-z0-9]+)*$ &&
    ${#storage_container} -ge 3 && ${#storage_container} -le 63 ]] ||
    fail 'Invalid Azure Storage account or container name.'
fi

source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 && $(dpkg --print-architecture) == amd64 ]] ||
  fail 'This bootstrap requires Ubuntu 24.04 on x86-64.'
scripts=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
for source_file in deploy.sh arcane-fold.service arcane-fold-deploy.service arcane-fold-deploy.timer; do
  [[ -f $scripts/$source_file ]] || fail "Missing deployment file: $source_file"
done
if [[ -n $storage_account ]]; then
  for source_file in backup.sh arcane-fold-backup.service arcane-fold-backup.timer; do
    [[ -f $scripts/$source_file ]] || fail "Missing deployment file: $source_file"
  done
fi

exec 9>/run/lock/arcane-fold-bootstrap.lock
flock -n 9 || fail 'Another bootstrap is running.'
data_root=/var/lib/arcane-fold
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT

mount_data_disk() {
  local disk='' device filesystem label uuid configured actual
  udevadm settle
  for device in /dev/disk/azure/data/by-lun/0 /dev/disk/azure/scsi1/lun0; do
    if [[ -b $device ]]; then
      disk=$(readlink -f "$device")
      break
    fi
  done
  [[ -n $disk && $(lsblk -dn -o TYPE "$disk") == disk ]] ||
    fail 'Could not identify the Azure managed data disk at LUN 0.'
  filesystem=$(blkid -s TYPE -o value "$disk" || :)
  if [[ -z $filesystem ]]; then
    [[ $initialize == true ]] || fail 'The disk is blank. Re-run with --initialize-data-disk to provision it.'
    if findmnt --mountpoint "$data_root" >/dev/null || findmnt --fstab --mountpoint "$data_root" >/dev/null; then
      fail "The existing $data_root mount does not match the blank disk."
    fi
    [[ $(lsblk -nr -o TYPE "$disk") == disk &&
      -z $(lsblk -nr -o MOUNTPOINTS "$disk" | tr -d '[:space:]') &&
      -z $(wipefs --no-act --noheadings --output TYPE "$disk") ]] ||
      fail "Azure LUN 0 is in use or has an existing signature: $disk"
    mkfs.ext4 -q -F -L arcane-fold-data "$disk"
  fi
  filesystem=$(blkid -s TYPE -o value "$disk")
  label=$(blkid -s LABEL -o value "$disk" || :)
  uuid=$(blkid -s UUID -o value "$disk")
  [[ $filesystem == ext4 && $label == arcane-fold-data && -n $uuid ]] ||
    fail 'Azure LUN 0 already contains a different filesystem.'

  install -d -m 0755 "$data_root"
  configured=$(findmnt --fstab --mountpoint "$data_root" -n -o SOURCE || :)
  [[ -z $configured || $configured == "UUID=$uuid" ]] ||
    fail "$data_root already has a different mount configured."
  if ! mountpoint -q "$data_root"; then
    [[ -z $(find "$data_root" -mindepth 1 -maxdepth 1 -print -quit) ]] ||
      fail "Refusing to hide existing files under $data_root."
    if [[ -z $configured ]]; then
      printf 'UUID=%s %s ext4 defaults,nofail,x-systemd.device-timeout=30s 0 2\n' "$uuid" "$data_root" >>/etc/fstab
    fi
    mount "$data_root"
  fi
  actual=$(findmnt --mountpoint "$data_root" -n -o UUID)
  [[ $actual == "$uuid" ]] || fail "$data_root is mounted from a different disk."
  if [[ -z $configured ]] && ! findmnt --fstab --mountpoint "$data_root" >/dev/null; then
    printf 'UUID=%s %s ext4 defaults,nofail,x-systemd.device-timeout=30s 0 2\n' "$uuid" "$data_root" >>/etc/fstab
  fi
}

install_packages() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get -o DPkg::Lock::Timeout=120 update -q
  apt-get -o DPkg::Lock::Timeout=120 install -yq --no-install-recommends \
    bzip2 ca-certificates caddy curl git gnupg jq openjdk-17-jdk-headless postgresql-common python3 xz-utils

  curl --fail --silent --show-error --retry 3 -o "$scratch/pgdg.asc" \
    https://www.postgresql.org/media/keys/ACCC4CF8.asc
  local key_fingerprint
  key_fingerprint=$(gpg --batch --show-keys --with-colons "$scratch/pgdg.asc" | awk -F: '$1 == "fpr" && !found++ { print $10 }')
  [[ $key_fingerprint == B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8 ]] ||
    fail 'The PostgreSQL package signing key fingerprint did not match.'
  install -d -m 0755 /usr/share/postgresql-common/pgdg
  install -m 0644 "$scratch/pgdg.asc" /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
  cat >/etc/apt/sources.list.d/arcane-fold-pgdg.sources <<'EOF'
Types: deb
URIs: https://apt.postgresql.org/pub/repos/apt
Suites: noble-pgdg
Architectures: amd64
Components: main
Signed-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
EOF
  apt-get -o DPkg::Lock::Timeout=120 update -q
  if [[ -z $(pg_lsclusters --no-header) ]] &&
    ! grep -Eq '^[[:space:]]*create_main_cluster[[:space:]]*=' /etc/postgresql-common/createcluster.conf; then
    printf '\ncreate_main_cluster = false\n' >>/etc/postgresql-common/createcluster.conf
  fi
  apt-get -o DPkg::Lock::Timeout=120 install -yq --no-install-recommends postgresql-18
}

install_node() {
  local version=v24.22.3 archive install_path
  archive="node-${version}-linux-x64.tar.xz"
  install_path="/opt/node-${version}-linux-x64"
  if [[ ! -x $install_path/bin/node ]]; then
    [[ ! -e $install_path ]] || fail "Incomplete Node installation at $install_path."
    curl --fail --silent --show-error --retry 3 -o "$scratch/$archive" "https://nodejs.org/dist/$version/$archive"
    printf '%s  %s\n' 4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb "$scratch/$archive" |
      sha256sum --check --status
    tar --no-same-owner -xJf "$scratch/$archive" -C "$scratch"
    mv -- "$scratch/node-${version}-linux-x64" "$install_path"
  fi
  "$install_path/bin/node" --version | grep -Fx "$version"
  ln -sfn "$install_path/bin/node" /usr/local/bin/node
  ln -sfn "$install_path/bin/npm" /usr/local/bin/npm
}

configure_database() {
  local data_dir="$data_root/postgresql/18/arcane"
  local restart_required=false
  if ! id arcane-fold >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$data_root/app" --shell /usr/sbin/nologin arcane-fold
  fi
  install -d -m 0700 -o arcane-fold -g arcane-fold "$data_root/app" "$data_root/app/card-images"
  install -d -m 0700 -o postgres -g postgres "$data_root/postgresql" "$data_root/postgresql/18"
  if [[ ! -d /etc/postgresql/18/arcane ]]; then
    [[ ! -e $data_dir ]] || fail 'PostgreSQL data already exists without the corresponding cluster configuration.'
    pg_createcluster 18 arcane --port=55433 --start-conf=auto --datadir="$data_dir"
    restart_required=true
  fi
  [[ $(pg_conftool --short 18 arcane show data_directory) == "$data_dir" ]] ||
    fail 'The existing PostgreSQL cluster does not use the managed disk.'
  if ! grep -Eq "^[[:space:]]*listen_addresses[[:space:]]*=[[:space:]]*''([[:space:]]*(#.*)?)?$" /etc/postgresql/18/arcane/postgresql.conf; then
    pg_conftool 18 arcane set listen_addresses ''
    restart_required=true
  fi
  install -d -m 0755 /etc/systemd/system/postgresql@18-arcane.service.d
  cat >/etc/systemd/system/postgresql@18-arcane.service.d/arcane-fold.conf <<'EOF'
[Unit]
RequiresMountsFor=/var/lib/arcane-fold
EOF
  systemctl daemon-reload
  if [[ $restart_required == true ]]; then
    systemctl restart postgresql@18-arcane.service
  else
    systemctl start postgresql@18-arcane.service
  fi
  local postgres=(runuser -u postgres -- psql -X --host=/var/run/postgresql --port=55433 --dbname=postgres --no-password --set=ON_ERROR_STOP=1)
  if [[ $("${postgres[@]}" -Atc "SELECT 1 FROM pg_roles WHERE rolname = 'arcane-fold'") != 1 ]]; then
    "${postgres[@]}" -q -c 'CREATE ROLE "arcane-fold" LOGIN'
  fi
  if [[ $("${postgres[@]}" -Atc "SELECT 1 FROM pg_database WHERE datname = 'arcane_fold'") != 1 ]]; then
    "${postgres[@]}" -q -c 'CREATE DATABASE arcane_fold OWNER "arcane-fold"'
  fi
  runuser -u arcane-fold -- psql -X --host=/var/run/postgresql --port=55433 --dbname=arcane_fold --no-password \
    --set=ON_ERROR_STOP=1 -Atc 'SELECT 1' | grep -Fxq 1
}

mount_data_disk
install_packages
install_node
configure_database
install -d -m 0755 /opt/arcane-fold /etc/arcane-fold
cat >"$scratch/app.env" <<EOF
DATABASE_URL='postgresql://arcane-fold@localhost/arcane_fold?host=%2Fvar%2Frun%2Fpostgresql&port=55433'
WEB_HOST=127.0.0.1
WEB_PORT=4317
WEB_ORIGIN=https://$hostname
WEB_LOCAL_PLAY=0
WEB_PLAYER_LOGINS_FILE=$data_root/app/player-logins.json
WEB_CARD_IMAGE_CACHE=$data_root/app/card-images
EOF
install -m 0640 -g arcane-fold "$scratch/app.env" /etc/arcane-fold/app.env

install -m 0755 "$scripts/deploy.sh" /usr/local/sbin/arcane-fold-deploy
install -m 0644 "$scripts"/arcane-fold{,-deploy}.service "$scripts/arcane-fold-deploy.timer" /etc/systemd/system/
cat >"$scratch/Caddyfile" <<EOF
$hostname {
    reverse_proxy 127.0.0.1:4317
}
EOF
caddy validate --config "$scratch/Caddyfile" --adapter caddyfile
install -m 0644 "$scratch/Caddyfile" /etc/caddy/Caddyfile
systemctl enable --now caddy.service
systemctl reload caddy.service

if [[ -n $storage_account ]]; then
  printf 'BACKUP_STORAGE_ACCOUNT=%s\nBACKUP_STORAGE_CONTAINER=%s\n' "$storage_account" "$storage_container" >"$scratch/backup.env"
  install -m 0600 "$scratch/backup.env" /etc/arcane-fold/backup.env
  install -m 0755 "$scripts/backup.sh" /usr/local/sbin/arcane-fold-backup
  install -m 0644 "$scripts"/arcane-fold-backup.{service,timer} /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now arcane-fold-backup.timer
else
  systemctl daemon-reload
fi

printf 'Arcane Fold host ready for the initial release at https://%s\n' "$hostname"
