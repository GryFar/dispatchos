# Restore the production database from backup

DispatchOS runs on Fly.io (app `dispatchos-demo`) with a single SQLite file at
`/data/dispatchos-unified.db` on the persistent volume `dispatchos_data`.
There are two independent restore sources:

1. **GitHub Actions artifact** (offsite copy) — produced daily at 07:00 UTC by
   `.github/workflows/backup-cron.yml` via `GET /api/cron/backup`.
   Retention: 90 days.
2. **Fly volume snapshot** — Fly takes automatic daily snapshots of every
   volume (retained 5 days by default).

Prefer the GitHub artifact when the app itself corrupted data (it is a
consistent online snapshot with a SHA-256). Prefer the volume snapshot when the
whole volume/host is lost.

Prerequisites: `flyctl` authenticated (`fly auth login`), `gh` authenticated,
and access to the repo + the Fly org.

---

## Path A — restore from a GitHub Actions backup artifact

### 1. Download the artifact

```bash
# List recent backup runs (workflow: "Daily DB Backup")
gh run list --workflow backup-cron.yml --limit 10

# Download the artifact from the chosen run into ./restore/
gh run download <RUN_ID> --name dispatchos-db-backup-encrypted --dir restore/
ls restore/          # → dispatchos-backup-YYYYMMDD.db.enc  (AES-256 encrypted)
```

**Decrypt** — the artifact is AES-256-CBC / PBKDF2 (200k iterations) encrypted
with the `BACKUP_ENC_PASSPHRASE` secret. You need that same passphrase (GitHub
repo secret + the owner's password-manager copy). Cipher/iter MUST match
`backup-cron.yml`:

```bash
read -rs BACKUP_ENC_PASSPHRASE            # paste the passphrase (not echoed)
export BACKUP_ENC_PASSPHRASE
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -in restore/dispatchos-backup-YYYYMMDD.db.enc \
  -out restore/dispatchos-backup-YYYYMMDD.db \
  -pass env:BACKUP_ENC_PASSPHRASE
unset BACKUP_ENC_PASSPHRASE
```

Sanity-check the decrypted file before touching prod:

```bash
sqlite3 restore/dispatchos-backup-YYYYMMDD.db "PRAGMA integrity_check;"   # → ok
sqlite3 restore/dispatchos-backup-YYYYMMDD.db "SELECT count(*) FROM clients;"
```

### 2. Stop the app (prevent writes during the swap)

```bash
fly scale count 0 -a dispatchos-demo --yes
# Wait until no machines are running:
fly machines list -a dispatchos-demo
```

`fly ssh` needs a running machine, so start a temporary one attached to the
volume without the app accepting traffic:

```bash
fly machines list -a dispatchos-demo          # note a machine ID
fly machine start <MACHINE_ID> -a dispatchos-demo
```

(If `scale count 0` destroyed all machines, `fly scale count 1` recreates one;
do the file swap quickly before traffic resumes, or detach it from the
services first.)

### 3. Upload the backup over SFTP

```bash
# Preserve the current (bad) DB first — never delete, always move aside:
fly ssh console -a dispatchos-demo -C \
  "mv /data/dispatchos-unified.db /data/dispatchos-unified.db.pre-restore.$(date +%s)"

# Remove stale WAL/SHM so SQLite doesn't replay old journal over the restore:
fly ssh console -a dispatchos-demo -C \
  "sh -c 'rm -f /data/dispatchos-unified.db-wal /data/dispatchos-unified.db-shm'"

# Upload the snapshot into place:
fly ssh sftp shell -a dispatchos-demo
>> put restore/dispatchos-backup-YYYYMMDD.db /data/dispatchos-unified.db
>> exit
```

### 4. Restart and verify

```bash
fly scale count 1 -a dispatchos-demo --yes
# or, if the machine still exists: fly machine restart <MACHINE_ID> -a dispatchos-demo

fly logs -a dispatchos-demo          # watch boot; migrations run idempotently
curl -s https://demo.dispatchos.co/api/health          # → {"status":"ok",...}
```

Log in and spot-check: clients list, loads board, latest invoices. When
satisfied, the `.pre-restore.*` copy on the volume can be kept (it is small) or
archived; do not delete it the same day.

---

## Path B — restore from a Fly volume snapshot

Use when the volume itself is lost/corrupted. Snapshots restore into a **new**
volume; you then run the app on that volume.

```bash
# 1. Find the volume and its snapshots
fly volumes list -a dispatchos-demo                       # note VOLUME_ID
fly volumes snapshots list <VOLUME_ID> -a dispatchos-demo # note SNAPSHOT_ID

# 2. Create a new volume from the snapshot (same region as the app: iad)
fly volumes create dispatchos_data \
  --snapshot-id <SNAPSHOT_ID> \
  --region iad --size 3 -a dispatchos-demo

# 3. Point a machine at the new volume. Simplest path: destroy the machine
#    using the dead volume, then let fly deploy recreate it — new machines
#    mount an unattached volume named dispatchos_data automatically
#    (fly.toml [[mounts]] source = "dispatchos_data").
fly machines list -a dispatchos-demo
fly machine destroy <OLD_MACHINE_ID> -a dispatchos-demo --force
fly deploy

# 4. Delete/detach the dead volume ONLY after verifying the app:
curl -s https://demo.dispatchos.co/api/health
fly volumes destroy <OLD_VOLUME_ID> -a dispatchos-demo
```

Note: volume snapshots are point-in-time copies of the filesystem taken while
the app may have been writing; SQLite WAL makes this crash-consistent, but the
GitHub artifact (Path A) is the cleaner, checksummed snapshot when both exist.

---

## Related knobs

- On-box snapshots: the app also keeps local snapshots next to the DB, pruned
  by `DISPATCHOS_BACKUP_KEEP` (see `server/lib/backup.ts`) — check
  `/data/backups/` (via `fly ssh console`) before reaching for offsite copies;
  the freshest restore point may already be on the volume.
- Ad-hoc backup NOW (before any risky operation):
  `curl -fsS -o pre-change.db -H "X-Cron-Secret: $CRON_SECRET" https://demo.dispatchos.co/api/cron/backup`
- The backup endpoint returns header `X-Backup-Sha256`; compare with
  `sha256sum <file>` after download.
