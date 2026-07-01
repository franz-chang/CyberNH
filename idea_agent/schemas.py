from dataclasses import asdict, dataclass, field, is_dataclass
from typing import Any, Dict, List, Optional


def clean_dict(value: Any) -> Any:
    if is_dataclass(value):
        value = asdict(value)
    if isinstance(value, dict):
        return {k: clean_dict(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [clean_dict(v) for v in value]
    return value


@dataclass
class Section:
    section_id: str
    title: str
    role: str = "unknown"
    level: int = 1
    page_start: Optional[int] = None
    page_end: Optional[int] = None


@dataclass
class EvidenceSpan:
    span_id: str
    doc_id: str
    section_id: str
    section_title: str
    section_role: str
    span_type: str
    text: str
    page: Optional[int] = None
    char_start: Optional[int] = None
    char_end: Optional[int] = None
    citations: List[str] = field(default_factory=list)
    linked_tables: List[str] = field(default_factory=list)
    linked_figures: List[str] = field(default_factory=list)


@dataclass
class Document:
    doc_id: str
    title: str
    source_path: str
    format: str
    sections: List[Section] = field(default_factory=list)


@dataclass
class CanonicalMention:
    surface: str
    canonical: str
    type: str
    aliases: List[str] = field(default_factory=list)


@dataclass
class CandidateRelation:
    source: str
    relation: str
    target: str
    confidence: float = 0.5


@dataclass
class NormalizedView:
    span_id: str
    core_semantics: List[str] = field(default_factory=list)
    canonical_mentions: List[CanonicalMention] = field(default_factory=list)
    candidate_relations: List[CandidateRelation] = field(default_factory=list)
    preserved_values: List[str] = field(default_factory=list)
    preserved_citations: List[str] = field(default_factory=list)
    confidence: float = 0.0
    llm_used: bool = False


@dataclass
class KnowledgeUnit:
    ku_id: str
    type: str
    name: str
    canonical_name: str
    aliases: List[str] = field(default_factory=list)
    description: str = ""
    attributes: Dict[str, Any] = field(default_factory=dict)
    section_ids: List[str] = field(default_factory=list)
    evidence_span_ids: List[str] = field(default_factory=list)
    confidence: float = 0.0


@dataclass
class KUEmbedding:
    ku_id: str
    type: str
    canonical_name: str
    text: str
    vector: List[float]


@dataclass
class SemanticCluster:
    cluster_id: str
    type: str
    canonical_name: str
    member_ku_ids: List[str]
    confidence: float = 0.0


@dataclass
class GraphNode:
    id: str
    type: str
    label: str
    properties: Dict[str, Any] = field(default_factory=dict)


@dataclass
class GraphEdge:
    source: str
    relation: str
    target: str
    evidence_span_ids: List[str] = field(default_factory=list)
    confidence: float = 0.0


@dataclass
class Graph:
    doc_id: str
    nodes: List[GraphNode]
    edges: List[GraphEdge]
    metadata: Dict[str, Any] = field(default_factory=dict)
