import json
from typing import Type

from pydantic import BaseModel, ValidationError

from .agent_factory import CyberNHAgentFactory
from .prompt_registry import PromptRegistry
from .qwen_client import QwenOpenAICompatibleClient
from .schemas import AssistantDecision, SeniorDecision, WorkerDecision


class CamelDecisionAdapter:
    def __init__(self):
        self.registry = PromptRegistry()
        self.registry.load_all()
        self.factory = None
        self.qwen_client = None
        try:
            self.qwen_client = QwenOpenAICompatibleClient()
        except Exception:
            self.qwen_client = None
        try:
            if self.qwen_client is None or not self.qwen_client.cfg.force_full_system_prompt:
                self.factory = CyberNHAgentFactory()
        except Exception:
            self.factory = None

    def decide_worker(self, worker_id: str, observation: dict, fallback_decision: WorkerDecision) -> WorkerDecision:
        system_prompt = self._system_prompt("Worker-Agent").replace("{{AGENT_ID}}", worker_id)
        return self._decide(
            agent_getter=lambda: self.factory.get_worker_agent(worker_id) if self.factory else None,
            system_prompt=system_prompt,
            observation=observation,
            schema=WorkerDecision,
            fallback=fallback_decision,
        )

    def decide_senior(self, senior_id: str, observation: dict, fallback_decision: SeniorDecision) -> SeniorDecision:
        system_prompt = self._system_prompt("Senior-Agent").replace("{{AGENT_ID}}", senior_id)
        return self._decide(
            agent_getter=lambda: self.factory.get_senior_agent(senior_id) if self.factory else None,
            system_prompt=system_prompt,
            observation=observation,
            schema=SeniorDecision,
            fallback=fallback_decision,
        )

    def decide_assistant(self, observation: dict, fallback_decision: AssistantDecision) -> AssistantDecision:
        return self._decide(
            agent_getter=lambda: self.factory.get_assistant_agent() if self.factory else None,
            system_prompt=self._system_prompt("Assistant-Agent"),
            observation=observation,
            schema=AssistantDecision,
            fallback=fallback_decision,
        )

    def _decide(
        self,
        agent_getter,
        system_prompt: str,
        observation: dict,
        schema: Type[BaseModel],
        fallback: BaseModel,
    ):
        try:
            agent = agent_getter()
            if agent is not None:
                response = agent.step(json.dumps(observation, ensure_ascii=False), response_format=schema)
                parsed = getattr(response.msgs[0], "parsed", None)
                if parsed is not None:
                    return parsed
        except (ValidationError, ValueError, KeyError, AttributeError, TypeError, RuntimeError):
            pass

        if self.qwen_client is not None:
            try:
                return self.qwen_client.complete_json(system_prompt, observation, schema)
            except (ValidationError, ValueError, KeyError, AttributeError, TypeError, RuntimeError):
                pass

        return fallback

    def _system_prompt(self, agent_type: str) -> str:
        if self.qwen_client is not None and self.qwen_client.cfg.force_full_system_prompt:
            return self.registry.get_full(agent_type)
        return self.registry.get(agent_type)
