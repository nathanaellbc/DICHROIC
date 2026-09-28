#!/usr/bin/env python3
"""Bandingkan `FIELDS` di params.ts terhadap blok push-constant CoreParams hulu.

Task 7 memutuskan `CoreParams` punya 26 field skalar, tiga di antaranya
(slot0/slot1/slot2) adalah slot serbaguna yang diberi nama netral karena
hulu sendiri tidak sepakat soal namanya (lihat komentar di params.ts).
Penjaga waktu-kompilasi di params.ts menangkap satu mode kegagalan --
`CoreParams` mendapat field baru tanpa entri di `FIELDS` -- tapi tidak ada
apa pun yang mengikat *urutan* `FIELDS` ke blok hulu. Kalau seseorang
menyusun ulang `FIELDS` dan "memperbaiki" params.test.ts dengan menyusun
ulang `EXPECTED_FIELDS` di sana agar cocok, struct menyimpang dari hulu
secara senyap dan setiap shader dari Task 9 ke atas membaca nilai yang
bergeser -- test tetap hijau karena test hanya membandingkan implementasi
dengan dirinya sendiri.

Skrip ini adalah pemeriksaan independen yang tidak bisa "diperbaiki" dengan
cara itu, mengikuti pola `compare_cpp.py` (Task 4): baca ground truth dari
repo hulu langsung, bandingkan, keluar non-zero kalau berbeda. Tidak
dijalankan dari `npm test` (params.test.ts tidak punya akses ke checkout
hulu, dan CI tidak punya akses ke sana sama sekali -- sama seperti alasan
compare_cpp.py berdiri sendiri) -- ini pemeriksaan manual/CI-terpisah,
bukan gate `npm test`.

Yang diperiksa:

1. Kedelapan shader hulu yang berbagi blok CoreParams (SpektraCurveDevelop,
   SpektraDiffusion, SpektraDir, SpektraFilmExposure, SpektraGrain,
   SpektraHalation, SpektraPrintScan, SpektraScannerPost) punya 26 field.
2. Kedelapan shader itu SEPAKAT satu sama lain soal TIPE di setiap posisi,
   dan soal NAMA di setiap posisi KECUALI tiga slot (indeks 13/14/15) --
   di situ nama lokal memang boleh berbeda (itulah temuan Task 7: upstream
   tidak sepakat dengan dirinya sendiri soal nama slot ini).
3. `FIELDS` di params.ts sepakat dengan blok referensi (SpektraCurveDevelop)
   soal TIPE di semua 26 posisi, dan soal NAMA di 23 posisi non-slot.
4. `slot0`/`slot1`/`slot2` di params.ts benar-benar berada di posisi
   `_pad0`/`_pad1`/`_pad2` hulu (indeks 13/14/15) -- pemeriksaan #3 di atas
   MELEWATKAN nama pada tiga indeks ini dengan sengaja, jadi kalau
   `FIELDS` menyusun ulang slot0 dan slot1 (keduanya `u32`, sama-sama lolos
   pemeriksaan tipe), pemeriksaan ini secara khusus menangkap itu dengan
   mengikat setiap nama `slotN` ke indeks `13 + N`, bukan ke urutan
   relatifnya sendiri.

Cara pakai:

    SPEKTRAFILM_OFX=D:/Projects/upstream/spektrafilm-ofx \\
      python3 tools/compare_params.py

Keluar dengan kode 0 kalau semua pemeriksaan cocok, 1 kalau ada yang tidak
(nama field yang menyimpang disebutkan di baris FAIL-nya), 2 kalau
SPEKTRAFILM_OFX tidak diset atau salah satu berkas shader hulu tidak
ditemukan.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
SPEKTRA_ROOT = TOOLS_DIR.parent
DEFAULT_PARAMS_TS = SPEKTRA_ROOT / "src" / "engine" / "params.ts"

# Shader hulu yang memakai blok push-constant CoreParams 26-skalar yang
# sama persis -- diverifikasi manual selama Task 7 (grep tiap berkas untuk
# "layout(push_constant)"). SpektraCopy.comp dan SpektraFormatConvert.comp
# SENGAJA tidak di sini: keduanya punya blok push-constant sendiri yang
# jauh lebih kecil dan tidak berhubungan (CopyParams/FormatConvertParams).
SHARED_BLOCK_SHADERS: list[str] = [
    "SpektraCurveDevelop.comp",
    "SpektraDiffusion.comp",
    "SpektraDir.comp",
    "SpektraFilmExposure.comp",
    "SpektraGrain.comp",
    "SpektraHalation.comp",
    "SpektraPrintScan.comp",
    "SpektraScannerPost.comp",
]
REFERENCE_SHADER = "SpektraCurveDevelop.comp"

EXPECTED_FIELD_COUNT = 26

# Indeks 0-based tempat tiga slot serbaguna berada (upstream: _pad0/_pad1/
# _pad2). Nama lokal DIBIARKAN berbeda di sini saat membandingkan antar
# shader -- itulah alasan slot ini ada. params.ts memakai slot0/slot1/slot2
# yang diikat balik ke indeks ini secara terpisah lewat check_slot_binding().
SLOT_START_INDEX = 13
SLOT_INDICES = {SLOT_START_INDEX, SLOT_START_INDEX + 1, SLOT_START_INDEX + 2}

GLSL_TO_WGSL_KIND = {"uint": "u32", "int": "i32", "float": "f32"}

PUSH_CONSTANT_RE = re.compile(
    r"layout\(push_constant\)\s+uniform\s+CoreParams\s*\{(.*?)\}\s*\w+;", re.S
)
FIELD_LINE_RE = re.compile(r"\b(uint|int|float)\s+(\w+)\s*;")
TS_FIELDS_ARRAY_RE = re.compile(r"const FIELDS\s*=\s*\[(.*?)\]\s*as const", re.S)
TS_FIELD_ENTRY_RE = re.compile(r"\[\s*'(\w+)'\s*,\s*'(u32|i32|f32)'\s*\]")

Field = tuple[str, str]  # (name, kind)


def parse_glsl_block(text: str, source: str) -> list[Field]:
    m = PUSH_CONSTANT_RE.search(text)
    if m is None:
        raise ValueError(
            f"{source}: no 'layout(push_constant) uniform CoreParams {{ ... }}' block found"
        )
    fields: list[Field] = []
    for kind, name in FIELD_LINE_RE.findall(m.group(1)):
        fields.append((name, GLSL_TO_WGSL_KIND[kind]))
    return fields


def parse_ts_fields(text: str, source: str) -> list[Field]:
    m = TS_FIELDS_ARRAY_RE.search(text)
    if m is None:
        raise ValueError(f"{source}: no 'const FIELDS = [ ... ] as const' array found")
    return TS_FIELD_ENTRY_RE.findall(m.group(1))


class Report:
    def __init__(self) -> None:
        self.rows: list[tuple[str, str]] = []
        self.all_ok = True

    def add(self, label: str, ok: bool, detail: str = "") -> None:
        status = "PASS" if ok else f"FAIL({detail})" if detail else "FAIL"
        self.rows.append((label, status))
        self.all_ok = self.all_ok and ok

    def print(self) -> None:
        print()
        width = max((len(label) for label, _ in self.rows), default=0)
        for label, status in self.rows:
            print(f"{label:<{width}}  {status}")
        print()
        print(f"{len(self.rows)} checks: {'ALL PASS' if self.all_ok else 'SOME FAILED'}")


def compare_sequences(
    reference: list[Field],
    other: list[Field],
    *,
    other_label: str,
    reference_label: str,
    skip_name_at: set[int],
) -> list[str]:
    """Bandingkan dua urutan field posisi-demi-posisi. Mengembalikan daftar
    pesan mismatch (kosong berarti cocok). Posisi di `skip_name_at` hanya
    diperiksa tipenya, bukan namanya -- lihat SLOT_INDICES di atas."""
    mismatches: list[str] = []
    if len(other) != len(reference):
        mismatches.append(
            f"jumlah field {len(other)} ({other_label}) != {len(reference)} ({reference_label})"
        )
    for i, ((ref_name, ref_kind), (got_name, got_kind)) in enumerate(zip(reference, other)):
        if got_kind != ref_kind:
            mismatches.append(
                f"#{i} tipe {got_name}:{got_kind} ({other_label}) != {ref_name}:{ref_kind} ({reference_label})"
            )
        elif i not in skip_name_at and got_name != ref_name:
            mismatches.append(
                f"#{i} nama {got_name} ({other_label}) != {ref_name} ({reference_label})"
            )
    return mismatches


def check_slot_binding(ts_fields: list[Field]) -> list[str]:
    """params.ts harus menamai slot0/slot1/slot2 tepat di indeks
    13/14/15 -- pemeriksaan bertipe di compare_sequences() MELEWATKAN nama
    pada indeks ini dengan sengaja, jadi kalau seseorang menyusun ulang
    slot0 dan slot1 di FIELDS (keduanya 'u32', sama-sama lolos pemeriksaan
    tipe), TIDAK ADA pemeriksaan lain yang menangkapnya. Ini yang menangkap
    itu, dengan mengikat nama ke indeks absolut, bukan ke urutan relatif
    slot0/1/2 satu sama lain."""
    mismatches: list[str] = []
    for offset in range(3):
        index = SLOT_START_INDEX + offset
        expected_name = f"slot{offset}"
        if index >= len(ts_fields):
            mismatches.append(f"indeks {index} tidak ada di FIELDS (mengharapkan {expected_name})")
            continue
        got_name, _ = ts_fields[index]
        if got_name != expected_name:
            mismatches.append(f"indeks {index}: nama {got_name} != {expected_name}")
    return mismatches


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--params-ts",
        type=Path,
        default=DEFAULT_PARAMS_TS,
        help="Path ke params.ts (default: src/engine/params.ts)",
    )
    args = parser.parse_args()

    ofx = os.environ.get("SPEKTRAFILM_OFX")
    if not ofx:
        print(
            "SPEKTRAFILM_OFX tidak diset -- diperlukan untuk menemukan shader .comp hulu.",
            file=sys.stderr,
        )
        return 2
    shader_dir = Path(ofx) / "shaders" / "vulkan"

    try:
        ts_fields = parse_ts_fields(
            args.params_ts.read_text(encoding="utf-8"), str(args.params_ts)
        )
    except (OSError, ValueError) as exc:
        print(f"gagal membaca {args.params_ts}: {exc}", file=sys.stderr)
        return 2

    shader_fields: dict[str, list[Field]] = {}
    for name in SHARED_BLOCK_SHADERS:
        path = shader_dir / name
        if not path.exists():
            print(f"shader hulu tidak ditemukan: {path}", file=sys.stderr)
            return 2
        try:
            shader_fields[name] = parse_glsl_block(path.read_text(encoding="utf-8"), name)
        except ValueError as exc:
            print(str(exc), file=sys.stderr)
            return 2

    report = Report()

    # 1. Setiap shader yang berbagi blok harus punya 26 field.
    for name, fields in shader_fields.items():
        report.add(
            f"{name}: jumlah field == {EXPECTED_FIELD_COUNT}",
            len(fields) == EXPECTED_FIELD_COUNT,
            f"punya {len(fields)}" if len(fields) != EXPECTED_FIELD_COUNT else "",
        )

    reference = shader_fields[REFERENCE_SHADER]

    # 2. Kedelapan shader sepakat satu sama lain soal urutan & tipe (nama
    #    boleh berbeda hanya di tiga slot).
    for name, fields in shader_fields.items():
        if name == REFERENCE_SHADER:
            continue
        mismatches = compare_sequences(
            reference,
            fields,
            other_label=name,
            reference_label=REFERENCE_SHADER,
            skip_name_at=SLOT_INDICES,
        )
        report.add(
            f"{name} sepakat dengan {REFERENCE_SHADER} (urutan & tipe)",
            not mismatches,
            "; ".join(mismatches),
        )

    # 3. params.ts FIELDS sepakat dengan blok referensi hulu soal tipe di
    #    semua 26 posisi, dan nama di 23 posisi non-slot.
    mismatches = compare_sequences(
        reference,
        ts_fields,
        other_label="params.ts FIELDS",
        reference_label=REFERENCE_SHADER,
        skip_name_at=SLOT_INDICES,
    )
    report.add(
        f"params.ts FIELDS sepakat dengan {REFERENCE_SHADER} (urutan & tipe)",
        not mismatches,
        "; ".join(mismatches),
    )

    # 4. slot0/slot1/slot2 di params.ts benar-benar berada di indeks
    #    13/14/15 -- lihat docstring check_slot_binding().
    slot_mismatches = check_slot_binding(ts_fields)
    report.add(
        "params.ts slot0/slot1/slot2 terikat ke indeks _pad0/_pad1/_pad2 (13/14/15)",
        not slot_mismatches,
        "; ".join(slot_mismatches),
    )

    report.print()
    return 0 if report.all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
