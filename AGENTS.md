# AGENTS.md

## Cursor Cloud specific instructions

### Project overview

RFD Expense Tracker — a receipt-first expense tracking web app for fire departments. Two services:

| Service | Stack | Port | Purpose |
|---------|-------|------|---------|
| Backend | Python/FastAPI + Uvicorn | 8000 | REST API, Jinja2 server-rendered UI, auth, receipt storage |
| Frontend | Next.js 16 (React 19, TypeScript) | 3000 | Supabase-backed SPA with receipt OCR route |

Both run without external services in dev mode (local JSON + filesystem fallback, dev auth mode).

### Running the backend (FastAPI)

```bash
PYTHONPATH=/workspace python3 -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Without `SUPABASE_URL`/`SUPABASE_ANON_KEY`, the app runs in local dev auth mode — any non-empty email/password works for login.

### Running the frontend (Next.js)

```bash
cd frontend && npm run dev
```

Requires `frontend/.env.local` (copy from `frontend/.env.local.example`). Runs at http://localhost:3000.

### Running tests

```bash
PYTHONPATH=/workspace pytest tests/ -v
```

`PYTHONPATH=/workspace` is required because there is no `pyproject.toml` or `setup.py` — the `app` package is resolved from the workspace root.

### Linting

```bash
ruff check .                        # Python
cd frontend && npx tsc --noEmit     # TypeScript type check
```

### Building the frontend

```bash
cd frontend && npm run build
```

### Key caveats

- **PYTHONPATH**: Always set `PYTHONPATH=/workspace` when running the app or tests, since there is no installable package definition.
- **Node.js**: Requires Node 22 LTS. Installed via NodeSource `setup_22.x` APT repo.
- **OpenAI API key is optional**: Without `OPENAI_API_KEY`, both apps still work — receipts are stored and marked `needs_review`.
- **Supabase is optional**: Without `SUPABASE_URL`/`SUPABASE_ANON_KEY`, the backend uses local dev auth and the frontend shows a login page but cannot authenticate against Supabase.
- **Data directory**: The backend writes to `data/` (gitignored) by default. Override with `RFD_DATA_DIR` env var.
- **Config caching**: `app.config.get_settings()` uses `@lru_cache`. In tests, call `get_settings.cache_clear()` after changing env vars via monkeypatch.
- **Frontend env**: Copy `frontend/.env.local.example` to `frontend/.env.local` before running the frontend. The build and dev server both read from this file.
