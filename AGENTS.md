# AGENTS.md

## Cursor Cloud specific instructions

### Project overview

RFD Expense Tracker — a receipt-first expense tracking web app for fire departments. Single Python/FastAPI service with local JSON + filesystem storage (no external DB or object storage required). Application code is on branch `cursor/receipt-expense-upload-a6f7`.

### Running the application

```bash
PYTHONPATH=/workspace python3 -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

The app runs at http://localhost:8000. No external services are needed; the app creates its `data/` directory on first use.

### Running tests

```bash
PYTHONPATH=/workspace pytest tests/ -v
```

`PYTHONPATH=/workspace` is required because there is no `pyproject.toml` or `setup.py` — the `app` package is resolved from the workspace root.

### Linting

```bash
ruff check .
```

### Key caveats

- **PYTHONPATH**: Always set `PYTHONPATH=/workspace` when running the app or tests, since there is no installable package definition.
- **OpenAI API key is optional**: Without `OPENAI_API_KEY`, the app still works — receipts are stored and marked `needs_review`. Set the env var to enable automatic receipt field extraction.
- **Data directory**: The app writes to `data/` (gitignored) by default. Override with `RFD_DATA_DIR` env var.
- **Config caching**: `app.config.get_settings()` uses `@lru_cache`. In tests, call `get_settings.cache_clear()` after changing env vars via monkeypatch.
