"""Penulis berkas fixture bersama untuk generator di tools/.

Diekstrak dari gen_reference.py (Fase 2B) supaya generator yang tidak
membutuhkan spektrafilm (gen_io_reference.py, gen_raw_reference.py) bisa
jalan di venv tanpa paket hulu: mengimpor gen_reference ikut mengimpor
spektrafilm. Hanya stdlib.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


def _write_json_lf(path: Path, obj, *, sort_keys: bool = False) -> None:
    """Write JSON with LF-only line endings, regardless of platform.

    Path.write_text() opens in text mode, which on Windows translates
    every '\\n' to os.linesep ('\\r\\n') -- the file this script produces
    would differ byte-for-byte from the one a Linux/macOS run produces,
    even though the content is identical. That's exactly what the sha256
    manifest is supposed to catch as a *real* difference, so it must
    never be true of a platform quirk. Building the string with '\\n' and
    writing it as bytes bypasses newline translation entirely -- the
    generator now produces the same bytes on every platform, which is
    what the checked-in .gitattributes (text eol=lf for this directory)
    also enforces from git's side of a checkout.
    """
    path.write_bytes(
        (json.dumps(obj, indent=2, sort_keys=sort_keys) + "\n").encode("utf-8")
    )


def _write_manifest(out_dir: Path) -> None:
    """Write test/fixtures/manifest.json: sha256 of every fixture file
    currently on disk under ``out_dir``.

    Scans the actual filesystem rather than just the files this
    invocation wrote, so the manifest always reflects reality -- a
    partial run (--case) still produces a manifest that matches disk
    exactly, and fixtures.test.ts can check every entry, not just the
    ones most recently regenerated. This is what turns the one-off manual
    determinism proof into something a regression can't silently pass:
    anyone who regenerates and gets a different hash knows immediately
    that something changed upstream, in the venv, or in this script.
    """
    manifest = {
        f.relative_to(out_dir).as_posix(): hashlib.sha256(f.read_bytes()).hexdigest()
        for f in sorted(out_dir.rglob("*"))
        if f.is_file() and f.name != "manifest.json"
    }
    _write_json_lf(out_dir / "manifest.json", manifest, sort_keys=True)
    print(f"Wrote {out_dir / 'manifest.json'} ({len(manifest)} files)")
