"""Trainer for RelayQ's ml.retrain job (contract: relayq src/worker/handlers/ml.retrain.ts).

In: DATA_URL ("synthetic:" / "synthetic:<n>", or a CSV path/URL with the simulate.py columns), MODEL_NAME (must be "eta").
Out: human-readable MAE lines, then ONE JSON line last on stdout: {"s3Uri": ..., "metrics": {"mae": ...}}.
Exit non-zero on any failure (RelayQ retries).
"""
import json
import os
import sys
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from sklearn.linear_model import LinearRegression
from xgboost import XGBRegressor

from . import simulate, store
from .features import matrix

def load_data(url: str) -> pd.DataFrame:
    if url.startswith("synthetic:"):
        n = url.removeprefix("synthetic:")
        return simulate.generate(int(n) if n else 4000)
    return pd.read_csv(url, parse_dates=["created_at"])

def time_split(df: pd.DataFrame, test_frac: float = 0.2):
    """Train on the oldest 80%, test on the newest 20%: no future rows leak into training."""
    df = df.sort_values("created_at").reset_index(drop=True)
    cut = int(len(df) * (1 - test_frac))
    return df.iloc[:cut], df.iloc[cut:]

def fit_xgb(X: pd.DataFrame, y: pd.Series, **overrides) -> XGBRegressor:
    params = dict(objective="reg:quantileerror", quantile_alpha=np.array([0.5, 0.9]),
                  n_estimators=300, max_depth=4, learning_rate=0.05, subsample=0.8)
    return XGBRegressor(**{**params, **overrides}).fit(X, y)

def evaluate(df: pd.DataFrame) -> tuple[dict, dict]:
    train, test = time_split(df)
    Xtr, Xte, ytr, yte = matrix(train), matrix(test), train["hours"], test["hours"]
    mae = lambda pred: float(np.mean(np.abs(yte.to_numpy() - pred)))

    board_median = train.groupby("board_id")["hours"].median()
    baseline = test["board_id"].map(board_median).fillna(ytr.median()).to_numpy()
    linear = LinearRegression().fit(Xtr, ytr).predict(Xte)
    xgb = fit_xgb(Xtr, ytr)
    q = xgb.predict(Xte)

    metrics = {
        "mae": mae(q[:, 0]),  # the promotion metric RelayQ compares
        "mae_baseline": mae(baseline),
        "mae_linear": mae(linear),
        "p90_coverage": float(np.mean(yte.to_numpy() <= q[:, 1])),
        "n_train": float(len(train)),
        "n_test": float(len(test)),
    }
    return {"model": xgb, "columns": list(Xtr.columns)}, metrics

def main() -> None:
    name = os.environ.get("MODEL_NAME", "eta")
    if name != "eta":
        sys.exit(f"this image trains 'eta', not {name!r}")
    bundle, metrics = evaluate(load_data(os.environ.get("DATA_URL", "synthetic:")))
    for k in ("mae_baseline", "mae_linear", "mae"):
        print(f"{k:>14}: {metrics[k]:.2f} h")
    print(f"  p90_coverage: {metrics['p90_coverage']:.1%}")
    uri = store.save(bundle, metrics, datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%SZ"))
    print(json.dumps({"s3Uri": uri, "metrics": metrics}), flush=True)

if __name__ == "__main__":
    main()
