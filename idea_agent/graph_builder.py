from collections import defaultdict
from typing import Dict, List

from .schemas import (
    Document,
    EvidenceSpan,
    Graph,
    GraphEdge,
    GraphNode,
    KnowledgeUnit,
    SemanticCluster,
)


class GraphBuilder:
    def build(
        self,
        document: Document,
        spans: List[EvidenceSpan],
        units: List[KnowledgeUnit],
        clusters: List[SemanticCluster],
    ) -> Graph:
        nodes: List[GraphNode] = []
        edges: List[GraphEdge] = []

        nodes.append(
            GraphNode(
                id=document.doc_id,
                type="Document",
                label=document.title,
                properties={"source_path": document.source_path, "format": document.format},
            )
        )

        for section in document.sections:
            nodes.append(
                GraphNode(
                    id=section.section_id,
                    type="Section",
                    label=section.title,
                    properties={"role": section.role, "level": section.level},
                )
            )
            edges.append(GraphEdge(source=document.doc_id, relation="contains", target=section.section_id, confidence=1.0))

        for span in spans:
            nodes.append(
                GraphNode(
                    id=span.span_id,
                    type="EvidenceSpan",
                    label=span.text[:90],
                    properties={
                        "section_role": span.section_role,
                        "span_type": span.span_type,
                        "page": span.page,
                        "text": span.text,
                    },
                )
            )
            edges.append(GraphEdge(source=span.section_id, relation="contains", target=span.span_id, confidence=1.0))

        for unit in units:
            nodes.append(
                GraphNode(
                    id=unit.ku_id,
                    type=_node_type_for_ku(unit.type),
                    label=unit.canonical_name,
                    properties={
                        "ku_type": unit.type,
                        "name": unit.name,
                        "aliases": unit.aliases,
                        "description": unit.description,
                        "attributes": unit.attributes,
                        "confidence": unit.confidence,
                    },
                )
            )
            for span_id in unit.evidence_span_ids:
                edges.append(
                    GraphEdge(
                        source=unit.ku_id,
                        relation="supported_by",
                        target=span_id,
                        evidence_span_ids=[span_id],
                        confidence=unit.confidence,
                    )
                )

        for cluster in clusters:
            nodes.append(
                GraphNode(
                    id=cluster.cluster_id,
                    type="SemanticCluster",
                    label=cluster.canonical_name,
                    properties={"ku_type": cluster.type, "confidence": cluster.confidence},
                )
            )
            for ku_id in cluster.member_ku_ids:
                edges.append(
                    GraphEdge(
                        source=ku_id,
                        relation="member_of",
                        target=cluster.cluster_id,
                        confidence=cluster.confidence,
                    )
                )

        edges.extend(_infer_basic_relations(units))
        return Graph(
            doc_id=document.doc_id,
            nodes=nodes,
            edges=_dedupe_edges(edges),
            metadata={
                "node_count": len(nodes),
                "edge_count": len(edges),
                "ku_count": len(units),
                "cluster_count": len(clusters),
            },
        )


def _infer_basic_relations(units: List[KnowledgeUnit]) -> List[GraphEdge]:
    by_type = defaultdict(list)
    for unit in units:
        by_type[unit.type].append(unit)

    edges: List[GraphEdge] = []
    for experiment in by_type.get("experiment", []):
        for dataset in by_type.get("dataset", []):
            if _overlaps(experiment, dataset):
                edges.append(_relation(experiment, "uses_dataset", dataset))
        for metric in by_type.get("metric", []):
            if _overlaps(experiment, metric):
                edges.append(_relation(experiment, "measured_by", metric))
        for method in by_type.get("method", []):
            if _overlaps(experiment, method):
                edges.append(_relation(method, "evaluated_by", experiment))

    for result in by_type.get("result", []):
        for claim in by_type.get("claim", []):
            if _overlaps(result, claim):
                edges.append(_relation(result, "supports", claim))

    return edges


def _relation(source: KnowledgeUnit, relation: str, target: KnowledgeUnit) -> GraphEdge:
    evidence = sorted(set(source.evidence_span_ids + target.evidence_span_ids))
    return GraphEdge(
        source=source.ku_id,
        relation=relation,
        target=target.ku_id,
        evidence_span_ids=evidence,
        confidence=min(source.confidence, target.confidence, 0.65),
    )


def _overlaps(left: KnowledgeUnit, right: KnowledgeUnit) -> bool:
    return bool(set(left.evidence_span_ids) & set(right.evidence_span_ids) or set(left.section_ids) & set(right.section_ids))


def _node_type_for_ku(unit_type: str) -> str:
    mapping = {
        "method": "Method",
        "method_component": "MethodComponent",
        "dataset": "Dataset",
        "experiment": "Experiment",
        "metric": "Metric",
        "baseline": "Baseline",
        "result": "Result",
        "claim": "Claim",
        "limitation": "Limitation",
        "citation_background": "CitationBackground",
    }
    return mapping.get(unit_type, "KnowledgeUnit")


def _dedupe_edges(edges: List[GraphEdge]) -> List[GraphEdge]:
    merged: Dict[tuple, GraphEdge] = {}
    for edge in edges:
        key = (edge.source, edge.relation, edge.target)
        if key not in merged:
            merged[key] = edge
            continue
        existing = merged[key]
        existing.evidence_span_ids = sorted(set(existing.evidence_span_ids + edge.evidence_span_ids))
        existing.confidence = max(existing.confidence, edge.confidence)
    return list(merged.values())
