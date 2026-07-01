import hashlib
import math
import re
from collections import defaultdict
from typing import Dict, Iterable, List, Sequence, Tuple

from .schemas import EvidenceSpan, KnowledgeUnit


SENTENCE_RE = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9(\[])")
TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9\-]{2,}|\d+(?:\.\d+)?%?")
STOPWORDS = {
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "into",
    "using",
    "used",
    "are",
    "was",
    "were",
    "been",
    "our",
    "their",
    "its",
    "also",
    "than",
    "then",
    "such",
    "these",
    "those",
    "through",
}


def build_lazy_evidence_plan(
    paragraph_spans: Sequence[EvidenceSpan],
    max_chunk_chars: int = 3200,
) -> Tuple[List[EvidenceSpan], List[EvidenceSpan], Dict[str, List[str]]]:
    """Build section chunks for extraction and sentence candidates for evidence.

    The chunks are the expensive processing units. Sentence spans remain cheap
    candidates and only selected sentences are materialized in the final graph.
    """
    sentence_spans = _sentence_candidates(paragraph_spans)
    sentence_ids_by_paragraph = defaultdict(list)
    for sentence in sentence_spans:
        parent_id = getattr(sentence, "_parent_span_id", None)
        if parent_id:
            sentence_ids_by_paragraph[parent_id].append(sentence.span_id)

    chunks: List[EvidenceSpan] = []
    chunk_sentence_ids: Dict[str, List[str]] = {}
    current_parts: List[EvidenceSpan] = []
    current_chars = 0
    chunk_index_by_section = defaultdict(int)

    def flush():
        nonlocal current_parts, current_chars
        if not current_parts:
            return
        section_id = current_parts[0].section_id
        index = chunk_index_by_section[section_id]
        chunk_index_by_section[section_id] += 1
        chunk_id = f"{section_id}_chunk{index}"
        text = "\n\n".join(span.text for span in current_parts)
        citations = sorted({citation for span in current_parts for citation in span.citations})
        pages = [span.page for span in current_parts if span.page is not None]
        char_starts = [span.char_start for span in current_parts if span.char_start is not None]
        char_ends = [span.char_end for span in current_parts if span.char_end is not None]
        chunk = EvidenceSpan(
            span_id=chunk_id,
            doc_id=current_parts[0].doc_id,
            section_id=section_id,
            section_title=current_parts[0].section_title,
            section_role=current_parts[0].section_role,
            span_type="section_chunk",
            text=text,
            page=min(pages) if pages else current_parts[0].page,
            char_start=min(char_starts) if char_starts else current_parts[0].char_start,
            char_end=max(char_ends) if char_ends else current_parts[-1].char_end,
            citations=citations,
        )
        chunks.append(chunk)
        sentence_ids = []
        for span in current_parts:
            sentence_ids.extend(sentence_ids_by_paragraph.get(span.span_id, []))
        chunk_sentence_ids[chunk_id] = sentence_ids
        current_parts = []
        current_chars = 0

    previous_section = None
    for span in paragraph_spans:
        span_len = len(span.text)
        section_changed = previous_section is not None and span.section_id != previous_section
        would_overflow = current_parts and current_chars + span_len + 2 > max_chunk_chars
        if section_changed or would_overflow:
            flush()
        current_parts.append(span)
        current_chars += span_len + 2
        previous_section = span.section_id
    flush()

    if not chunks and paragraph_spans:
        return list(paragraph_spans), sentence_spans, {
            span.span_id: sentence_ids_by_paragraph.get(span.span_id, []) for span in paragraph_spans
        }

    return chunks, sentence_spans, chunk_sentence_ids


def resolve_lazy_evidence(
    units: List[KnowledgeUnit],
    sentence_spans: Sequence[EvidenceSpan],
    chunk_sentence_ids: Dict[str, List[str]],
    top_k: int = 1,
    backend: str = "auto",
    embedding_dimensions: int = 256,
) -> List[EvidenceSpan]:
    """Replace chunk references on KUs with selected sentence evidence spans."""
    if not units:
        return []
    sentence_by_id = {span.span_id: span for span in sentence_spans}
    if not sentence_by_id:
        return []

    candidate_ids_by_unit = []
    all_sentence_ids = [span.span_id for span in sentence_spans]
    section_to_sentence_ids = defaultdict(list)
    for span in sentence_spans:
        section_to_sentence_ids[span.section_id].append(span.span_id)

    for unit in units:
        candidate_ids = []
        for evidence_id in unit.evidence_span_ids:
            candidate_ids.extend(chunk_sentence_ids.get(evidence_id, []))
        if not candidate_ids:
            for section_id in unit.section_ids:
                candidate_ids.extend(section_to_sentence_ids.get(section_id, []))
        if not candidate_ids:
            candidate_ids = all_sentence_ids
        candidate_ids_by_unit.append(_dedupe_keep_order(candidate_ids))

    selected_by_unit = _select_with_cuda(
        units,
        sentence_spans,
        candidate_ids_by_unit,
        top_k=top_k,
        backend=backend,
        dimensions=embedding_dimensions,
    )
    if selected_by_unit is None:
        selected_by_unit = _select_with_lexical(units, sentence_by_id, candidate_ids_by_unit, top_k=top_k)

    selected_ids = []
    for unit, evidence_ids, candidate_ids in zip(units, selected_by_unit, candidate_ids_by_unit):
        if not evidence_ids:
            evidence_ids = list(candidate_ids[:1])
        unit.evidence_span_ids = evidence_ids
        selected_ids.extend(evidence_ids)

    return [sentence_by_id[span_id] for span_id in _dedupe_keep_order(selected_ids) if span_id in sentence_by_id]


def _sentence_candidates(paragraph_spans: Sequence[EvidenceSpan]) -> List[EvidenceSpan]:
    sentence_spans: List[EvidenceSpan] = []
    sentence_index_by_section = defaultdict(int)

    for paragraph in paragraph_spans:
        parts = _split_sentences(paragraph.text)
        if not parts:
            parts = [paragraph.text]
        cursor = 0
        for part in parts:
            start_offset = paragraph.text.find(part, cursor)
            if start_offset < 0:
                start_offset = cursor
            end_offset = start_offset + len(part)
            cursor = end_offset
            section_index = sentence_index_by_section[paragraph.section_id]
            sentence_index_by_section[paragraph.section_id] += 1
            sentence = EvidenceSpan(
                span_id=f"{paragraph.section_id}_sent{section_index}",
                doc_id=paragraph.doc_id,
                section_id=paragraph.section_id,
                section_title=paragraph.section_title,
                section_role=paragraph.section_role,
                span_type="sentence",
                text=part.strip(),
                page=paragraph.page,
                char_start=(paragraph.char_start + start_offset) if paragraph.char_start is not None else None,
                char_end=(paragraph.char_start + end_offset) if paragraph.char_start is not None else None,
                citations=paragraph.citations,
                linked_tables=paragraph.linked_tables,
                linked_figures=paragraph.linked_figures,
            )
            setattr(sentence, "_parent_span_id", paragraph.span_id)
            sentence_spans.append(sentence)

    return sentence_spans


def _split_sentences(text: str) -> List[str]:
    compact = re.sub(r"\s+", " ", text).strip()
    if not compact:
        return []
    parts = SENTENCE_RE.split(compact)
    return [part.strip() for part in parts if len(part.strip()) > 20]


def _select_with_lexical(
    units: Sequence[KnowledgeUnit],
    sentence_by_id: Dict[str, EvidenceSpan],
    candidate_ids_by_unit: Sequence[Sequence[str]],
    top_k: int,
) -> List[List[str]]:
    selected = []
    for unit, candidate_ids in zip(units, candidate_ids_by_unit):
        query_tokens = set(_tokens(_unit_query(unit)))
        scored = []
        for span_id in candidate_ids:
            sentence = sentence_by_id.get(span_id)
            if not sentence:
                continue
            sentence_tokens = set(_tokens(sentence.text))
            score = _overlap_score(query_tokens, sentence_tokens)
            scored.append((score, span_id))
        scored.sort(key=lambda item: item[0], reverse=True)
        selected.append([span_id for _, span_id in scored[: max(1, top_k)]])
    return selected


def _select_with_cuda(
    units: Sequence[KnowledgeUnit],
    sentence_spans: Sequence[EvidenceSpan],
    candidate_ids_by_unit: Sequence[Sequence[str]],
    top_k: int,
    backend: str,
    dimensions: int,
):
    if backend not in {"auto", "cuda"}:
        return None
    try:
        import torch
    except Exception:
        return None
    if not torch.cuda.is_available():
        return None

    device = torch.device("cuda")
    sentence_ids = [span.span_id for span in sentence_spans]
    sentence_index = {span_id: index for index, span_id in enumerate(sentence_ids)}
    sentence_vectors = _torch_vectors([span.text for span in sentence_spans], dimensions, device)
    unit_vectors = _torch_vectors([_unit_query(unit) for unit in units], dimensions, device)
    scores = unit_vectors @ sentence_vectors.T

    selected: List[List[str]] = []
    for unit_index, candidate_ids in enumerate(candidate_ids_by_unit):
        candidate_indexes = [sentence_index[span_id] for span_id in candidate_ids if span_id in sentence_index]
        if not candidate_indexes:
            selected.append([])
            continue
        candidate_scores = scores[unit_index, candidate_indexes]
        k = min(max(1, top_k), len(candidate_indexes))
        top_indexes = candidate_scores.topk(k=k).indices.detach().cpu().tolist()
        selected.append([sentence_ids[candidate_indexes[index]] for index in top_indexes])
    return selected


def _torch_vectors(texts: Sequence[str], dimensions: int, device):
    import torch

    vectors = torch.zeros((len(texts), dimensions), dtype=torch.float32, device=device)
    for row, text in enumerate(texts):
        for token in _tokens(text):
            vectors[row, _stable_index(token, dimensions)] += 1.0
    norms = torch.linalg.vector_norm(vectors, dim=1, keepdim=True).clamp_min(1e-6)
    return vectors / norms


def _unit_query(unit: KnowledgeUnit) -> str:
    attrs = " ".join(f"{key} {value}" for key, value in sorted(unit.attributes.items()))
    aliases = " ".join(unit.aliases)
    return f"{unit.type} {unit.name} {unit.canonical_name} {aliases} {unit.description} {attrs}"


def _tokens(text: str) -> List[str]:
    return [
        token.lower()
        for token in TOKEN_RE.findall(text or "")
        if token.lower() not in STOPWORDS and len(token) > 2
    ]


def _overlap_score(query_tokens: Iterable[str], sentence_tokens: Iterable[str]) -> float:
    query = set(query_tokens)
    sentence = set(sentence_tokens)
    if not query or not sentence:
        return 0.0
    overlap = len(query & sentence)
    return overlap / math.sqrt(len(query) * len(sentence))


def _stable_index(token: str, dimensions: int) -> int:
    digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
    return int.from_bytes(digest, "little") % dimensions


def _dedupe_keep_order(values: Iterable[str]) -> List[str]:
    seen = set()
    result = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result
