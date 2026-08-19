#!/usr/bin/env python3
"""Generate simple PNG icons for the Chrome extension."""

from __future__ import annotations

import struct
import zlib
from pathlib import Path


def png_chunk(chunk_type: bytes, data: bytes) -> bytes:
    chunk = chunk_type + data
    return (
        struct.pack(">I", len(data))
        + chunk
        + struct.pack(">I", zlib.crc32(chunk) & 0xFFFFFFFF)
    )


def write_png(path: Path, size: int, rgb: tuple[int, int, int]) -> None:
    # Solid rounded-ish square with accent color + white "P"
    raw = bytearray()
    r, g, b = rgb
    for y in range(size):
        raw.append(0)  # filter none
        for x in range(size):
            # margin
            m = max(1, size // 8)
            inside = m <= x < size - m and m <= y < size - m
            # simple "P" glyph via rectangles
            is_p = False
            if inside:
                left = size * 0.32
                right = size * 0.68
                top = size * 0.28
                bot = size * 0.72
                stem_w = size * 0.14
                bowl_h = size * 0.28
                if left <= x <= left + stem_w and top <= y <= bot:
                    is_p = True
                if left <= x <= right and top <= y <= top + size * 0.12:
                    is_p = True
                if left <= x <= right and top + bowl_h <= y <= top + bowl_h + size * 0.12:
                    is_p = True
                if right - stem_w <= x <= right and top <= y <= top + bowl_h + size * 0.12:
                    is_p = True

            if is_p:
                pr, pg, pb, pa = 250, 252, 251, 255
            elif inside:
                pr, pg, pb, pa = r, g, b, 255
            else:
                pr, pg, pb, pa = 0, 0, 0, 0
            raw.extend([pr, pg, pb, pa])

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    data = b"".join(
        [
            b"\x89PNG\r\n\x1a\n",
            png_chunk(b"IHDR", ihdr),
            png_chunk(b"IDAT", zlib.compress(bytes(raw), 9)),
            png_chunk(b"IEND", b""),
        ]
    )
    path.write_bytes(data)


def main() -> None:
    out = Path(__file__).resolve().parent / "icons"
    out.mkdir(parents=True, exist_ok=True)
    color = (26, 107, 92)  # accent
    for size in (16, 48, 128):
        write_png(out / f"icon{size}.png", size, color)
        print(f"wrote icon{size}.png")


if __name__ == "__main__":
    main()
