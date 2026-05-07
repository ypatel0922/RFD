from __future__ import annotations

from hashlib import sha256
from typing import Any

import httpx

from app.config import Settings
from app.models import AuthenticatedUser, DepartmentContext


class AuthError(Exception):
    pass


ROLE_OPTIONS = ("Chief", "Captain", "Lieutenant", "Secretary", "Treasurer", "Other")


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

    def signup(
        self,
        *,
        department_id: str,
        department_name: str,
        email: str,
        password: str,
        role: str,
    ) -> AuthenticatedUser:
        department_id = department_id.strip()
        department_name = department_name.strip()
        email = email.strip().lower()
        role = _validate_role(role)
        if not department_id or not department_name:
            raise AuthError("Choose your fire department.")
        if not email or not password:
            raise AuthError("Enter an email address and password.")

        if self.settings.supabase_auth_enabled:
            return self._signup_with_supabase(
                department_id=department_id,
                department_name=department_name,
                email=email,
                password=password,
                role=role,
            )
        if self.settings.dev_auth_enabled:
            return self._login_for_local_dev(email=email, role=role)

        raise AuthError("Supabase authentication is not configured.")

    def search_departments(self, query: str, *, limit: int = 10) -> list[DepartmentContext]:
        query = query.strip()
        if self.settings.supabase_auth_enabled:
            return self._search_supabase_departments(query=query, limit=limit)
        if self.settings.dev_auth_enabled and _matches_query(self.settings.dev_department_name, query):
            return [
                DepartmentContext(
                    id=self.settings.dev_department_id,
                    name=self.settings.dev_department_name,
                    role="member",
                )
            ]
        return []

    def _login_for_local_dev(self, *, email: str, role: str = "treasurer") -> AuthenticatedUser:
        department = DepartmentContext(
            id=self.settings.dev_department_id,
            name=self.settings.dev_department_name,
            role=role,
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
        access_token = _auth_access_token(payload)
        user_payload = _auth_user_payload(payload)
        user_id = user_payload.get("id")
        user_email = user_payload.get("email") or email
        if not access_token or not user_id:
            raise AuthError("Supabase did not return a valid session.")

        department = self._load_or_create_department_membership(
            access_token=access_token,
            user_id=user_id,
            user_payload=user_payload,
        )
        return AuthenticatedUser(
            id=user_id,
            email=user_email,
            access_token=access_token,
            department=department,
        )

    def _signup_with_supabase(
        self,
        *,
        department_id: str,
        department_name: str,
        email: str,
        password: str,
        role: str,
    ) -> AuthenticatedUser:
        assert self.settings.supabase_url is not None
        assert self.settings.supabase_anon_key is not None

        try:
            response = httpx.post(
                f"{self.settings.supabase_url}/auth/v1/signup",
                headers={
                    "apikey": self.settings.supabase_anon_key,
                    "Content-Type": "application/json",
                },
                json={
                    "email": email,
                    "password": password,
                    "data": {
                        "pending_department_id": department_id,
                        "pending_department_name": department_name,
                        "pending_department_role": role,
                    },
                },
                timeout=10,
            )
        except httpx.HTTPError as exc:
            raise AuthError(f"Could not reach Supabase Auth: {exc}") from exc

        if response.status_code >= 400:
            raise AuthError(_supabase_error_message(response))

        payload = response.json()
        access_token = _auth_access_token(payload)
        user_payload = _auth_user_payload(payload)
        user_id = user_payload.get("id")
        user_email = user_payload.get("email") or email
        if not user_id:
            raise AuthError("Supabase did not return a valid user.")
        if not access_token:
            raise AuthError(
                "Account created. Check your email to confirm it, then log in to finish department setup."
            )

        self._create_department_membership(
            access_token=access_token,
            department_id=department_id,
            user_id=user_id,
            role=role,
        )
        return AuthenticatedUser(
            id=user_id,
            email=user_email,
            access_token=access_token,
            department=DepartmentContext(
                id=department_id,
                name=department_name,
                role=role,
            ),
        )

    def _search_supabase_departments(self, *, query: str, limit: int) -> list[DepartmentContext]:
        assert self.settings.supabase_url is not None
        assert self.settings.supabase_anon_key is not None
        params = {
            "select": "id,name",
            "order": "name.asc",
            "limit": str(limit),
        }
        if query:
            params["name"] = f"ilike.*{query}*"

        try:
            response = httpx.get(
                f"{self.settings.supabase_url}/rest/v1/departments",
                params=params,
                headers={"apikey": self.settings.supabase_anon_key},
                timeout=10,
            )
        except httpx.HTTPError as exc:
            raise AuthError(f"Could not search departments: {exc}") from exc

        if response.status_code >= 400:
            raise AuthError(_supabase_error_message(response))

        return [
            DepartmentContext(id=row["id"], name=row["name"], role="member")
            for row in response.json()
        ]

    def _create_department_membership(
        self,
        *,
        access_token: str,
        department_id: str,
        user_id: str,
        role: str,
    ) -> None:
        assert self.settings.supabase_url is not None
        assert self.settings.supabase_anon_key is not None

        try:
            response = httpx.post(
                f"{self.settings.supabase_url}/rest/v1/department_members",
                headers={
                    "apikey": self.settings.supabase_anon_key,
                    "Authorization": f"Bearer {access_token}",
                    "Content-Type": "application/json",
                    "Prefer": "return=minimal",
                },
                json={
                    "department_id": department_id,
                    "user_id": user_id,
                    "role": role,
                },
                timeout=10,
            )
        except httpx.HTTPError as exc:
            raise AuthError(f"Could not create department membership: {exc}") from exc

        if response.status_code >= 400:
            raise AuthError(_supabase_error_message(response))

    def _load_or_create_department_membership(
        self,
        *,
        access_token: str,
        user_id: str,
        user_payload: dict[str, Any],
    ) -> DepartmentContext:
        try:
            return self._load_department_membership(
                access_token=access_token,
                user_id=user_id,
            )
        except AuthError as exc:
            if "not assigned to a fire department" not in str(exc):
                raise

        pending_department = _pending_department_from_user(user_payload)
        if pending_department is None:
            raise AuthError("Your account is not assigned to a fire department yet.")

        self._create_department_membership(
            access_token=access_token,
            department_id=pending_department.id,
            user_id=user_id,
            role=pending_department.role,
        )
        return pending_department

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


def _auth_user_payload(payload: dict[str, Any]) -> dict[str, Any]:
    nested_user = payload.get("user")
    if isinstance(nested_user, dict):
        return nested_user

    data = payload.get("data")
    if isinstance(data, dict) and isinstance(data.get("user"), dict):
        return data["user"]

    if payload.get("id"):
        return payload

    return {}


def _auth_access_token(payload: dict[str, Any]) -> str | None:
    access_token = payload.get("access_token")
    if isinstance(access_token, str) and access_token:
        return access_token

    session = payload.get("session")
    if isinstance(session, dict) and isinstance(session.get("access_token"), str):
        return session["access_token"]

    data = payload.get("data")
    if isinstance(data, dict):
        data_session = data.get("session")
        if isinstance(data_session, dict) and isinstance(data_session.get("access_token"), str):
            return data_session["access_token"]

    return None


def _pending_department_from_user(user_payload: dict[str, Any]) -> DepartmentContext | None:
    metadata = (
        user_payload.get("user_metadata")
        or user_payload.get("raw_user_meta_data")
        or {}
    )
    if not isinstance(metadata, dict):
        return None

    department_id = str(metadata.get("pending_department_id") or "").strip()
    department_name = str(metadata.get("pending_department_name") or "").strip()
    role = str(metadata.get("pending_department_role") or "").strip()
    if not department_id or not role:
        return None

    return DepartmentContext(
        id=department_id,
        name=department_name or "Fire Department",
        role=_validate_role(role),
    )


def _validate_role(role: str) -> str:
    normalized = role.strip()
    for option in ROLE_OPTIONS:
        if option.casefold() == normalized.casefold():
            return option
    raise AuthError("Choose a valid role.")


def _matches_query(value: str, query: str) -> bool:
    return not query or query.casefold() in value.casefold()
