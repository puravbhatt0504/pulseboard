"""ETA model server.

POST /predict CardFeatures -> {p50Hours, p90Hours}; any missing/invalid field -> 422; no model loaded -> 503.
POST /reload  RelayQ promotion notice {name, version}, signed like every RelayQ webhook
              (x-relayq-signature = hex HMAC-SHA256(raw body, WEBHOOK_SECRET)). Looks the promoted
              version up in RelayQ's registry (GET $RELAYQ_URL/models/eta) and loads its artifact.
              Bad signature -> 401; name != eta -> 400; registry's promoted version != notice -> 409.
Startup: loads MODEL_URI if set, else the registry's promoted version if RELAYQ_URL is set, else none.
"""
import hashlib
import hmac
import json
import os

import httpx
from fastapi import FastAPI, HTTPException, Request

from . import store
from .features import CardFeatures, from_request, matrix

app = FastAPI(title="pulseboard-eta")
state: dict = {"bundle": None, "version": None}

def promoted() -> dict | None:
    res = httpx.get(f"{os.environ['RELAYQ_URL']}/models/eta",
                    headers={"authorization": f"Bearer {os.environ.get('RELAYQ_API_KEY', '')}"}, timeout=10)
    if res.status_code == 404:
        return None
    res.raise_for_status()
    return res.json()["promoted"]

@app.on_event("startup")
def startup() -> None:
    if os.environ.get("MODEL_URI"):
        state.update(bundle=store.load(os.environ["MODEL_URI"]), version=None)
    elif os.environ.get("RELAYQ_URL") and (p := promoted()):
        state.update(bundle=store.load(p["s3Uri"]), version=p["version"])

@app.get("/health")
def health() -> dict:
    return {"model": state["bundle"] is not None, "version": state["version"]}

@app.post("/predict")
def predict(f: CardFeatures) -> dict:
    if state["bundle"] is None:
        raise HTTPException(503, "no model loaded")
    X = matrix(from_request(f))[state["bundle"]["columns"]]
    p50, p90 = state["bundle"]["model"].predict(X)[0]
    p50 = max(float(p50), 0.0)
    return {"p50Hours": round(p50, 1), "p90Hours": round(max(float(p90), p50), 1)}

@app.post("/reload")
async def reload(req: Request) -> dict:
    raw = await req.body()
    secret = os.environ.get("WEBHOOK_SECRET", "")
    expected = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    if not secret or not hmac.compare_digest(expected, req.headers.get("x-relayq-signature", "")):
        raise HTTPException(401, "bad signature")
    body = json.loads(raw or b"null") or {}
    if body.get("name") != "eta" or not isinstance(body.get("version"), int):
        raise HTTPException(400, "expected {name: 'eta', version: int}")
    p = promoted()
    if not p or p["version"] != body["version"]:
        raise HTTPException(409, "notice is not the registry's promoted version")
    if state["version"] != p["version"]:  # repeat deliveries are a no-op
        state.update(bundle=store.load(p["s3Uri"]), version=p["version"])
    return {"version": state["version"]}
