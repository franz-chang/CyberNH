from pathlib import Path

from idea_agent.pipeline.compiler import ArticleKGCompiler


def test_compile_sample(tmp_path):
    sample = Path(__file__).resolve().parents[1] / "examples" / "sample_article.md"
    report = ArticleKGCompiler(use_llm=False).compile(sample, tmp_path, doc_id="sample")
    assert report["span_count"] > 0
    assert report["knowledge_unit_count"] > 0
    assert (tmp_path / "graph.json").exists()
