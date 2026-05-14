# С чего начинать DispatchOS с начала месяца

## Цель первых 30 дней

Не строить идеальную платформу. Цель: 3-5 платящих carrier-клиентов и стабильный ручной workflow.

## Неделя 1 — подготовка

1. Запусти DispatchOS локально через `INSTALL.bat` и `START.bat`.
2. Создай Google Drive структуру:

```text
DispatchOS/
├── Clients/
├── Loads/
├── Rate Confirmations/
├── BOL_POD/
├── Invoices/
└── Legal/
```

3. Подготовь документы:
   - dispatcher agreement
   - authorization letter
   - non-circumvention addendum
   - W-9 checklist
   - COI checklist
4. Создай Telegram template:
   - один чат на клиента
   - `/loc` для позиции
   - `/yes`, `/no`, `/nego` для быстрых решений
5. Собери список 20-30 русскоязычных hotshot/car hauler водителей.

## Неделя 2 — первые 1-2 клиента

1. Онбординг клиента:
   - MC/DOT
   - equipment
   - target PPM
   - preferred lanes
   - avoid states
   - insurance expiration
   - factoring info
2. Каждый день утром спрашивай:

```text
/loc
Где ты сейчас? Пустой или гружёный? Когда свободен? Куда хочешь ехать?
```

3. Вноси вручную top loads в DispatchOS.
4. Используй ranked list, а не gross price.
5. Для каждого хорошего load:
   - проверить broker
   - посчитать score
   - отправить клиенту top 3
   - получить подтверждение

## Неделя 3 — довести до 3-5 клиентов

1. Оставь только клиентов, которые быстро отвечают.
2. Клиент, который не отвечает 24 часа, не подходит для стартового workflow.
3. Каждый booked load логируй:
   - broker
   - rate
   - pickup/delivery
   - gross
   - deadhead
   - total/net PPM
   - BOL/POD status
4. Воскресенье:
   - weekly report
   - invoice: $150/week + 3%

## Что нельзя делать на старте

- Не подключать сразу 6 load board API.
- Не строить cloud multi-user.
- Не покупать дорогую инфраструктуру.
- Не бронировать без свежей позиции клиента.
- Не выбирать груз только по gross.
- Не работать без non-circumvention.

## Техдолг после первых клиентов

1. Gmail ingest broker emails.
2. CSV import from load boards.
3. Google Drive auto-folder creation.
4. FMCSA live verification.
5. Telegram bot for `/loc`, `/yes`, `/no`, `/nego`.
6. Backup SQLite database to Google Drive.
7. Windows `.exe` wrapper/signing.
