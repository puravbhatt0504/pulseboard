import hashlib
import hmac
import json

import pytest
from fastapi.testclient import TestClient

from eta import serve, simulate, train

CARD = {"column": "doing", "labels": ["bug"], "description_length": 300, "comments": 2, "checklist_items": 3,
        "assignee_median_hours": 30.0, "board_median_hours": 40.0, "day_of_week": 1, "open_cards_assignee": 4}

@pytest.fixture(scope="module")
def trained():
    return train.evaluate(simulate.generate(3000, seed=1))

def test_xgboost_beats_baseline_and_p90_covers(trained):
    _, m = trained
    assert m["mae"] < m["mae_baseline"]
    assert m["p90_coverage"] >= 0.85

def test_time_split_trains_only_on_older_rows():
    tr, te = train.time_split(simulate.generate(500))
    assert tr["created_at"].max() <= te["created_at"].min()

def test_main_prints_contract_json_last(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("DATA_URL", "synthetic:600")
    monkeypatch.setenv("MODEL_DIR", str(tmp_path))
    monkeypatch.delenv("MODEL_BUCKET", raising=False)
    train.main()
    out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert out["s3Uri"].startswith("file:") and out["metrics"]["mae"] >= 0
    assert serve.store.load(out["s3Uri"])["columns"]

@pytest.fixture
def client(trained, monkeypatch):
    monkeypatch.setenv("WEBHOOK_SECRET", "s3cret")
    monkeypatch.delenv("MODEL_URI", raising=False)
    monkeypatch.delenv("RELAYQ_URL", raising=False)
    serve.state.update(bundle=None, version=None)
    with TestClient(serve.app) as c:
        yield c

def test_predict_needs_a_model_then_returns_ordered_quantiles(client, trained):
    assert client.post("/predict", json=CARD).status_code == 503
    serve.state["bundle"] = trained[0]
    r = client.post("/predict", json=CARD).json()
    assert 0 <= r["p50Hours"] <= r["p90Hours"]

@pytest.mark.parametrize("drop", ["column", "labels", "day_of_week"])
def test_predict_missing_feature_is_422(client, trained, drop):
    serve.state["bundle"] = trained[0]
    assert client.post("/predict", json={k: v for k, v in CARD.items() if k != drop}).status_code == 422

def sign(body: bytes, secret="s3cret"):
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()

def test_reload_checks_signature_and_registry(client, trained, monkeypatch):
    monkeypatch.setattr(serve, "promoted", lambda: {"version": 3, "s3Uri": "file:///m/"})
    monkeypatch.setattr(serve.store, "load", lambda uri: trained[0])
    body = json.dumps({"name": "eta", "version": 3}).encode()
    assert client.post("/reload", content=body).status_code == 401
    assert client.post("/reload", content=body, headers={"x-relayq-signature": sign(body, "other")}).status_code == 401
    stale = json.dumps({"name": "eta", "version": 2}).encode()
    assert client.post("/reload", content=stale, headers={"x-relayq-signature": sign(stale)}).status_code == 409
    r = client.post("/reload", content=body, headers={"x-relayq-signature": sign(body)})
    assert r.status_code == 200 and r.json() == {"version": 3}
    assert client.post("/predict", json=CARD).status_code == 200
