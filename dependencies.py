import os
import uuid
import bcrypt as _bcrypt
import database as models
from fastapi import UploadFile
from sqlalchemy.orm import Session
from typing import Optional
from config import UPLOAD_DIR


def get_db():
    session = models.SessionLocal()
    try:
        yield session
    finally:
        session.close()


def _hash_pw(password: str) -> str:
    return _bcrypt.hashpw(password.encode(), _bcrypt.gensalt()).decode()


def _verify_pw(password: str, hashed: str) -> bool:
    return _bcrypt.checkpw(password.encode(), hashed.encode())


async def save_uploaded_file(file: UploadFile, prefix: str) -> Optional[str]:
    if not file or not file.filename:
        return None
    content = await file.read()
    ext = ".jpg"
    try:
        from PIL import Image as _Img, ImageOps as _IOps
        import io as _io
        img = _Img.open(_io.BytesIO(content))
        img = _IOps.exif_transpose(img)
        img.thumbnail((1200, 1200), _Img.LANCZOS)
        out = _io.BytesIO()
        img.convert("RGB").save(out, format="JPEG", quality=80, optimize=True)
        content = out.getvalue()
    except Exception:
        ext = os.path.splitext(file.filename)[1]
    filename = f"{prefix}_{uuid.uuid4()}{ext}"
    path = os.path.join(UPLOAD_DIR, filename)
    with open(path, "wb") as buf:
        buf.write(content)
    return f"/static/uploads/{filename}"


MAX_VIDEO_BYTES = 200 * 1024 * 1024  # 200 MB — generous for a phone clip, cheap insurance against filling the disk
_VIDEO_EXTENSIONS = {".mp4", ".mov", ".webm", ".m4v"}


async def save_uploaded_video(file: UploadFile, prefix: str) -> Optional[str]:
    """Streams to disk in chunks (unlike save_uploaded_file's photos, which get re-encoded and
    shrunk anyway) so a large video clip is never fully buffered in memory. Raises ValueError if
    it exceeds MAX_VIDEO_BYTES — caller is responsible for translating that into an HTTP error
    and removing the partial file is handled here, not left for the caller to clean up."""
    if not file or not file.filename:
        return None
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in _VIDEO_EXTENSIONS:
        ext = ".mp4"
    filename = f"{prefix}_{uuid.uuid4()}{ext}"
    path = os.path.join(UPLOAD_DIR, filename)
    size = 0
    with open(path, "wb") as buf:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_VIDEO_BYTES:
                buf.close()
                os.remove(path)
                raise ValueError(f"Video exceeds the {MAX_VIDEO_BYTES // (1024 * 1024)}MB limit")
            buf.write(chunk)
    return f"/static/uploads/{filename}"


def delete_uploaded_file(url_path: Optional[str]):
    if not url_path or not url_path.startswith("/static/uploads/"):
        return
    fs_path = os.path.join(UPLOAD_DIR, os.path.basename(url_path))
    try:
        os.remove(fs_path)
    except FileNotFoundError:
        pass
