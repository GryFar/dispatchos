# DispatchOS Unified — технический статус

## Уже закрыто в этом билде

- Единый webapp + backend проект.
- SQLite persistence для клиентов, грузов, обновлений позиции и audit events.
- API для ручного создания клиента и груза.
- API для обновления позиции клиента: `PATCH /api/clients/:id/location`.
- UI формы:
  - Add Client
  - Update `/loc`
  - Add Load
- Audit/Backup panel.
- CSV import грузов.
- Broker check records.
- Document metadata tracking: rate con, BOL, POD, COI, W-9, authorization letter.
- Google Drive folder plan generator.
- Local file upload для Rate Con / BOL / POD / COI / W-9.
- Telegram command endpoint для `/loc`, `/yes`, `/no`, `/nego`.
- Gmail/broker email ingest endpoint с базовым extraction.
- FMCSA live-ready broker check: использует API env vars если настроены, иначе fallback с явным warning.
- Local Drive-style folder creation в `dispatchos_data/drive`.
- Security hardening:
  - server bind to `127.0.0.1` by default
  - security headers
  - API rate limit
  - JSON/form body limits
  - upload size limit
  - extension/MIME allowlist
  - sanitized upload filenames
  - CSV row limit
  - redacted backup export
- Local owner auth:
  - PBKDF2 password hashing
  - TOTP 2FA compatible with Authy, Google Authenticator, 1Password, Apple Passwords
  - protected API after first setup
  - session cookie httpOnly/sameSite
- Integration status panel.
- Weekly report generator.
- Windows VDS deployment scripts:
  - `INSTALL_VDS.bat`
  - `START_VDS.bat`
  - `CHECK_VDS.bat`
- `.env.vds.example`.
- `WINDOWS_VDS_DEPLOY_RU.md`.
- System status endpoint.
- Portal readiness endpoint.
- Location-aware scoring engine.
- 3 тестовых клиента:
  - enclosed car hauler
  - hotshot flatbed
  - sprinter van
- Политика свежести позиции:
  - 0-30 минут: high confidence
  - 31-60 минут: medium confidence
  - 60+ минут: low confidence, нужен `/loc`
- Расчёт:
  - deadhead miles
  - total miles
  - loaded PPM
  - total PPM
  - estimated net
  - net total PPM
  - pickup feasibility
  - dispatch score
- UI объясняет, почему груз #1 лучше остальных.
- Windows scripts:
  - `INSTALL.bat`
  - `START.bat`
  - `CHECK.bat`
- Smoke test:
  - `/api/health`
  - `/api/clients`
  - `/api/dispatch-board`
  - `POST /api/clients`
  - `PATCH /api/clients/:id/location`
  - `POST /api/loads`
  - `/api/audit`
  - `/api/backup/export`
  - `POST /api/loads/import-csv`
  - `POST /api/broker/check`
  - `POST /api/documents`
  - `/api/drive/folder-plan`
  - `POST /api/drive/create-local-folders`
  - `POST /api/documents/upload`
  - `POST /api/telegram/command`
  - `POST /api/email/ingest`
  - `/api/backup/export?redacted=true`

## Что ещё нужно до реального запуска 3-5 клиентов

### Must-have

1. Заменить seed clients на реальных клиентов через UI.
2. Добавить Google Drive папки по клиентам.
3. Добавить upload rate con / BOL / POD.
4. Добавить автоматический scheduled backup, не только manual export.

### Should-have

1. Подключить настоящий FMCSA URL/key в `.env`.
2. Заменить local Drive folder creation на Google Drive API OAuth внутри приложения.
3. Подключить реальный Telegram Bot webhook через публичный URL.
4. Подключить Gmail OAuth/polling вместо manual email paste.
5. Weekly client report generator.

### Later

1. Telegram bot.
2. Gmail ingest.
3. Live load board APIs.
4. Cloud multi-user.
5. Signed Windows `.exe`.

## Как работать с версиями

Каноническая latest версия после этого сообщения:

`DispatchOS-Unified-v1.2.7-vds-production.zip`

Следующие правки делать только от этого ZIP или от более нового ZIP, если он будет создан.
