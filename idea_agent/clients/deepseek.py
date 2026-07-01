import json
import os
import re
from pathlib import Path
from typing import Any, Dict, Optional

import requests

from ..config import load_config


PLACEHOLDER_KEYS = {"", "sk-REPLACE_ME", "REPLACE_ME", "your_api_key", "你的 key"}


class DeepSeekClient:
    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        model: Optional[str] = None,
        timeout: int = 60,
        config_path: Optional[Path] = None,
    ):
        config = load_config(config_path).get("llm", {})
        self.api_key = api_key or config.get("api_key") or os.getenv("DEEPSEEK_API_KEY", "")
        self.base_url = (
            base_url
            or config.get("base_url")
            or os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1")
        ).rstrip("/")
        self.model = model or config.get("model") or os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
        self.timeout = int(config.get("timeout") or timeout)

    @property
    def enabled(self) -> bool:
        return self.api_key not in PLACEHOLDER_KEYS and not self.api_key.startswith("sk-your")

    def chat_json(self, system_prompt: str, user_prompt: str) -> Optional[Dict[str, Any]]:
        if not self.enabled:
            return None

        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": 0.1,
            "response_format": {"type": "json_object"},
        }
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        try:
            response = requests.post(
                f"{self.base_url}/chat/completions",
                headers=headers,
                json=payload,
                timeout=self.timeout,
            )
            response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
            return _parse_json_object(content)
        except Exception:
            return None


def _parse_json_object(text: str) -> Optional[Dict[str, Any]]:
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, flags=re.S)
        if not match:
            return None
        try:
            parsed = json.loads(match.group(0))
            return parsed if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            return None
