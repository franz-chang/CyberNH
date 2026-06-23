from dataclasses import dataclass
import os

DEEPSEEK_DECISION_MODE = "deepseek_api"
LOCAL_DEEPSEEK_V4_FLASH_DECISION_MODE = "local_deepseek_v4_flash"


@dataclass(frozen=True)
class LLMConfig:
    provider: str
    provider_label: str
    model: str
    base_url: str
    api_key: str
    api_key_env: str
    temperature: float
    max_tokens: int
    timeout_seconds: int
    json_mode: bool
    thinking: str | None
    request_max_tokens_key: str
    chat_template_kwargs: dict | None
    force_full_system_prompt: bool


def _env_bool(name: str, fallback: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return fallback
    return value.lower() in {"1", "true", "yes", "on"}


def _normalized_remote_api_key(value: str | None) -> str:
    text = (value or "").strip()
    if not text:
        return ""
    if text.lower() in {"your-cstcloud-api-key", "sk-your-deepseek-api-key", "your-api-key", "placeholder"}:
        return ""
    return text


def _uses_deepseek(decision_mode: str | None = None, provider: str | None = None) -> bool:
    if decision_mode:
        return decision_mode == DEEPSEEK_DECISION_MODE
    if provider:
        return provider.lower() == "deepseek"

    default_decision_mode = os.getenv("CYBERNH_DEFAULT_AGENT_DECISION_MODE")
    if default_decision_mode:
        return default_decision_mode == DEEPSEEK_DECISION_MODE
    return os.getenv("CYBERNH_LLM_PROVIDER", "").lower() == "deepseek"


def _uses_local_deepseek_v4_flash(decision_mode: str | None = None, provider: str | None = None) -> bool:
    if decision_mode:
        return decision_mode == LOCAL_DEEPSEEK_V4_FLASH_DECISION_MODE
    if provider:
        return provider.lower() == "cstcloud-deepseek"

    default_decision_mode = os.getenv("CYBERNH_DEFAULT_AGENT_DECISION_MODE")
    return default_decision_mode == LOCAL_DEEPSEEK_V4_FLASH_DECISION_MODE


def load_llm_config(decision_mode: str | None = None, provider: str | None = None) -> LLMConfig:
    if _uses_deepseek(decision_mode, provider):
        return LLMConfig(
            provider="deepseek",
            provider_label="DeepSeek API",
            model=os.getenv("CYBERNH_DEEPSEEK_MODEL", "deepseek-v4-flash"),
            base_url=os.getenv("CYBERNH_DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
            api_key=_normalized_remote_api_key(os.getenv("CYBERNH_DEEPSEEK_API_KEY", "")),
            api_key_env="CYBERNH_DEEPSEEK_API_KEY",
            temperature=float(os.getenv("CYBERNH_DEEPSEEK_TEMPERATURE", "0")),
            max_tokens=int(os.getenv("CYBERNH_DEEPSEEK_MAX_TOKENS", "512")),
            timeout_seconds=int(os.getenv("CYBERNH_DEEPSEEK_TIMEOUT_SECONDS", "120")),
            json_mode=_env_bool("CYBERNH_DEEPSEEK_JSON_MODE", True),
            thinking=os.getenv("CYBERNH_DEEPSEEK_THINKING", "disabled"),
            request_max_tokens_key="max_tokens",
            chat_template_kwargs=None,
            force_full_system_prompt=True,
        )

    if _uses_local_deepseek_v4_flash(decision_mode, provider):
        chat_template_kwargs = {"thinking": True} if _env_bool("CYBERNH_LOCAL_DEEPSEEK_THINKING", False) else None
        return LLMConfig(
            provider="cstcloud-deepseek",
            provider_label="CSTCloud DeepSeek-V4-Flash",
            model=os.getenv("CYBERNH_LOCAL_DEEPSEEK_MODEL", "deepseek-v4-flash"),
            base_url=os.getenv("CYBERNH_LOCAL_DEEPSEEK_BASE_URL", "https://uni-api.cstcloud.cn/v1"),
            api_key=_normalized_remote_api_key(os.getenv("CYBERNH_LOCAL_DEEPSEEK_API_KEY", "")),
            api_key_env="CYBERNH_LOCAL_DEEPSEEK_API_KEY",
            temperature=float(os.getenv("CYBERNH_LOCAL_DEEPSEEK_TEMPERATURE", "0")),
            max_tokens=int(os.getenv("CYBERNH_LOCAL_DEEPSEEK_MAX_TOKENS", "5120")),
            timeout_seconds=int(os.getenv("CYBERNH_LOCAL_DEEPSEEK_TIMEOUT_SECONDS", "120")),
            json_mode=_env_bool("CYBERNH_LOCAL_DEEPSEEK_JSON_MODE", False),
            thinking=None,
            request_max_tokens_key="max_length",
            chat_template_kwargs=chat_template_kwargs,
            force_full_system_prompt=True,
        )

    return LLMConfig(
        provider=os.getenv("CYBERNH_LLM_PROVIDER", "modelscope-transformers"),
        provider_label="Local Qwen",
        model=os.getenv("CYBERNH_LLM_MODEL", "qwen3-8b-instruct"),
        base_url=os.getenv("CYBERNH_LLM_BASE_URL", "http://localhost:8000/v1"),
        api_key=os.getenv("CYBERNH_LLM_API_KEY", "EMPTY"),
        api_key_env="CYBERNH_LLM_API_KEY",
        temperature=float(os.getenv("CYBERNH_LLM_TEMPERATURE", "0")),
        max_tokens=int(os.getenv("CYBERNH_LLM_MAX_TOKENS", "5096")),
        timeout_seconds=int(os.getenv("CYBERNH_LLM_TIMEOUT_SECONDS", "120")),
        json_mode=_env_bool("CYBERNH_LLM_JSON_MODE", True),
        thinking=None,
        request_max_tokens_key="max_tokens",
        chat_template_kwargs=None,
        force_full_system_prompt=False,
    )
