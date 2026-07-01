import re
from typing import Dict, Iterable, List

from .clients.deepseek import DeepSeekClient
from .schemas import EvidenceSpan, KnowledgeUnit, NormalizedView
from .section_roles import role_targets


METRIC_NAMES = {
    "accuracy", "bit accuracy", "f1", "auc", "auroc", "precision", "recall",
    "psnr", "ssim", "bleu", "rouge", "mse", "mae",
}
DATASET_NAMES = {
    "imagenet", "cifar", "coco", "brainmri", "brain mri", "isic", "drive",
    "montgomery", "shenzhen", "chestx-ray14", "nih chestx-ray14", "lits",
}
RESULT_RE = re.compile(
    r"(?P<name>[A-Za-z][A-Za-z0-9\-\s]{0,50}?)\s+"
    r"(?:achieves?|obtains?|reaches?|is|was|=)\s+"
    r"(?P<value>\d+(?:\.\d+)?\s?%|\d+(?:\.\d+)?\s?dB|0\.\d+)"
)


class DualViewExtractor:
    def __init__(self, llm: DeepSeekClient = None, use_llm: bool = True):
        self.llm = llm or DeepSeekClient()
        self.use_llm = use_llm

    def extract(self, spans: Iterable[EvidenceSpan], views: Dict[str, NormalizedView]) -> List[KnowledgeUnit]:
        units: List[KnowledgeUnit] = []
        for span in spans:
            view = views.get(span.span_id)
            extracted = []
            if self.use_llm and self.llm.enabled and view is not None:
                extracted = self._extract_with_llm(span, view)
            if not extracted:
                extracted = self._extract_with_rules(span, view)
            units.extend(extracted)
        return _assign_ids(_dedupe_exact(units))

    def _extract_with_llm(self, span: EvidenceSpan, view: NormalizedView) -> List[KnowledgeUnit]:
        system = (
            "Extract evidence-grounded Knowledge Units from article spans. "
            "Return only JSON. Every unit must be supported by the raw span."
        )
        user = f"""
Span ID: {span.span_id}
Section ID: {span.section_id}
Section role: {span.section_role}
Target types: {role_targets(span.section_role)}

Raw text:
{span.text}

Normalized view:
core_semantics={view.core_semantics}
canonical_mentions={[m.__dict__ for m in view.canonical_mentions]}
preserved_values={view.preserved_values}

Return JSON:
{{
  "knowledge_units": [
    {{
      "type": "method|method_component|dataset|experiment|metric|baseline|result|claim|limitation|concept|citation_background",
      "name": "...",
      "canonical_name": "...",
      "aliases": [],
      "description": "...",
      "attributes": {{}},
      "confidence": 0.0
    }}
  ]
}}
"""
        data = self.llm.chat_json(system, user)
        if not data:
            return []
        units = []
        for item in data.get("knowledge_units", []):
            name = item.get("name") or item.get("canonical_name")
            if not name:
                continue
            units.append(
                KnowledgeUnit(
                    ku_id="",
                    type=_normalize_type(item.get("type", "concept")),
                    name=name,
                    canonical_name=item.get("canonical_name") or name,
                    aliases=item.get("aliases", []),
                    description=item.get("description", ""),
                    attributes=item.get("attributes", {}),
                    section_ids=[span.section_id],
                    evidence_span_ids=[span.span_id],
                    confidence=float(item.get("confidence", 0.7)),
                )
            )
        return units

    def _extract_with_rules(self, span: EvidenceSpan, view: NormalizedView) -> List[KnowledgeUnit]:
        units: List[KnowledgeUnit] = []
        text = span.text
        lower = text.lower()
        mentions = view.canonical_mentions if view else []

        for mention in mentions:
            mention_type = _normalize_type(mention.type)
            if mention_type in {"dataset", "metric", "method_component", "concept"}:
                units.append(
                    _unit_from_span(
                        mention_type,
                        mention.surface,
                        mention.canonical,
                        span,
                        description=_sentence_for_name(text, mention.surface),
                        aliases=mention.aliases,
                        confidence=0.45,
                    )
                )

        for dataset in DATASET_NAMES:
            if dataset in lower:
                units.append(
                    _unit_from_span("dataset", dataset, _title(dataset), span, confidence=0.55)
                )

        for metric in METRIC_NAMES:
            if metric in lower:
                units.append(
                    _unit_from_span("metric", metric, metric.upper() if len(metric) <= 5 else _title(metric), span, confidence=0.55)
                )

        if span.section_role == "method" or any(k in lower for k in ["propose", "introduce", "framework", "method", "model"]):
            name = _method_name(text, mentions)
            units.append(
                _unit_from_span(
                    "method",
                    name,
                    name,
                    span,
                    description=_first_sentence(text),
                    attributes={"role": span.section_role},
                    confidence=0.5,
                )
            )

        if span.section_role == "experiment" or any(k in lower for k in ["evaluate", "baseline", "protocol", "dataset"]):
            units.append(
                _unit_from_span(
                    "experiment",
                    f"Experiment in {span.section_title}",
                    f"Experiment in {span.section_title}",
                    span,
                    description=_first_sentence(text),
                    attributes={"metrics": _find_known(lower, METRIC_NAMES), "datasets": _find_known(lower, DATASET_NAMES)},
                    confidence=0.45,
                )
            )

        for result in RESULT_RE.finditer(text):
            canonical = f"{result.group('name').strip()} = {result.group('value').strip()}"
            units.append(
                _unit_from_span(
                    "result",
                    canonical,
                    canonical,
                    span,
                    description=_sentence_for_name(text, result.group("value")),
                    attributes={"value": result.group("value").strip()},
                    confidence=0.55,
                )
            )

        if span.section_role in {"abstract", "introduction", "discussion", "conclusion", "result"}:
            claim = _first_sentence(text)
            if claim:
                units.append(
                    _unit_from_span("claim", claim[:90], claim[:90], span, description=claim, confidence=0.42)
                )

        if "limitation" in lower or "future work" in lower:
            units.append(
                _unit_from_span("limitation", _first_sentence(text)[:90], _first_sentence(text)[:90], span, description=_first_sentence(text), confidence=0.5)
            )

        return units


def _unit_from_span(
    unit_type,
    name,
    canonical,
    span,
    description="",
    aliases=None,
    attributes=None,
    confidence=0.5,
):
    return KnowledgeUnit(
        ku_id="",
        type=_normalize_type(unit_type),
        name=name,
        canonical_name=canonical or name,
        aliases=aliases or [],
        description=description or _first_sentence(span.text),
        attributes=attributes or {},
        section_ids=[span.section_id],
        evidence_span_ids=[span.span_id],
        confidence=confidence,
    )


def _normalize_type(value: str) -> str:
    value = (value or "concept").lower().strip().replace(" ", "_")
    aliases = {
        "methodcomponent": "method_component",
        "citationbackground": "citation_background",
        "prior_method": "method",
    }
    return aliases.get(value, value)


def _assign_ids(units: List[KnowledgeUnit]) -> List[KnowledgeUnit]:
    for index, unit in enumerate(units, start=1):
        unit.ku_id = f"ku_{index:04d}"
    return units


def _dedupe_exact(units: List[KnowledgeUnit]) -> List[KnowledgeUnit]:
    merged = {}
    for unit in units:
        key = (unit.type, unit.canonical_name.lower().strip())
        if key not in merged:
            merged[key] = unit
            continue
        existing = merged[key]
        existing.aliases = sorted(set(existing.aliases + unit.aliases + [unit.name]))
        existing.section_ids = sorted(set(existing.section_ids + unit.section_ids))
        existing.evidence_span_ids = sorted(set(existing.evidence_span_ids + unit.evidence_span_ids))
        existing.confidence = max(existing.confidence, unit.confidence)
    return list(merged.values())


def _first_sentence(text: str) -> str:
    parts = re.split(r"(?<=[.!?])\s+", re.sub(r"\s+", " ", text).strip())
    return parts[0] if parts and parts[0] else text[:240]


def _sentence_for_name(text: str, name: str) -> str:
    for sentence in re.split(r"(?<=[.!?])\s+", text):
        if name.lower() in sentence.lower():
            return sentence.strip()
    return _first_sentence(text)


def _method_name(text: str, mentions) -> str:
    for mention in mentions:
        if mention.type in {"method", "method_component"} and len(mention.canonical.split()) <= 6:
            return mention.canonical
    match = re.search(r"(?:propose|introduce|present)\s+(?:a|an|the)?\s*([A-Z][A-Za-z0-9\-\s]{2,60})", text)
    if match:
        return match.group(1).strip(" .,:;")
    return "Article Method"


def _find_known(lower_text: str, known) -> List[str]:
    return sorted(item for item in known if item in lower_text)


def _title(text: str) -> str:
    return " ".join(part.capitalize() for part in text.split())
