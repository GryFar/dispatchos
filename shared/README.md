# Shared

Cross-frontend code. Not the backend's `shared/schema.ts` — that's authoritative for types.

## Layout (planned)

```
shared/
├── types/                # synced from backend/shared/schema.ts (don't edit directly)
├── api-client/           # thin fetch wrappers per resource: clients.ts, loads.ts, ...
└── design-system/        # tokens + components (owned by Claude Design)
    ├── tokens.json
    ├── tailwind.preset.ts
    └── components/
```

## Rules

- `shared/types/` is auto-synced from `backend/shared/schema.ts`. If you need a type change, edit the backend file and let it propagate.
- `shared/api-client/` is hand-written. Keep wrappers thin — they should add typing, retry, and cookie credentials, nothing more.
- `shared/design-system/` is owned by Claude Design. Other contributors propose changes via PR with Claude Design as required reviewer.
