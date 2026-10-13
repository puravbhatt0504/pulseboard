"""Model artifacts: a directory holding model.joblib + metrics.json, at s3://... or file://..."""
import json
import os
import tempfile
from pathlib import Path
from urllib.parse import urlparse

import joblib

def save(bundle: dict, metrics: dict, stamp: str) -> str:
    """Writes to s3://$MODEL_BUCKET/models/eta/<stamp>/ if MODEL_BUCKET is set, else $MODEL_DIR (default ./models)."""
    bucket = os.environ.get("MODEL_BUCKET")
    if bucket:
        import boto3
        s3 = boto3.client("s3")
        prefix = f"models/eta/{stamp}/"
        with tempfile.TemporaryDirectory() as tmp:
            _write(Path(tmp), bundle, metrics)
            for f in ("model.joblib", "metrics.json"):
                s3.upload_file(str(Path(tmp) / f), bucket, prefix + f)
        return f"s3://{bucket}/{prefix}"
    out = Path(os.environ.get("MODEL_DIR", "models")).resolve() / "eta" / stamp
    _write(out, bundle, metrics)
    return out.as_uri() + "/"

def load(uri: str) -> dict:
    u = urlparse(uri)
    if u.scheme == "s3":
        import boto3
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "model.joblib"
            boto3.client("s3").download_file(u.netloc, u.path.lstrip("/").rstrip("/") + "/model.joblib", str(dest))
            return joblib.load(dest)
    if u.scheme == "file":
        from urllib.request import url2pathname
        return joblib.load(Path(url2pathname(u.path)) / "model.joblib")
    raise ValueError(f"unsupported model uri {uri!r}")

def _write(d: Path, bundle: dict, metrics: dict) -> None:
    d.mkdir(parents=True, exist_ok=True)
    joblib.dump(bundle, d / "model.joblib")
    (d / "metrics.json").write_text(json.dumps(metrics, indent=2))
