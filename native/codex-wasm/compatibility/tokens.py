"""Small Rust token reader for bounded compatibility patterns, not a Rust parser."""

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class Token:
    value: str
    start: int
    end: int


_WORD = re.compile(r"[A-Za-z_][A-Za-z_0-9]*|[0-9][A-Za-z_0-9]*")
_RAW = re.compile(r'(?:br|cr|r)(#*)"')
_CHAR = re.compile(r"(?:b)?'(?:\\(?:u\{[0-9a-fA-F_]+\}|x[0-9a-fA-F]{2}|.)|[^'\\\n])'")
_JOINT = re.compile(r"::|->|=>|\.\.=|\.\.|&&|\|\||==|!=|<=|>=|<<|>>|[+*/%&|^!-]=")


def tokenize(source: str, toml: bool = False) -> list[Token]:
    result = []
    pos = 0
    while pos < len(source):
        start = pos
        if source[pos].isspace():
            pos += 1
            continue
        if toml and source[pos] == "#":
            end = source.find("\n", pos)
            pos = len(source) if end < 0 else end + 1
            continue
        if toml and source[pos] == "'":
            end = source.find("'", pos + 1)
            if end < 0:
                raise ValueError("unterminated TOML literal string")
            pos = end + 1
            result.append(Token(source[start:pos], start, pos))
            continue
        if source.startswith("//", pos):
            end = source.find("\n", pos)
            pos = len(source) if end < 0 else end + 1
            continue
        if source.startswith("/*", pos):
            depth = 1
            pos += 2
            while pos < len(source) and depth:
                if source.startswith("/*", pos):
                    depth += 1
                    pos += 2
                elif source.startswith("*/", pos):
                    depth -= 1
                    pos += 2
                else:
                    pos += 1
            if depth:
                raise ValueError("unterminated block comment")
            continue
        raw = _RAW.match(source, pos)
        char = _CHAR.match(source, pos)
        if raw:
            end = source.find('"' + raw[1], raw.end())
            if end < 0:
                raise ValueError("unterminated raw string")
            pos = end + 1 + len(raw[1])
        elif char:
            pos = char.end()
        elif source[pos] == '"' or source.startswith(('b"', 'c"'), pos):
            pos += 1 if source[pos] == '"' else 2
            while pos < len(source) and source[pos] != '"':
                pos += 2 if source[pos] == "\\" else 1
            if pos >= len(source):
                raise ValueError("unterminated string")
            pos += 1
        else:
            match = _WORD.match(source, pos) or _JOINT.match(source, pos)
            pos = match.end() if match else pos + 1
        result.append(Token(source[start:pos], start, pos))
    return result


def values(source: str, toml: bool = False) -> tuple[str, ...]:
    return tuple(token.value for token in tokenize(source, toml))


def occurrences(haystack: tuple[str, ...], needle: tuple[str, ...]) -> list[int]:
    if not needle:
        return []
    return [i for i, token in enumerate(haystack)
            if token == needle[0] and haystack[i:i + len(needle)] == needle]
