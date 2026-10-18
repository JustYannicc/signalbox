"""Bounded compile overlay for an independent, wrapper-owned Codex source copy.

Rules come from DigiBugCat/codex-wasi-agentos at
45eca7daf24bbac603689cc3229693310d184e51, patches 0006, 0002 (app-server
shutdown only), and 0001 (native dependency gates only). No runtime policy or
CLI replacement is included. Unknown source shapes require a rule edit (#1072).
"""

import difflib
import json
from pathlib import Path
from typing import NoReturn

from compatibility.tokens import occurrences, tokenize, values


class OverlayError(ValueError):
    """The copied source no longer satisfies a compatibility rule."""


_RULES = Path(__file__).parent / "compatibility"
_TARGETS = {"wasm32-wasip1"}


def _rules() -> list[dict]:
    return [rule for path in sorted(_RULES.glob("*.json"))
            for rule in json.loads(path.read_text())["rules"]]


def _shape(rule: dict, message: str) -> NoReturn:
    raise OverlayError(f"{rule['path']} [{rule['rule']}]: {message}; "
                       "compatibility rule needs an edit (#1072)")


def _text(rule: dict, key: str) -> str:
    return "\n".join(rule[key]) + "\n"


def _locate(source: str, rule: dict) -> tuple[bool, int, int]:
    toml = rule["path"].endswith(".toml")
    tokens = values(source, toml)
    before = values(_text(rule, "before"), toml)
    after = values(_text(rule, "after"), toml)
    old = occurrences(tokens, before)
    new = occurrences(tokens, after)
    if len(new) == 1:
        start = new[0]
        if any(i < start or i + len(before) > start + len(after) for i in old):
            _shape(rule, "both old and WASI structures exist")
        return True, start, start + len(after)
    if len(new) > 1 or len(old) != 1:
        _shape(rule, f"expected exactly one old or WASI structure, found {len(old)}/{len(new)}")
    return False, old[0], old[0] + len(before)


def _validate(source: str, rules: list[dict]) -> list[tuple[dict, bool, int, int]]:
    matches = [(rule, *_locate(source, rule)) for rule in rules]
    toml = rules[0]["path"].endswith(".toml")
    tokens = tokenize(source, toml)
    for index, token in enumerate(tokens):
        platform_arm = token.value in ('"wasi"', "wasi") or (toml and '"wasi"' in token.value)
        if platform_arm and not any(
                done and start <= index < end for _, done, start, end in matches):
            _shape(rules[0], "unrecognized WASI arm outside the accepted structures")
    return matches


def _replace(source: str, rule: dict) -> str:
    toml = rule["path"].endswith(".toml")
    before = tokenize(_text(rule, "before"), toml)
    after_text = _text(rule, "after")
    after = tokenize(after_text, toml)
    current = tokenize(source, toml)
    done, offset, _ = _locate(source, rule)
    if done:
        return source
    matcher = difflib.SequenceMatcher(
        a=[token.value for token in before], b=[token.value for token in after],
        autojunk=False,
    )
    # Edit only changed tokens. Comments and whitespace in unchanged anchors survive.
    for kind, a, b, c, d in reversed(matcher.get_opcodes()):
        if kind == "equal":
            continue
        start = current[offset + a].start if a < len(before) else current[offset + a - 1].end
        end = current[offset + b - 1].end if b > a else start
        replacement = after_text[after[c].start:after[d - 1].end] if d > c else ""
        if kind == "insert":
            # Trivia comes from the desired token boundary. An arbitrary newline
            # would split TOML dotted keys such as [target.'cfg(...)'.dependencies].
            left = after[c - 1].end if c else after[c].start
            right = after[d].start if d < len(after) else after[d - 1].end
            replacement = after_text[left:right]
        source = source[:start] + replacement + source[end:]
    return source


def _owned_path(root: Path, relative: str) -> Path:
    path = root / relative
    for part in (path, *path.parents):
        if part == root:
            break
        if part.is_symlink():
            raise OverlayError(f"overlay requires copied files, found symlink: {part}")
    if path.exists() and (not path.is_file() or path.stat().st_nlink != 1):
        raise OverlayError(f"overlay requires independent regular files: {path}")
    return path


def apply_overlay(root: Path, target: str) -> list[dict]:
    """Validate all rules, then modify a copied Codex root (containing codex-rs).

    Returns only applied changes, each with path and rule. Reapplying is a no-op.
    Source-shape failures write nothing. Filesystem/IO failures during writing are
    not transactional; the wrapper should discard that copy and prepare a new one.
    Git checkouts, symlinked paths, and hard-linked input files are refused.
    """
    if target not in _TARGETS:
        raise OverlayError(f"unsupported overlay target: {target!r}")
    if root.is_symlink():
        raise OverlayError("overlay root must be an independent directory")
    root = root.resolve(strict=True)
    if not root.is_dir() or (root / ".git").exists() or (root / ".git").is_symlink():
        raise OverlayError("overlay requires a wrapper-owned copy without .git")
    grouped = {}
    for rule in _rules():
        grouped.setdefault(rule["path"], []).append(rule)
    pending = []
    changes = []
    for relative, rules in grouped.items():
        path = _owned_path(root, relative)
        if "asset" in rules[0]:
            rule = rules[0]
            desired = (_RULES / rule["asset"]).read_text()
            if path.exists():
                if values(path.read_text()) != values(desired):
                    _shape(rule, "existing WASI module differs")
                continue
            # All other source files must exist, so a missing parent is a shape change.
            if not path.parent.is_dir():
                _shape(rule, "missing module directory")
            output = desired
            applied = [rule]
        else:
            if not path.is_file():
                _shape(rules[0], "missing source file")
            original = path.read_text()
            try:
                matches = _validate(original, rules)
                output = original
                applied = [rule for rule, done, _, _ in matches if not done]
                for rule in applied:
                    output = _replace(output, rule)
                if not all(done for _, done, _, _ in _validate(output, rules)):
                    _shape(rules[0], "overlay did not produce the expected structures")
            except ValueError as error:
                if isinstance(error, OverlayError):
                    raise
                _shape(rules[0], f"cannot tokenize source: {error}")
        if applied:
            pending.append((path, output))
            changes.extend({"path": relative, "rule": rule["rule"]} for rule in applied)
    # No source writes occur until every file, including new modules, is validated.
    for path, output in pending:
        path.write_text(output)
    return changes
