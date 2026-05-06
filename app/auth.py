from __future__ import annotations

from hashlib import sha256
from typing import Any

import httpx

from app.config import Settings
from app.models import AuthenticatedUser, DepartmentContext


class AuthError(Exception):
    pass


class AuthService:
    """Authenticate users and resolve their department membership.

    Production uses Supabase Auth plus a `department_members` lookup. When
    Supabase credentials are not configured, the local-dev mode keeps tests and
    demos runnable while preserving the same department-scoped app behavior.
    """

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def login(self, *, email: str, password: str) -> AuthenticatedUser:
        email = email.strip().lower()
        if not email or not password:
            raise AuthError("Enter an email address and password.")

        if self.settings.supabase_auth_enabled:
            return self._login_with_supabase(email=email, password=password)
        if self.settings.dev_auth_enabled:
            return self._login_for_local_dev(email=email)

        raise AuthError("Supabase authentication is not configured.")

    def _login_for_local_dev(self, *, email: str) -> AuthenticatedUser:
        department = DepartmentContext(
            id=self.settings.dev_department_id,
            name=self.settings.dev_department_name,
            role="treasurer",
        )
        return AuthenticatedUser(
            id=f"dev-{sha256(email.encode('utf-8')).hexdigest()[:16]}",
            email=email,
            access_token=None,
            department=department,
        )

    def _login_with_supabase(self, *, email: str, password: str) -> AuthenticatedUser:
        assert self.settings.supabase_url is not None
        assert self.settings.supabase_anon_key is not None

        try:
            response = httpx.post(
                f"{self.settings.supabase_url}/auth/v1/token",
                params={"grant_type": "password"},
                headers={
                    "apikey": self.settings.supabase_anon_key,
                    "Content-Type": "application/json",
                },
                json={"email": email, "password": password},
                timeout=10,
            )
        except httpx.HTTPError as exc:
            raise AuthError(f"Could not reach Supabase Auth: {exc}") from exc

        if response.status_code >= 400:
            raise AuthError(_supabase_error_message(response))

        payload = response.json()
        access_token = payload.get("access_token")
        user_payload = payload.get("user") or {}
        user_id = user_payload.get("id")
        user_email = user_payload.get("email") or email
        if not access_token or not user_id:
            raise AuthError("Supabase did not return a valid session.")

        department = self._load_department_membership(
            access_token=access_token,
            user_id=user_id,
        )
        return AuthenticatedUser(
            id=user_id,
            email=user_email,
            access_token=access_token,
            department=department,
        )

    def _load_department_membership(self, *, access_token: str, user_id: str) -> DepartmentContext:
        assert self.settings.supabase_url is not None
        assert self.settings.supabase_anon_key is not None

        try:
            response = httpx.get(
                f"{self.settings.supabase_url}/rest/v1/department_members",
                params={
                    "select": "department_id,role,departments(id,name)",
                    "user_id": f"eq.{user_id}",
                    "limit": "1",
                },
                headers={
                    "apikey": self.settings.supabase_anon_key,
                    "Authorization": f"Bearer {access_token}",
                },
                timeout=10,
            )
        except httpx.HTTPError as exc:
            raise AuthError(f"Could not load department membership: {exc}") from exc

        if response.status_code >= 400:
            raise AuthError(_supabase_error_message(response))

        memberships = response.json()
        if not memberships:
            raise AuthError("Your account is not assigned to a fire department yet.")

        membership = memberships[0]
        department_payload = membership.get("departments") or {}
        return DepartmentContext(
            id=membership["department_id"],
            name=department_payload.get("name") or "Fire Department",
            role=membership.get("role") or "member",
        )


def _supabase_error_message(response: httpx.Response) -> str:
    try:
        payload: dict[str, Any] = response.json()
    except ValueError:
        return "Supabase rejected the request."
    return (
        payload.get("msg")
        or payload.get("message")
        or payload.get("error_description")
        or payload.get("error")
        or "Supabase rejected the request."
    )
