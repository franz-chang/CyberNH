import re
from typing import Dict


ROLE_KEYWORDS: Dict[str, str] = {
    "abstract": "abstract",
    "introduction": "introduction",
    "background": "introduction",
    "related work": "related_work",
    "method": "method",
    "methods": "method",
    "approach": "method",
    "model": "method",
    "architecture": "method",
    "experiment": "experiment",
    "experiments": "experiment",
    "evaluation": "experiment",
    "result": "result",
    "results": "result",
    "analysis": "result",
    "discussion": "discussion",
    "limitation": "discussion",
    "limitations": "discussion",
    "conclusion": "conclusion",
    "future work": "conclusion",
}


def classify_section_role(title: str) -> str:
    normalized = re.sub(r"\s+", " ", title.strip().lower())
    if not normalized:
        return "unknown"

    for keyword, role in ROLE_KEYWORDS.items():
        if keyword in normalized:
            return role
    return "unknown"


def role_targets(role: str):
    mapping = {
        "abstract": ["claim", "method", "result"],
        "introduction": ["claim", "concept", "citation_background"],
        "related_work": ["method", "citation_background", "claim"],
        "method": ["method", "method_component", "concept"],
        "experiment": ["experiment", "dataset", "baseline", "metric"],
        "result": ["result", "metric", "claim"],
        "discussion": ["claim", "limitation"],
        "conclusion": ["claim", "limitation"],
    }
    return mapping.get(role, ["concept", "claim"])
