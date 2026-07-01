import re
from pathlib import Path
from typing import List, Tuple

from bs4 import BeautifulSoup

from .schemas import Document, EvidenceSpan, Section
from .section_roles import classify_section_role


HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
CITATION_RE = re.compile(r"(\[[0-9,\-\s]+\]|\([A-Z][A-Za-z\-]+(?: et al\.)?,?\s+\d{4}[a-z]?\))")


def parse_document(path: Path, doc_id: str = None) -> Tuple[Document, List[EvidenceSpan]]:
    suffix = path.suffix.lower()
    doc_id = doc_id or path.stem.replace(" ", "_")

    if suffix == ".pdf":
        title, sections, spans = _parse_pdf(path, doc_id)
        fmt = "pdf"
    elif suffix in {".html", ".htm"}:
        title, sections, spans = _parse_html(path, doc_id)
        fmt = "html"
    else:
        title, sections, spans = _parse_text_or_markdown(path, doc_id)
        fmt = "markdown" if suffix in {".md", ".markdown"} else "text"

    document = Document(
        doc_id=doc_id,
        title=title or path.stem,
        source_path=str(path),
        format=fmt,
        sections=sections,
    )
    return document, spans


def _parse_text_or_markdown(path: Path, doc_id: str):
    text = path.read_text(encoding="utf-8", errors="ignore")
    title = path.stem
    sections = []
    spans = []
    current = Section(section_id="sec0", title="Document", role="unknown", level=1)
    sections.append(current)
    buffer = []
    char_start = 0
    span_index = 0

    for match in re.finditer(r".*(?:\n|$)", text):
        line = match.group(0).rstrip("\n")
        heading = HEADING_RE.match(line)
        if heading:
            span_index = _flush_paragraphs(
                buffer, spans, doc_id, current, span_index, char_start, match.start()
            )
            buffer = []
            level = len(heading.group(1))
            heading_text = heading.group(2).strip()
            if not title or title == path.stem:
                title = heading_text
            section_id = f"sec{len(sections)}"
            current = Section(
                section_id=section_id,
                title=heading_text,
                role=classify_section_role(heading_text),
                level=level,
            )
            sections.append(current)
            char_start = match.end()
        elif line.strip():
            if not buffer:
                char_start = match.start()
            buffer.append(line.strip())
        else:
            span_index = _flush_paragraphs(
                buffer, spans, doc_id, current, span_index, char_start, match.start()
            )
            buffer = []
            char_start = match.end()

    _flush_paragraphs(buffer, spans, doc_id, current, span_index, char_start, len(text))
    return title, sections, spans


def _parse_html(path: Path, doc_id: str):
    soup = BeautifulSoup(path.read_text(encoding="utf-8", errors="ignore"), "html.parser")
    title = soup.title.string.strip() if soup.title and soup.title.string else path.stem
    sections = [Section(section_id="sec0", title="Document", role="unknown", level=1)]
    spans = []
    current = sections[0]
    span_index = 0

    for element in soup.find_all(["h1", "h2", "h3", "h4", "p", "li", "figcaption", "td", "th"]):
        text = element.get_text(" ", strip=True)
        if not text:
            continue
        if element.name in {"h1", "h2", "h3", "h4"}:
            current = Section(
                section_id=f"sec{len(sections)}",
                title=text,
                role=classify_section_role(text),
                level=int(element.name[1]),
            )
            sections.append(current)
            continue
        span_type = "figure_caption" if element.name == "figcaption" else "table" if element.name in {"td", "th"} else "paragraph"
        spans.append(_make_span(doc_id, current, span_index, text, span_type=span_type))
        span_index += 1

    return title, sections, spans


def _parse_pdf(path: Path, doc_id: str):
    try:
        import fitz
    except ImportError as exc:
        raise RuntimeError("PDF parsing requires pymupdf. Install requirements.txt first.") from exc

    pdf = fitz.open(str(path))
    title = path.stem
    sections = [Section(section_id="sec0", title="Document", role="unknown", level=1, page_start=1)]
    spans = []
    current = sections[0]
    span_index = 0
    char_cursor = 0

    for page_index, page in enumerate(pdf):
        blocks = page.get_text("blocks")
        blocks = sorted(blocks, key=lambda b: (b[1], b[0]))
        for block in blocks:
            text = re.sub(r"\s+", " ", block[4]).strip()
            if not text:
                continue
            if _looks_like_heading(text):
                current = Section(
                    section_id=f"sec{len(sections)}",
                    title=text[:180],
                    role=classify_section_role(text),
                    level=1,
                    page_start=page_index + 1,
                )
                sections.append(current)
                if title == path.stem and len(text.split()) <= 20:
                    title = text
                char_cursor += len(text) + 1
                continue
            span = _make_span(
                doc_id,
                current,
                span_index,
                text,
                page=page_index + 1,
                char_start=char_cursor,
                char_end=char_cursor + len(text),
            )
            spans.append(span)
            span_index += 1
            char_cursor += len(text) + 1

    return title, sections, spans


def _flush_paragraphs(buffer, spans, doc_id, section, span_index, char_start, char_end):
    if not buffer:
        return span_index
    text = " ".join(buffer).strip()
    if text:
        spans.append(
            _make_span(
                doc_id,
                section,
                span_index,
                text,
                char_start=char_start,
                char_end=char_end,
            )
        )
        span_index += 1
    return span_index


def _make_span(
    doc_id: str,
    section: Section,
    index: int,
    text: str,
    span_type: str = "paragraph",
    page=None,
    char_start=None,
    char_end=None,
) -> EvidenceSpan:
    return EvidenceSpan(
        span_id=f"{section.section_id}_span{index}",
        doc_id=doc_id,
        section_id=section.section_id,
        section_title=section.title,
        section_role=section.role,
        span_type=span_type,
        text=text,
        page=page,
        char_start=char_start,
        char_end=char_end,
        citations=CITATION_RE.findall(text),
    )


def _looks_like_heading(text: str) -> bool:
    if len(text) > 160 or len(text.split()) > 18:
        return False
    lower = text.lower().strip(" .:")
    if re.match(r"^\d+(\.\d+)*\s+[a-zA-Z]", text):
        return True
    return lower in {
        "abstract", "introduction", "related work", "method", "methods",
        "approach", "experiments", "evaluation", "results", "discussion",
        "conclusion", "limitations",
    }
