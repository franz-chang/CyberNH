from collections import defaultdict
from typing import Dict, Iterable, List, Set

from .schemas import KUEmbedding, KnowledgeUnit, SemanticCluster
from .vectorizer import cosine


class TypeAwareClusterer:
    def __init__(self, threshold: float = 0.82):
        self.threshold = threshold

    def cluster(self, units: List[KnowledgeUnit], embeddings: Iterable[KUEmbedding]) -> List[SemanticCluster]:
        by_type: Dict[str, List[KUEmbedding]] = defaultdict(list)
        unit_by_id = {unit.ku_id: unit for unit in units}
        for embedding in embeddings:
            by_type[embedding.type].append(embedding)

        clusters: List[SemanticCluster] = []
        for unit_type, items in sorted(by_type.items()):
            components = self._connected_components(items)
            for index, component in enumerate(components, start=1):
                members = sorted(component)
                names = [unit_by_id[ku_id].canonical_name for ku_id in members if ku_id in unit_by_id]
                canonical = _choose_canonical(names)
                clusters.append(
                    SemanticCluster(
                        cluster_id=f"cluster_{unit_type}_{index:03d}",
                        type=unit_type,
                        canonical_name=canonical,
                        member_ku_ids=members,
                        confidence=0.6 if len(members) > 1 else 0.4,
                    )
                )
        return clusters

    def _connected_components(self, items: List[KUEmbedding]) -> List[Set[str]]:
        adjacency: Dict[str, Set[str]] = {item.ku_id: set() for item in items}
        for left_index, left in enumerate(items):
            for right in items[left_index + 1:]:
                if cosine(left.vector, right.vector) >= self.threshold:
                    adjacency[left.ku_id].add(right.ku_id)
                    adjacency[right.ku_id].add(left.ku_id)

        seen = set()
        components = []
        for node in adjacency:
            if node in seen:
                continue
            stack = [node]
            component = set()
            while stack:
                current = stack.pop()
                if current in seen:
                    continue
                seen.add(current)
                component.add(current)
                stack.extend(adjacency[current] - seen)
            components.append(component)
        return components


def _choose_canonical(names: List[str]) -> str:
    if not names:
        return "Unnamed Cluster"
    return sorted(names, key=lambda name: (-len(name), name.lower()))[0]
