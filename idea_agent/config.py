from pathlib import Path
from typing import Any, Dict, Optional
import os


def load_config(config_path: Optional[Path] = None) -> Dict[str, Any]:
    path = resolve_config_path(config_path)
    if path is None or not path.exists():
        return {}
    return parse_simple_yaml(path.read_text(encoding="utf-8"))


def resolve_config_path(config_path: Optional[Path] = None) -> Optional[Path]:
    if config_path is not None:
        return Path(config_path)

    env_path = os.getenv("IDEA_AGENT_CONFIG")
    if env_path:
        return Path(env_path)

    candidates = [
        Path.cwd() / "config.yaml",
        Path(__file__).resolve().parents[1] / "config.yaml",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[-1]


def parse_simple_yaml(text: str) -> Dict[str, Any]:
    root: Dict[str, Any] = {}
    stack = [(-1, root)]

    for raw_line in text.splitlines():
        line = _strip_comment(raw_line).rstrip()
        if not line.strip():
            continue

        indent = len(line) - len(line.lstrip(" "))
        item = line.strip()
        if ":" not in item:
            continue

        key, raw_value = item.split(":", 1)
        key = key.strip()
        raw_value = raw_value.strip()

        while len(stack) > 1 and indent <= stack[-1][0]:
            stack.pop()

        parent = stack[-1][1]
        if raw_value == "":
            value: Dict[str, Any] = {}
            parent[key] = value
            stack.append((indent, value))
        else:
            parent[key] = _parse_scalar(raw_value)

    return root


def _strip_comment(line: str) -> str:
    in_single = False
    in_double = False
    for index, char in enumerate(line):
        if char == "'" and not in_double:
            in_single = not in_single
        elif char == '"' and not in_single:
            in_double = not in_double
        elif char == "#" and not in_single and not in_double:
            return line[:index]
    return line


def _parse_scalar(value: str) -> Any:
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        return value[1:-1]

    lowered = value.lower()
    if lowered in {"true", "yes"}:
        return True
    if lowered in {"false", "no"}:
        return False
    if lowered in {"null", "none", "~"}:
        return None

    try:
        if "." in value:
            return float(value)
        return int(value)
    except ValueError:
        return value
