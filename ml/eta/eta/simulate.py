"""Synthetic card history, until real PulseBoard data has labels/comments/checklists/assignees.

Assumptions (hours from creation to Done):
- Each assignee has a personal speed factor (lognormal around 1); each board a base pace (20-60 h).
- Bugs are ~0.7x, features ~1.5x, chores ~0.6x; "urgent" halves the time.
- +4% per comment, +6% per checklist item, +1% per 100 chars of description, +5% per open card the assignee holds.
- Cards created Fri/Sat/Sun wait over the weekend: +30 h.
- Noise is lognormal (sigma 0.35), so the target is right-skewed like real cycle times.
- Over time teams speed up ~10% across the window, which a random split would leak; train.py splits by time.
"""
import numpy as np
import pandas as pd

from .features import COLUMNS, LABELS

def generate(n: int = 4000, seed: int = 7) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    boards, assignees = 8, 30
    board_pace = rng.uniform(20, 60, boards)
    speed = rng.lognormal(0, 0.3, assignees)
    created = pd.Timestamp("2026-01-01") + pd.to_timedelta(np.sort(rng.uniform(0, 270, n)), unit="D")
    board = rng.integers(0, boards, n)
    who = rng.integers(0, assignees, n)
    labels = {l: rng.random(n) < p for l, p in zip(LABELS, (0.3, 0.35, 0.25, 0.1))}
    comments = rng.poisson(2, n)
    checklist = rng.poisson(3, n)
    desc_len = rng.integers(0, 1500, n)
    open_cards = rng.integers(0, 12, n)

    mult = np.ones(n)
    mult *= np.where(labels["bug"], 0.7, 1) * np.where(labels["feature"], 1.5, 1) * np.where(labels["chore"], 0.6, 1)
    mult *= np.where(labels["urgent"], 0.5, 1)
    mult *= 1 + 0.04 * comments + 0.06 * checklist + 0.0001 * desc_len + 0.05 * open_cards
    trend = 1 - 0.1 * (created - created.min()) / (created.max() - created.min())
    hours = board_pace[board] * speed[who] * mult * trend * rng.lognormal(0, 0.35, n)
    hours += np.where(created.dayofweek >= 4, 30, 0)

    df = pd.DataFrame({
        "created_at": created,
        "board_id": board,
        "column": rng.choice(COLUMNS, n),
        **{f"label_{l}": v.astype(int) for l, v in labels.items()},
        "description_length": desc_len,
        "comments": comments,
        "checklist_items": checklist,
        "open_cards_assignee": open_cards,
        "day_of_week": created.dayofweek,
        "hours": hours,
    })
    # History medians use only earlier cards (expanding, shifted) so features never see the future.
    df["assignee"] = who
    for key, col in (("assignee", "assignee_median_hours"), ("board_id", "board_median_hours")):
        df[col] = df.groupby(key)["hours"].transform(lambda s: s.expanding().median().shift(1))
    df[["assignee_median_hours", "board_median_hours"]] = df[["assignee_median_hours", "board_median_hours"]].fillna(df["hours"].median())
    return df.drop(columns=["assignee"])
