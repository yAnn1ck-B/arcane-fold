# Azure deployment

Arcane Fold runs on an Ubuntu 24.04 VM in Japan East. Caddy serves `https://arcane-fold.japaneast.cloudapp.azure.com`. The Azure network security group allows HTTP and HTTPS. Use Azure VM Run Command for administration. Node listens on loopback, and PostgreSQL 18 uses a local Unix socket with peer authentication.

## Provision and start

1. Select the intended subscription explicitly. Create a dedicated resource group in `japaneast` and deploy [main.bicep](main.bicep) with an administrator SSH public key. Save the hostname and storage account and container from the deployment outputs.
2. Wait for the intended `main` push to pass [Web CI](../../.github/workflows/ci.yml). Use Azure VM Run Command to fetch the repository at that full commit SHA on the VM. From its checkout, run the following with the output values. Use `--initialize-data-disk` just for a new, blank Azure data disk.

   ```bash
   bash deploy/azure/bootstrap.sh --initialize-data-disk "$hostname" "$storage_account" "$storage_container"
   /usr/local/sbin/arcane-fold-deploy "$commit_sha"
   ```

3. Verify trusted HTTPS, the expected commit at `/__arcane-release.txt`, and the signed-out response at `/api/auth`. Enable the service and deployment timer with `systemctl enable arcane-fold.service` and `systemctl enable --now arcane-fold-deploy.timer`.
4. Run `blob=$(/usr/local/sbin/arcane-fold-backup upload)` and `/usr/local/sbin/arcane-fold-backup verify "$blob"` to test the off-VM backup and an isolated restore. Retrieve `/var/lib/arcane-fold/app/player-logins.json` through an encrypted handoff to the account owner.

## Releases and backups

The VM polls GitHub every five minutes for the latest successful `main` push. It stages the build, defers automatic restarts during recent match activity, and restores the previous release if startup verification fails. Use `journalctl -u arcane-fold-deploy.service` to inspect deployment results. After fixing a transient error, retry that release by passing its SHA to the deploy script.

The deployment and CI share the SHA-256-verified Forge 2.0.13 installer. Back up the database and keep the corresponding Forge version before upgrading the engine so saved matches can be tested against it. The release directory and Forge installation live under `/opt/arcane-fold`. The data disk holds PostgreSQL, player credentials, and the artwork cache under `/var/lib/arcane-fold`.

The backup timer saves a database dump and player login file to a private Azure Blob container using the VM's managed identity. Azure encrypts the stored archive and expires backups after 45 days. Use `journalctl -u arcane-fold-backup.service` to check the backup timer's runs.
