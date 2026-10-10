"""圖片處理：驗證、雜湊、存檔、送 AI 前的縮放與長截圖切段。"""

from __future__ import annotations

import hashlib
import io
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

# 防止惡意或異常巨大的圖片把記憶體吃光
Image.MAX_IMAGE_PIXELS = 80_000_000

_EXT_BY_FORMAT = {"JPEG": "jpg", "PNG": "png", "WEBP": "webp", "GIF": "gif", "BMP": "bmp", "TIFF": "tiff"}
_MIME_BY_FORMAT = {
    "JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp",
    "GIF": "image/gif", "BMP": "image/bmp", "TIFF": "image/tiff",
}


class InvalidImage(ValueError):
    """不是圖片或格式不支援。"""


class ImageTooLarge(ValueError):
    """檔案或像素太大。"""


@dataclass(frozen=True)
class ImageInfo:
    sha256: str
    dhash: str
    format: str
    ext: str
    mime_type: str
    width: int
    height: int
    size: int


def inspect_image(data: bytes) -> ImageInfo:
    if not data:
        raise InvalidImage("空檔案")
    try:
        with Image.open(io.BytesIO(data)) as img:
            fmt = (img.format or "").upper()
            img.load()
            width, height = img.size
            dh = dhash(img)
    except Image.DecompressionBombError as exc:
        raise ImageTooLarge("圖片像素過大") from exc
    except (UnidentifiedImageError, OSError, SyntaxError) as exc:
        raise InvalidImage("無法辨識的圖片格式") from exc
    if fmt not in _EXT_BY_FORMAT:
        raise InvalidImage(f"不支援的圖片格式：{fmt or '未知'}")
    return ImageInfo(
        sha256=hashlib.sha256(data).hexdigest(),
        dhash=dh,
        format=fmt,
        ext=_EXT_BY_FORMAT[fmt],
        mime_type=_MIME_BY_FORMAT[fmt],
        width=width,
        height=height,
        size=len(data),
    )


def dhash(img: Image.Image, size: int = 16) -> str:
    """差異雜湊（256 bit）。同一張圖重新壓縮後距離很小，用來提示「可能重複」。"""
    gray = ImageOps.exif_transpose(img).convert("L").resize((size + 1, size), Image.Resampling.LANCZOS)
    px = gray.tobytes()
    bits = 0
    for row in range(size):
        base = row * (size + 1)
        for col in range(size):
            bits = (bits << 1) | (1 if px[base + col] > px[base + col + 1] else 0)
    return f"{bits:0{size * size // 4}x}"


def hamming(a: str, b: str) -> int:
    return bin(int(a, 16) ^ int(b, 16)).count("1")


def store_original(data_dir: Path, rel_dir: Path, info: ImageInfo, data: bytes) -> str:
    """把原圖原封不動寫到持久化目錄，回傳相對於 data_dir 的路徑。

    先寫暫存檔再 rename，避免當機時留下半個檔案。
    """
    target_dir = data_dir / rel_dir
    target_dir.mkdir(parents=True, exist_ok=True)
    name = f"{info.sha256}.{info.ext}"
    target = target_dir / name
    if not target.exists():
        fd, tmp = tempfile.mkstemp(dir=target_dir, prefix=".tmp-")
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(data)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, target)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise
    return (rel_dir / name).as_posix()


# ---- 送 AI 前處理 ----

VISION_LONG_EDGE = 1568
TALL_RATIO = 2.6  # 高寬比超過這個值就視為長截圖，切段送出以免文字縮到看不清楚
MAX_SEGMENTS = 5


def prepare_for_vision(data: bytes) -> list[tuple[bytes, str]]:
    """回傳 [(jpeg_bytes, "image/jpeg"), ...]。長截圖會由上而下切成數段。"""
    with Image.open(io.BytesIO(data)) as img:
        img = ImageOps.exif_transpose(img)
        if img.mode not in ("RGB", "L"):
            background = Image.new("RGB", img.size, "white")
            rgba = img.convert("RGBA")
            background.paste(rgba, mask=rgba.split()[-1])
            img = background
        else:
            img = img.convert("RGB")
        width, height = img.size
        segments: list[Image.Image] = []
        if height / width > TALL_RATIO:
            seg_height = int(width * 2)
            count = -(-height // seg_height)
            if count > MAX_SEGMENTS:
                count = MAX_SEGMENTS
                seg_height = -(-height // count)
            overlap = int(seg_height * 0.04)
            for i in range(count):
                top = max(0, i * seg_height - overlap)
                bottom = min(height, (i + 1) * seg_height)
                segments.append(img.crop((0, top, width, bottom)))
        else:
            segments.append(img)

        out: list[tuple[bytes, str]] = []
        for seg in segments:
            seg = seg.copy()
            seg.thumbnail((VISION_LONG_EDGE, VISION_LONG_EDGE), Image.Resampling.LANCZOS)
            buf = io.BytesIO()
            seg.save(buf, format="JPEG", quality=85, optimize=True)
            out.append((buf.getvalue(), "image/jpeg"))
        return out
