from pathlib import Path


PROMPT_DIR = Path(__file__).resolve().parents[1] / "prompts"


class PromptRegistry:
    def __init__(self, prompt_dir: Path = PROMPT_DIR):
        self.prompt_dir = prompt_dir
        self.prompts: dict[str, str] = {}

    def load_all(self) -> None:
        self.prompts["Senior-Agent"] = self._read("senior_agent.system.md")
        self.prompts["Worker-Agent"] = self._read("worker_agent.system.md")
        self.prompts["Assistant-Agent"] = self._read("assistant_agent.system.md")

    def get(self, agent_type: str) -> str:
        if not self.prompts:
            self.load_all()
        return self.prompts[agent_type]

    def _read(self, filename: str) -> str:
        path = self.prompt_dir / filename
        if not path.exists():
            raise FileNotFoundError(f"Missing prompt file: {path}")
        return path.read_text(encoding="utf-8")

