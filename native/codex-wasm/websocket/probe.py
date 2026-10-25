#!/usr/bin/env python3.13
"""Minimal probe only. Invoke through heavy-slot; never builds the engine."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
ASSETS = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from dependencies.wasi import _environment
from compatibility.tokens import occurrences, tokenize


def run(command, env, output):
    print(shlex.join(map(str, command)), flush=True)
    with (output / "build.log").open("a") as log:
        result = subprocess.run(command, env=env, stdout=log, stderr=subprocess.STDOUT)
    if result.returncode:
        print((output / "build.log").read_text()[-9000:])
        result.check_returncode()



def parent_context(output):
    official = ROOT / ".cache/sources/codex/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs"
    snippets = []
    evidence = []
    for relative, marker in [
        ("http-client/src/outbound_proxy.rs", "pub enum OutboundProxyRoute"),
        ("websocket-client/src/lib.rs", "pub(crate) enum TcpNodelay"),
        ("websocket-client/src/lib.rs", "fn is_loopback_destination"),
    ]:
        source = (official / relative).read_text()
        tokens = tokenize(source)
        values = tuple(token.value for token in tokens)
        matches = occurrences(values, tuple(token.value for token in tokenize(marker)))
        if len(matches) != 1:
            raise ValueError("ambiguous official connector context: " + marker)
        start = matches[0]
        opening = values.index("{", start)
        depth = 0
        for end in range(opening, len(tokens)):
            depth += (values[end] == "{") - (values[end] == "}")
            if depth == 0:
                break
        else:
            raise ValueError("unclosed official connector context: " + marker)
        snippet = source[tokens[start].start:tokens[end].end]
        snippets.append(snippet)
        evidence.append({"path": relative, "definition": marker,
                         "sourceSha256": hashlib.sha256(source.encode()).hexdigest(),
                         "snippetSha256": hashlib.sha256(snippet.encode()).hexdigest()})
    context = ('extern crate self as codex_http_client;\nuse std::net::IpAddr;\n'
               'use tokio_tungstenite::tungstenite::http::Uri;\n' + "\n".join(snippets))
    (output / "websocket/probe/parent_context.rs").write_text(context + "\n")
    (output / "connector-context.json").write_text(json.dumps(evidence, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--patch-map", type=Path)
    parser.add_argument("--native", action="store_true")
    args = parser.parse_args()
    output = args.output.resolve()
    if output.is_relative_to(ROOT) or ROOT.is_relative_to(output):
        raise ValueError("probe outputs must be isolated outside the wrapper and inputs")
    output.mkdir(parents=True, exist_ok=False)
    crates = output / "websocket"
    shutil.copytree(ASSETS, crates)
    installed_roots = list((ROOT / ".cache").glob("wasi-toolchain-*/rustup/toolchains/nightly-2026-03-01-*"))
    if len(installed_roots) != 1:
        raise ValueError("expected one existing private WASI SDK; probe never installs one")
    installed = installed_roots[0]
    toolchain = installed.parents[2]
    env = dict(os.environ)
    for key in ("RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER"):
        env.pop(key, None)
    env.update({"CARGO_HOME": str(toolchain / "cargo-home"), "RUSTUP_HOME": str(toolchain / "rustup"),
                "RUSTC": str(installed / "bin/rustc"), "RUSTDOC": str(installed / "bin/rustdoc"),
                "CARGO_TARGET_DIR": str(output / "target"), "CARGO_BUILD_JOBS": "2"})
    cargo = str(installed / "bin/cargo")
    if args.native:
        manifest = crates / "probe/Cargo.toml"
        run([cargo, "test", "--offline", "--jobs", "2", "--manifest-path", str(manifest)], env, output)
        return
    if not args.patch_map:
        parser.error("WASI requires the frozen --patch-map")
    parent_context(output)
    patches = json.loads(args.patch_map.read_text())["patches"]
    manifest = crates / "probe/Cargo.toml"
    native = manifest.read_text()
    dependencies = native[native.index("[dependencies]"):]
    entries = "\n".join(f'{json.dumps(key)} = {{ path = {json.dumps(patches[key])} }}'
                        for key in ("mio", "tokio", "libc"))
    manifest.write_text('[package]\nname="signalbox-host-websocket-probe"\nversion="0.1.0"\nedition="2024"\n'
                        '[workspace]\n[lib]\npath="wasi.rs"\ncrate-type=["cdylib"]\n'
                        '[profile.dev]\npanic="abort"\ndebug=0\n' + dependencies
                        + 'tokio = { version="=1.52.3", features=["rt","net","sync"] }\n'
                        + 'libc = "=0.2.186"\n[patch.crates-io]\n' + entries + '\n')
    # Copy all mutable std inputs. The installed SDK and frozen crates remain read-only.
    overlay = output / "rust-sysroot"
    lib = overlay / "lib/rustlib"
    lib.mkdir(parents=True)
    (overlay / "bin").symlink_to(installed / "bin", target_is_directory=True)
    for entry in (installed / "lib/rustlib").iterdir():
        if entry.name in ("src", "wasm32-wasip1"):
            shutil.copytree(entry, lib / entry.name, symlinks=True)
        else:
            (lib / entry.name).symlink_to(entry, target_is_directory=entry.is_dir())
    rustc = output / "rustc"
    rustc.write_text("#!/bin/sh\nexec " + shlex.join([str(installed / "bin/rustc"), "--sysroot", str(overlay)]) + ' "$@"\n')
    rustc.chmod(0o755)
    env.update(_environment(toolchain, shutil.which("rustup") or "rustup"))
    env.update({"RUSTC": str(rustc), "CARGO_TARGET_DIR": str(output / "target"),
                "RUSTDOC": str(installed / "bin/rustdoc"), "CARGO_BUILD_JOBS": "2"})
    env["CARGO_ENCODED_RUSTFLAGS"] = env["CARGO_ENCODED_RUSTFLAGS"].replace(
        "crt1-command.o", "crt1-reactor.o") + "\x1f-C\x1flink-arg=--export=_initialize"
    flags = ["--offline", "--manifest-path", str(manifest), "--target", "wasm32-wasip1",
             "-Z", "build-std=std,panic_abort", "--jobs", "2"]
    run([cargo, "check", *flags], env, output)
    for path in (output / "target/wasm32-wasip1/debug/deps").glob("libpanic_abort-*.*"):
        if path.suffix in (".rlib", ".rmeta"):
            shutil.copyfile(path, lib / "wasm32-wasip1/lib" / path.name)
    run([cargo, "build", *flags], env, output)
    artifact = output / "target/wasm32-wasip1/debug/signalbox_host_websocket_probe.wasm"
    report = {"scope": "minimal host WebSocket probe; not engine or parity proof", "artifact": str(artifact),
              "bytes": artifact.stat().st_size, "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
              "patchMap": str(args.patch_map.resolve()), "state": "compiled-linked-runtime-pending"}
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
