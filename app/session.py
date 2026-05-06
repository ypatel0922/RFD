from __future__ import annotations

import base64
import hashlib
import hmac
import json
from typing import Any

from fastapi import Request, Response

from app.config import Settings
from app.models import AuthenticatedUser


SESSION_COOKIE_NAME = "rfd_session"
SESSION_MAX_AGE_SECONDS = 60 * 60 * 8


class SessionManager:
    def __init__(self, settings: Settings) -> None:
        self.secret = settings.session_secret.encode("utf-8")

    def load_user(self, request: Request) -> AuthenticatedUser | None:
        raw_cookie = request.cookies.get(SESSION_COOKIE_NAME)
        if not raw_cookie:
            return None

        try:
            payload = self._loads(raw_cookie)
            return AuthenticatedUser.model_validate(payload)
        except (ValueError, json.JSONDecodeError):
            return None

    def sign_in(self, response: Response, user: AuthenticatedUser) -> None:
        response.set_cookie(
            SESSION_COOKIE_NAME,
            self._dumps(user.model_dump(mode="json")),
            max_age=SESSION_MAX_AGE_SECONDS,
            httponly=True,
            secure=False,
            samesite="lax",
        )

    def sign_out(self, response: Response) -> None:
        response.delete_cookie(SESSION_COOKIE_NAME)

    def _dumps(self, payload: dict[str, Any]) -> str:
        encoded_payload = _base64url_encode(
            json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
        )
        signature = self._signature(encoded_payload)
        return f"{encoded_payload}.{signature}"

    def _loads(self, value: str) -> dict[str, Any]:
        encoded_payload, signature = value.rsplit(".", maxsplit=1)
        expected_signature = self._signature(encoded_payload)
        if not hmac.compare_digest(signature, expected_signature):
            raise ValueError("Invalid session signature")
        return json.loads(_base64url_decode(encoded_payload))

    def _signature(self, encoded_payload: str) -> str:
        digest = hmac.new(
            self.secret,
            encoded_payload.encode("ascii"),
            hashlib.sha256,
        ).digest()
        return _base64url_encode(digest)


def _base64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _base64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)
