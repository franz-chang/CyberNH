import argparse
from pathlib import Path

from .pipeline.compiler import ArticleKGCompiler


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="idea-agent",
        description="Compile an article into an evidence-grounded Article Knowledge Graph.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    compile_parser = subparsers.add_parser("compile", help="Run the Article-KG Stage 1 pipeline.")
    compile_parser.add_argument("input", type=Path, help="Input PDF, HTML, Markdown, or TXT file.")
    compile_parser.add_argument("--output", "-o", type=Path, default=Path("outputs/run"), help="Output directory.")
    compile_parser.add_argument("--doc-id", type=str, default=None, help="Stable document id.")
    compile_parser.add_argument("--no-llm", action="store_true", help="Disable DeepSeek calls and use rule fallback.")
    compile_parser.add_argument("--config", type=Path, default=None, help="Path to config.yaml.")
    compile_parser.add_argument("--similarity-threshold", type=float, default=0.82, help="Type-aware clustering threshold.")
    compile_parser.add_argument("--embedding-dimensions", type=int, default=256, help="Hash embedding dimension.")
    compile_parser.add_argument(
        "--span-mode",
        choices=["paragraph", "chunked", "lazy"],
        default="lazy",
        help="Evidence strategy: old paragraph spans, chunk spans, or chunk-first extraction with lazy sentence evidence.",
    )
    compile_parser.add_argument(
        "--chunk-max-chars",
        type=int,
        default=3200,
        help="Maximum characters per section chunk when using chunked or lazy span modes.",
    )
    compile_parser.add_argument(
        "--evidence-top-k",
        type=int,
        default=1,
        help="Number of sentence evidence spans to attach to each extracted unit in lazy mode.",
    )
    compile_parser.add_argument(
        "--evidence-backend",
        choices=["auto", "lexical", "cuda"],
        default="auto",
        help="Lazy evidence resolver backend. auto uses CUDA when torch+cuda are available, otherwise lexical matching.",
    )

    return parser


def main(argv=None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "compile":
        compiler = ArticleKGCompiler(
            use_llm=not args.no_llm,
            similarity_threshold=args.similarity_threshold,
            embedding_dimensions=args.embedding_dimensions,
            config_path=args.config,
            span_mode=args.span_mode,
            chunk_max_chars=args.chunk_max_chars,
            evidence_top_k=args.evidence_top_k,
            evidence_backend=args.evidence_backend,
        )
        report = compiler.compile(args.input, args.output, doc_id=args.doc_id)
        print("Article-KG compilation complete")
        print(f"  doc_id: {report['doc_id']}")
        print(f"  span_mode: {report['span_mode']}")
        print(f"  spans: {report['span_count']}")
        if report.get("processing_span_count") != report.get("source_span_count"):
            print(f"  source_spans: {report['source_span_count']}")
            print(f"  processing_spans: {report['processing_span_count']}")
        print(f"  knowledge_units: {report['knowledge_unit_count']}")
        print(f"  clusters: {report['cluster_count']}")
        print(f"  elapsed: {report.get('total_seconds', 0):.3f}s")
        print(f"  graph: {args.output / 'graph.json'}")
        print(f"  timing: {args.output / 'timing.json'}")
