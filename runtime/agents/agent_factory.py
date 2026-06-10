from .llm_config import load_llm_config
from .prompt_registry import PromptRegistry


class CyberNHAgentFactory:
    def __init__(self):
        self.prompt_registry = PromptRegistry()
        self.prompt_registry.load_all()
        self.llm_config = load_llm_config()
        self._agents = {}

    def _create_chat_agent(self, system_message: str):
        try:
            from camel.agents import ChatAgent
        except Exception as exc:
            raise RuntimeError("CAMEL is not available; use qwen_client fallback") from exc

        try:
            return ChatAgent(
                system_message=system_message,
                model=self.llm_config.model,
            )
        except TypeError:
            return ChatAgent(system_message=system_message)

    def get_worker_agent(self, worker_id: str):
        key = f"Worker-Agent:{worker_id}"
        if key not in self._agents:
            system_message = self.prompt_registry.get("Worker-Agent").replace("{{AGENT_ID}}", worker_id)
            self._agents[key] = self._create_chat_agent(system_message)
        return self._agents[key]

    def get_senior_agent(self, senior_id: str):
        key = f"Senior-Agent:{senior_id}"
        if key not in self._agents:
            system_message = self.prompt_registry.get("Senior-Agent").replace("{{AGENT_ID}}", senior_id)
            self._agents[key] = self._create_chat_agent(system_message)
        return self._agents[key]

    def get_assistant_agent(self):
        key = "Assistant-Agent:Assistant-01"
        if key not in self._agents:
            self._agents[key] = self._create_chat_agent(self.prompt_registry.get("Assistant-Agent"))
        return self._agents[key]

