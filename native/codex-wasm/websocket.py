"""Structural host-WebSocket overlay for a wrapper-owned Codex compile copy.

The official input stays immutable. Native cfg paths keep the upstream dialer,
connection alias, policy revocation and cookie handling. Unknown source shapes
require an explicit compatibility update (#1072).
"""

import difflib
import json
from pathlib import Path
import tomllib

from compatibility.tokens import Token, occurrences, tokenize
from overlay import OverlayError, _owned_path, _shape

_ASSETS = Path(__file__).resolve().parent / "websocket"
_MODULE = "codex-rs/websocket-client/src/signalbox_websocket"
_REQUIRED = {"mod.rs", "abi.rs", "codec.rs", "transport.rs"}
_TARGETS = {"wasm32-wasip1", "wasm32-wasip1-threads"}


def _rules():
    return json.loads((_ASSETS / "rules.json").read_text())["rules"]


def _tokens(source):
    # Rust parses adjacent generic closers independently, including with trivia between them.
    return [part for token in tokenize(source) for part in (
        [Token(">", token.start, token.start + 1), Token(">", token.start + 1, token.end)]
        if token.value == ">>" else [token])]


def _values(source):
    return tuple(token.value for token in _tokens(source))


def _text(rule, key):
    return "\n".join(rule[key]) + "\n"


def _locate(source, rule):
    tokens = _values(source)
    before, after = (_values(_text(rule, key)) for key in ("before", "after"))
    old, new = occurrences(tokens, before), occurrences(tokens, after)
    if len(new) == 1:
        start = new[0]
        if any(i < start or i + len(before) > start + len(after) for i in old):
            _shape(rule, "both old and WASI structures exist")
        return True, start, start + len(after)
    if len(new) > 1 or len(old) != 1:
        _shape(rule, f"expected exactly one old or WASI structure, found {len(old)}/{len(new)}")
    return False, old[0], old[0] + len(before)


def _replace(source, rule):
    done, offset, _ = _locate(source, rule)
    if done:
        return source
    before = _tokens(_text(rule, "before"))
    after_text = _text(rule, "after")
    after, current = _tokens(after_text), _tokens(source)
    matcher = difflib.SequenceMatcher(a=[t.value for t in before],
                                     b=[t.value for t in after], autojunk=False)
    for kind, a, b, c, d in reversed(matcher.get_opcodes()):
        if kind == "equal":
            continue
        start = current[offset + a].start if a < len(before) else current[offset + a - 1].end
        end = current[offset + b - 1].end if b > a else start
        replacement = after_text[after[c].start:after[d - 1].end] if d > c else ""
        if kind == "insert":
            left = after[c - 1].end if c else after[c].start
            right = after[d].start if d < len(after) else after[d - 1].end
            replacement = after_text[left:right]
        source = source[:start] + replacement + source[end:]
    return source


def _validate(source, rules):
    matches = [(rule, *_locate(source, rule)) for rule in rules]
    # A separate WASI arm could bypass our dialer or change ownership semantics.
    tokens = _tokens(source)
    depth = 0
    depths = []
    for token in tokens:
        depths.append(depth)
        depth += (token.value == "{") - (token.value == "}")
    for rule, done, start, _ in matches:
        top_level = rule["rule"] in {"dialer-module", "connection-alias"} or rule["rule"].startswith("native-import-")
        if top_level and (depths[start] != 0 or (not done and start and tokens[start - 1].value in {"]", "pub"})):
            _shape(rule, "unrecognized item scope or attributes")
    for index, token in enumerate(tokens):
        if token.value == '"wasi"' and not any(
                done and start <= index < end for _, done, start, end in matches):
            _shape(rules[0], "unrecognized WASI structure")
    return matches


def apply_websocket_overlay(source: Path, target: str) -> list[dict]:
    """Validate every edit and asset before writing an independent compile copy.

    ``source`` is the exported compile root containing codex-rs, never a Git
    checkout. Reapplication is a no-op. Shape failures write nothing; discard the
    copy after an IO failure during writing, as with the existing compile overlay.
    """
    if target not in _TARGETS:
        raise OverlayError(f"unsupported WebSocket overlay target: {target!r}")
    source = Path(source)
    if source.is_symlink():
        raise OverlayError("WebSocket overlay requires an independent directory")
    source = source.resolve(strict=True)
    if not source.is_dir() or any(
            marker.exists() or marker.is_symlink()
            for marker in (source / ".git", source / "codex-rs/.git")):
        raise OverlayError("WebSocket overlay requires a copied source without .git")
    manifest = _owned_path(source, "codex-rs/Cargo.toml")
    try:
        package = tomllib.loads(manifest.read_text())["workspace"]["package"]
        if not isinstance(package, dict) or not isinstance(package.get("version"), str):
            raise ValueError("missing workspace package version")
    except (KeyError, ValueError) as error:
        raise OverlayError(f"invalid Codex workspace manifest: {error}") from error
    rules = _rules()
    path = _owned_path(source, rules[0]["path"])
    if not path.is_file():
        _shape(rules[0], "missing WebSocket client source")
    original = path.read_text()
    try:
        matches = _validate(original, rules)
        output = original
        applied = [rule for rule, done, _, _ in matches if not done]
        for rule in applied:
            output = _replace(output, rule)
        if not all(done for _, done, _, _ in _validate(output, rules)):
            _shape(rules[0], "unexpected overlay result")
    except ValueError as error:
        if isinstance(error, OverlayError):
            raise
        _shape(rules[0], f"cannot tokenize source: {error}")
    assets = {p.name: p for p in _ASSETS.glob("*.rs")}
    if not _REQUIRED <= assets.keys():
        raise OverlayError("WebSocket transport assets are incomplete")
    module = _owned_path(source, _MODULE + "/mod.rs").parent
    if module.exists() and (not module.is_dir() or any(
            p.name not in assets for p in module.iterdir())):
        _shape(rules[0], "unrecognized host WebSocket module entries")
    pending = [(path, output)] if applied else []
    changes = [{"path": rule["path"], "rule": rule["rule"]} for rule in applied]
    for name, asset in sorted(assets.items()):
        destination = _owned_path(source, _MODULE + "/" + name)
        desired = asset.read_text()
        if destination.exists():
            if _values(destination.read_text()) != _values(desired):
                _shape(rules[0], f"existing host WebSocket asset differs: {name}")
        else:
            pending.append((destination, desired))
            changes.append({"path": str(destination.relative_to(source)),
                            "rule": "host-websocket-asset"})
    # No writes, including mkdir, occur before every structure and asset validates.
    if pending:
        module.mkdir(exist_ok=True)
    for destination, output in pending:
        destination.write_text(output)
    return changes
