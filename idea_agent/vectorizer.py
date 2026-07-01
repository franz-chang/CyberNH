import hashlib
import math
import re
from typing import Iterable, List

from .schemas import KUEmbedding, KnowledgeUnit


TOKEN_RE = re.compile(r"[A-Za-z0-9_\-]+")


class HashingVectorizer:
    def __init__(self, dimensions: int = 256):
        self.dimensions = dimensions

    def vectorize(self, units: Iterable[KnowledgeUnit]) -> List[KUEmbedding]:
        embeddings = []
        for unit in units:
            text = ku_to_embedding_text(unit)
            embeddings.append(
                KUEmbedding(
                    ku_id=unit.ku_id,
                    type=unit.type,
                    canonical_name=unit.canonical_name,
                    text=text,
                    vector=self.embed_text(text),
                )
            )
        return embeddings

    def embed_text(self, text: str) -> List[float]:
        vector = [0.0] * self.dimensions
        for token in TOKEN_RE.findall(text.lower()):
            digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
            number = int.from_bytes(digest, "big")
            index = number % self.dimensions
            sign = 1.0 if (number >> 8) % 2 == 0 else -1.0
            vector[index] += sign
        norm = math.sqrt(sum(v * v for v in vector))
        if norm == 0:
            return vector
        return [v / norm for v in vector]


def ku_to_embedding_text(unit: KnowledgeUnit) -> str:
    parts = [
        f"type: {unit.type}",
        f"name: {unit.canonical_name}",
        f"description: {unit.description}",
    ]
    for key, value in sorted(unit.attributes.items()):
        parts.append(f"{key}: {value}")
    return "\n".join(parts)


def cosine(vec_a: List[float], vec_b: List[float]) -> float:
    return sum(a * b for a, b in zip(vec_a, vec_b))
