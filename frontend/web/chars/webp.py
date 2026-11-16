#!/usr/bin/env python3
"""화면 표시용 WebP를 PNG 원본 옆에 만든다(T180). PNG는 그대로 둔다 — 쇼츠 캔버스 렌더와 쇼츠 Worker, 차량 drawable의 원본이다.

    python3 frontend/web/chars/webp.py     # Pillow(WebP 지원)가 있어야 한다

같은 픽셀 크기(1254×1254 RGBA), 손실 압축 quality 90(알파는 무손실). 원본을 고치면 다시 돌려 WebP도 같이 올린다.
"""
from pathlib import Path

from PIL import Image

HERE = Path(__file__).parent
QUALITY = 90

for png in sorted(HERE.glob("*.png")):
    webp = png.with_suffix(".webp")
    with Image.open(png) as source:
        source.save(webp, "WEBP", quality=QUALITY, method=6)
        with Image.open(webp) as made:
            assert made.size == source.size and made.mode == source.mode, f"{webp.name}: 크기나 알파가 원본과 다릅니다"
    before, after = png.stat().st_size, webp.stat().st_size
    print(f"{png.stem:<16} {before:>7} → {after:>6} bytes ({after / before:.0%})")
