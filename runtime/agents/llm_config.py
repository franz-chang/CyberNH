from dataclasses import dataclass
import os

DEEPSEEK_DECISION_MODE = "deepseek_api"


@dataclass(frozen=True)
class LLMConfig:
    provider: str
    model: str
    base_url: str
    api_key: str
    temperature: float
    max_tokens: int
    timeout_seconds: int
    json_mode: bool
    thinking: str | None
    force_full_system_prompt: bool


def _env_bool(name: str, fallback: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return fallback
    return value.lower() in {"1", "true", "yes", "on"}


def _uses_deepseek(decision_mode: str | None = None, provider: str | None = None) -> bool:
    if decision_mode:
        return decision_mode == DEEPSEEK_DECISION_MODE
    if provider:
        return provider.lower() == "deepseek"

    default_decision_mode = os.getenv("CYBERNH_DEFAULT_AGENT_DECISION_MODE")
    if default_decision_mode:
        return default_decision_mode == DEEPSEEK_DECISION_MODE
    return os.getenv("CYBERNH_LLM_PROVIDER", "").lower() == "deepseek"


def load_llm_config(decision_mode: str | None = None, provider: str | None = None) -> LLMConfig:
    if _uses_deepseek(decision_mode, provider):
        return LLMConfig(
            provider="deepseek",
            model=os.getenv("CYBERNH_DEEPSEEK_MODEL", "deepseek-v4-flash"),
            base_url=os.getenv("CYBERNH_DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
            api_key=os.getenv("CYBERNH_DEEPSEEK_API_KEY", ""),
            temperature=float(os.getenv("CYBERNH_DEEPSEEK_TEMPERATURE", "0")),
            max_tokens=int(os.getenv("CYBERNH_DEEPSEEK_MAX_TOKENS", "512")),
            timeout_seconds=int(os.getenv("CYBERNH_DEEPSEEK_TIMEOUT_SECONDS", "120")),
            json_mode=_env_bool("CYBERNH_DEEPSEEK_JSON_MODE", True),
            thinking=os.getenv("CYBERNH_DEEPSEEK_THINKING", "disabled"),
            force_full_system_prompt=True,
        )

    return LLMConfig(
        provider=os.getenv("CYBERNH_LLM_PROVIDER", "modelscope-transformers"),
        model=os.getenv("CYBERNH_LLM_MODEL", "qwen3-vl-2b-instruct"),
        base_url=os.getenv("CYBERNH_LLM_BASE_URL", "http://localhost:8000/v1"),
        api_key=os.getenv("CYBERNH_LLM_API_KEY", "EMPTY"),
        temperature=float(os.getenv("CYBERNH_LLM_TEMPERATURE", "0")),
        max_tokens=int(os.getenv("CYBERNH_LLM_MAX_TOKENS", "5096")),
        timeout_seconds=int(os.getenv("CYBERNH_LLM_TIMEOUT_SECONDS", "120")),
        json_mode=_env_bool("CYBERNH_LLM_JSON_MODE", True),
        thinking=None,
        force_full_system_prompt=False,
    )
