from pathlib import Path
from time import perf_counter
from typing import Dict

from tqdm import tqdm

from ..clients.deepseek import DeepSeekClient
from ..clusterer import TypeAwareClusterer
from ..evidence import build_lazy_evidence_plan, resolve_lazy_evidence
from ..extractor import DualViewExtractor
from ..graph_builder import GraphBuilder
from ..io_utils import ensure_dir, write_json, write_jsonl
from ..normalizer import SemanticNormalizer
from ..parser import parse_document
from ..schemas import NormalizedView
from ..vectorizer import HashingVectorizer


def _round_seconds(value: float) -> float:
    return round(value, 6)


class ArticleKGCompiler:
    def __init__(
        self,
        use_llm: bool = True,
        similarity_threshold: float = 0.82,
        embedding_dimensions: int = 256,
        config_path: Path = None,
        span_mode: str = "lazy",
        chunk_max_chars: int = 3200,
        evidence_top_k: int = 1,
        evidence_backend: str = "auto",
    ):
        self.llm = DeepSeekClient(config_path=config_path)
        self.use_llm = use_llm
        self.similarity_threshold = similarity_threshold
        self.embedding_dimensions = embedding_dimensions
        self.span_mode = span_mode
        self.chunk_max_chars = chunk_max_chars
        self.evidence_top_k = evidence_top_k
        self.evidence_backend = evidence_backend

    def compile(self, input_path: Path, output_dir: Path, doc_id: str = None) -> Dict:
        task_started = perf_counter()
        stage_timings = {}

        stage_started = perf_counter()
        output_dir = ensure_dir(output_dir)
        stage_timings["prepare_output_dir"] = _round_seconds(perf_counter() - stage_started)

        stage_started = perf_counter()
        document, source_spans = parse_document(input_path, doc_id=doc_id)
        stage_timings["parse_document"] = _round_seconds(perf_counter() - stage_started)
        spans = source_spans
        processing_spans = source_spans
        chunks = []
        sentence_candidates = []
        chunk_sentence_ids = {}

        if self.span_mode not in {"paragraph", "chunked", "lazy"}:
            raise ValueError("span_mode must be one of: paragraph, chunked, lazy")

        stage_started = perf_counter()
        if self.span_mode in {"chunked", "lazy"}:
            chunks, sentence_candidates, chunk_sentence_ids = build_lazy_evidence_plan(
                source_spans,
                max_chunk_chars=self.chunk_max_chars,
            )
            processing_spans = chunks
        stage_timings["plan_evidence"] = _round_seconds(perf_counter() - stage_started)

        stage_started = perf_counter()
        write_json(output_dir / "document.json", document)
        if self.span_mode != "paragraph":
            write_jsonl(output_dir / "source_spans.jsonl", source_spans)
            write_jsonl(output_dir / "chunks.jsonl", chunks)
        stage_timings["write_parse_outputs"] = _round_seconds(perf_counter() - stage_started)

        stage_started = perf_counter()
        normalizer = SemanticNormalizer(llm=self.llm, use_llm=self.use_llm)
        views = []
        for span in tqdm(processing_spans, desc="Normalizing spans"):
            views.append(normalizer.normalize(span))
        write_jsonl(output_dir / "normalized_views.jsonl", views)
        stage_timings["normalize_spans"] = _round_seconds(perf_counter() - stage_started)

        stage_started = perf_counter()
        view_by_span: Dict[str, NormalizedView] = {view.span_id: view for view in views}
        extractor = DualViewExtractor(llm=self.llm, use_llm=self.use_llm)
        units = extractor.extract(processing_spans, view_by_span)
        stage_timings["extract_units"] = _round_seconds(perf_counter() - stage_started)

        stage_started = perf_counter()
        if self.span_mode == "chunked":
            spans = chunks
        elif self.span_mode == "lazy":
            spans = resolve_lazy_evidence(
                units,
                sentence_candidates,
                chunk_sentence_ids,
                top_k=self.evidence_top_k,
                backend=self.evidence_backend,
                embedding_dimensions=self.embedding_dimensions,
            )
        stage_timings["resolve_evidence"] = _round_seconds(perf_counter() - stage_started)

        stage_started = perf_counter()
        write_jsonl(output_dir / "spans.jsonl", spans)
        write_jsonl(output_dir / "knowledge_units.jsonl", units)
        stage_timings["write_evidence_and_units"] = _round_seconds(perf_counter() - stage_started)

        stage_started = perf_counter()
        vectorizer = HashingVectorizer(dimensions=self.embedding_dimensions)
        embeddings = vectorizer.vectorize(units)
        write_jsonl(output_dir / "ku_embeddings.jsonl", embeddings)
        stage_timings["vectorize_units"] = _round_seconds(perf_counter() - stage_started)

        stage_started = perf_counter()
        clusterer = TypeAwareClusterer(threshold=self.similarity_threshold)
        clusters = clusterer.cluster(units, embeddings)
        write_json(output_dir / "clusters.json", clusters)
        stage_timings["cluster_units"] = _round_seconds(perf_counter() - stage_started)

        stage_started = perf_counter()
        graph = GraphBuilder().build(document, spans, units, clusters)
        write_json(output_dir / "graph.json", graph)
        stage_timings["build_graph"] = _round_seconds(perf_counter() - stage_started)

        total_seconds = _round_seconds(perf_counter() - task_started)
        timing = {
            "total_seconds": total_seconds,
            "stage_seconds": stage_timings,
        }

        report = {
            "doc_id": document.doc_id,
            "title": document.title,
            "input_path": str(input_path),
            "output_dir": str(output_dir),
            "llm_enabled": self.llm.enabled and self.use_llm,
            "span_mode": self.span_mode,
            "span_count": len(spans),
            "source_span_count": len(source_spans),
            "processing_span_count": len(processing_spans),
            "chunk_count": len(chunks),
            "sentence_candidate_count": len(sentence_candidates),
            "knowledge_unit_count": len(units),
            "cluster_count": len(clusters),
            "graph_node_count": len(graph.nodes),
            "graph_edge_count": len(graph.edges),
            "similarity_threshold": self.similarity_threshold,
            "embedding_dimensions": self.embedding_dimensions,
            "evidence_backend": self.evidence_backend,
            "evidence_top_k": self.evidence_top_k,
            "total_seconds": total_seconds,
            "stage_seconds": stage_timings,
        }
        write_json(output_dir / "pipeline_report.json", report)
        write_json(output_dir / "timing.json", timing)
        return report
