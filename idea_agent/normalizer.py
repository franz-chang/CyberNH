import re
from typing import List

from .clients.deepseek import DeepSeekClient
from .schemas import CanonicalMention, CandidateRelation, EvidenceSpan, NormalizedView


VALUE_RE = re.compile(r"(?<!\w)(?:\d+(?:\.\d+)?\s?%|\d+(?:\.\d+)?\s?dB|0\.\d+|\d+\.\d+)(?!\w)")
MENTION_RE = re.compile(r"\b(?:[A-Z][A-Za-z0-9\-]+(?:\s+[A-Z][A-Za-z0-9\-]+){0,5}|[A-Z]{2,}[A-Za-z0-9\-]*)\b")
STOP_MENTIONS = {
    "a", "an", "the", "this", "that", "these", "those", "we", "our", "it",
    "figure", "table", "section", "appendix",
}


class SemanticNormalizer:
    def __init__(self, llm: DeepSeekClient = None, use_llm: bool = True):
        self.llm = llm or DeepSeekClient()
        self.use_llm = use_llm

    def normalize(self, span: EvidenceSpan) -> NormalizedView:
        if self.use_llm and self.llm.enabled:
            candidate = self._normalize_with_llm(span)
            if candidate is not None:
                return candidate
        return self._normalize_with_rules(span)

    def _normalize_with_llm(self, span: EvidenceSpan):
        system = (
            "You normalize article evidence spans for an evidence-grounded knowledge graph. "
            "Return only JSON. Do not add information that is absent from the span."
        )
        user = f"""
Span ID: {span.span_id}
Section role: {span.section_role}
Raw text:
{span.text}

Return JSON with keys:
span_id, core_semantics, canonical_mentions, candidate_relations,
preserved_values, preserved_citations, confidence.
canonical_mentions items: surface, canonical, type, aliases.
candidate_relations items: source, relation, target, confidence.
"""
        data = self.llm.chat_json(system, user)
        if not data:
            return None
        try:
            mentions = [
                CanonicalMention(
                    surface=item.get("surface", ""),
                    canonical=item.get("canonical") or item.get("surface", ""),
                    type=item.get("type", "concept"),
                    aliases=item.get("aliases", []),
                )
                for item in data.get("canonical_mentions", [])
                if item.get("surface") or item.get("canonical")
            ]
            relations = [
                CandidateRelation(
                    source=item.get("source", ""),
                    relation=item.get("relation", "related_to"),
                    target=item.get("target", ""),
                    confidence=float(item.get("confidence", 0.5)),
                )
                for item in data.get("candidate_relations", [])
                if item.get("source") and item.get("target")
            ]
            return NormalizedView(
                span_id=span.span_id,
                core_semantics=list(data.get("core_semantics", []))[:6],
                canonical_mentions=mentions[:12],
                candidate_relations=relations[:12],
                preserved_values=list(data.get("preserved_values", [])),
                preserved_citations=list(data.get("preserved_citations", span.citations)),
                confidence=float(data.get("confidence", 0.7)),
                llm_used=True,
            )
        except Exception:
            return None

    def _normalize_with_rules(self, span: EvidenceSpan) -> NormalizedView:
        sentences = _split_sentences(span.text)
        mentions = []
        seen = set()
        for surface in MENTION_RE.findall(span.text):
            canonical = _canonicalize(surface)
            key = canonical.lower()
            if key in seen or key in STOP_MENTIONS or len(canonical) < 3:
                continue
            seen.add(key)
            mentions.append(
                CanonicalMention(
                    surface=surface,
                    canonical=canonical,
                    type=_guess_mention_type(canonical, span.section_role),
                    aliases=[],
                )
            )
        return NormalizedView(
            span_id=span.span_id,
            core_semantics=sentences[:3],
            canonical_mentions=mentions[:12],
            candidate_relations=[],
            preserved_values=VALUE_RE.findall(span.text),
            preserved_citations=span.citations,
            confidence=0.45,
            llm_used=False,
        )


def _split_sentences(text: str) -> List[str]:
    parts = re.split(r"(?<=[.!?])\s+", re.sub(r"\s+", " ", text).strip())
    return [part.strip() for part in parts if len(part.strip()) > 20]


def _canonicalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip(" .,:;()[]")).strip()


def _guess_mention_type(name: str, section_role: str) -> str:
    lower = name.lower()
    if "dataset" in lower or lower in {"imagenet", "cifar", "coco", "brainmri", "isic", "montgomery"}:
        return "dataset"
    if lower in {"accuracy", "auc", "auroc", "f1", "psnr", "ssim", "bleu", "rouge"}:
        return "metric"
    if section_role == "method" or any(word in lower for word in ["method", "model", "encoder", "decoder", "loss"]):
        return "method_component"
    return "concept"
