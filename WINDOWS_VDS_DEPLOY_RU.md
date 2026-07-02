# DispatchOS на Windows VDS

## Цель

Запустить DispatchOS как сайт/GUI на Windows VDS компании. GUI является точкой доступа для администратора, модерации и будущего клиентского портала.

## Минимальная схема

```text
Internet
→ domain / Cloudflare
→ reverse proxy на VDS:443
→ DispatchOS на 127.0.0.1:5000
```

Не открывай Node.js напрямую наружу без reverse proxy и firewall.

## Установка

1. Установить Node.js LTS x64.
2. Распаковать архив в `C:\DispatchOS`.
3. Запустить `INSTALL_VDS.bat`.
4. Открыть `.env` и настроить:

```env
DISPATCHOS_DEPLOYMENT_MODE=vds
DISPATCHOS_HOST=127.0.0.1
DISPATCHOS_PUBLIC_URL=https://dispatch.yourdomain.com
DISPATCHOS_COOKIE_SECURE=true
DISPATCHOS_TRUST_PROXY=1
DISPATCHOS_SESSION_SECRET=REPLACE_WITH_RANDOM_SECRET
```

Секрет сгенерировать в PowerShell:

```powershell
[Convert]::ToBase64String((1..48 | ForEach-Object {Get-Random -Maximum 256}))
```

5. Запустить `CHECK_VDS.bat`.
6. Запустить `START_VDS.bat`.
7. Настроить reverse proxy на `http://127.0.0.1:5000`.

## Первый вход

1. Открыть домен.
2. Создать owner account.
3. Сохранить TOTP secret в 1Password/Authy/Google Authenticator/Apple Passwords.
4. Войти password + 2FA.

## Always-on режим

Для production лучше запускать не двойным кликом, а через:

- NSSM as Windows Service
- Windows Task Scheduler at startup
- PM2 for Windows

Команда:

```bat
npm run start
```

Рабочая папка: `C:\DispatchOS\dispatchos-location-aware`

## Что уже защищено

- Auth + TOTP 2FA.
- PBKDF2 password hash.
- API protected после setup.
- Rate limit.
- Upload allowlist/size limits.
- Local-only bind by default.
- Secure cookie mode для HTTPS.
- Redacted backup export.

## Что нельзя делать

- Не ставить `DISPATCHOS_AUTH_DISABLED=true` на VDS.
- Не оставлять default `DISPATCHOS_SESSION_SECRET`.
- Не открывать `0.0.0.0:5000` наружу без firewall.
- Не хранить `.env` в публичной папке.
- Не отправлять обычный backup третьим лицам; используй redacted backup.

## Проверка

После старта:

```text
GET /api/health
GET /api/system/status
GET /api/integrations/status
```

Через UI:

- System checks должны быть OK.
- Auth configured.
- Weekly report работает.
- Backup export работает.
