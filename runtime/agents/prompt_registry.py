import json
import os
from pathlib import Path


PROMPT_DIR = Path(__file__).resolve().parents[1] / "prompts"
ALIAS_FILE = "scenario_aliases.json"
PROMPT_MODE_ENV = "CYBERNH_SYSTEM_PROMPT_MODE"
ALIAS_PROMPT_MODES = {"alias", "aliases", "scenario", "scenario_alias", "short"}
FULL_PROMPT_MODES = {"full", "legacy", "long"}


class PromptRegistry:
    def __init__(self, prompt_dir: Path = PROMPT_DIR, prompt_mode: str | None = None):
        self.prompt_dir = prompt_dir
        self.prompt_mode = (prompt_mode or os.getenv(PROMPT_MODE_ENV, "scenario_alias")).strip().lower()
        self.prompts: dict[str, str] = {}
        self.aliases: dict[str, str] = {}

    def load_all(self) -> None:
        self.prompts["Senior-Agent"] = self._read("senior_agent.system.md")
        self.prompts["Worker-Agent"] = self._read("worker_agent.system.md")
        self.prompts["Assistant-Agent"] = self._read("assistant_agent.system.md")
        self.aliases = self._read_aliases()

    def get(self, agent_type: str) -> str:
        if not self.prompts:
            self.load_all()
        if self._use_aliases():
            return self.aliases.get(agent_type, self.prompts[agent_type])
        return self.prompts[agent_type]

    def get_full(self, agent_type: str) -> str:
        if not self.prompts:
            self.load_all()
        return self.prompts[agent_type]

    def _use_aliases(self) -> bool:
        if self.prompt_mode in FULL_PROMPT_MODES:
            return False
        return self.prompt_mode in ALIAS_PROMPT_MODES

    def _read(self, filename: str) -> str:
        path = self.prompt_dir / filename
        if not path.exists():
            raise FileNotFoundError(f"Missing prompt file: {path}")
        return path.read_text(encoding="utf-8")

    def _read_aliases(self) -> dict[str, str]:
        path = self.prompt_dir / ALIAS_FILE
        if not path.exists():
            return {}
        payload = json.loads(path.read_text(encoding="utf-8"))
        return {
            agent_type: config["scenario"]
            for agent_type, config in payload.get("aliases", {}).items()
            if isinstance(config, dict) and config.get("scenario")
        }
