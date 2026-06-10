from dataclasses import dataclass
import os


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


def load_llm_config() -> LLMConfig:
    return LLMConfig(
        provider=os.getenv("CYBERNH_LLM_PROVIDER", "modelscope-transformers"),
        model=os.getenv("CYBERNH_LLM_MODEL", "qwen3-vl-2b-instruct"),
        base_url=os.getenv("CYBERNH_LLM_BASE_URL", "http://localhost:8000/v1"),
        api_key=os.getenv("CYBERNH_LLM_API_KEY", "EMPTY"),
        temperature=float(os.getenv("CYBERNH_LLM_TEMPERATURE", "0")),
        max_tokens=int(os.getenv("CYBERNH_LLM_MAX_TOKENS", "512")),
        timeout_seconds=int(os.getenv("CYBERNH_LLM_TIMEOUT_SECONDS", "120")),
        json_mode=os.getenv("CYBERNH_LLM_JSON_MODE", "true").lower() == "true",
    )
