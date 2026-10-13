import pandas as pd
from pydantic import BaseModel, Field
from typing import Literal

COLUMNS = ["backlog", "todo", "doing", "review"]
LABELS = ["bug", "feature", "chore", "urgent"]

class CardFeatures(BaseModel):
    """Every field is required: a missing one is a 422, never a silent default."""
    column: Literal["backlog", "todo", "doing", "review"]
    labels: list[Literal["bug", "feature", "chore", "urgent"]]
    description_length: int = Field(ge=0)
    comments: int = Field(ge=0)
    checklist_items: int = Field(ge=0)
    assignee_median_hours: float = Field(ge=0)
    board_median_hours: float = Field(ge=0)
    day_of_week: int = Field(ge=0, le=6)  # Monday = 0
    open_cards_assignee: int = Field(ge=0)

NUMERIC = ["description_length", "comments", "checklist_items", "assignee_median_hours",
           "board_median_hours", "day_of_week", "open_cards_assignee"]

def matrix(df: pd.DataFrame) -> pd.DataFrame:
    """Fixed column order, one-hot column + labels, so train and serve always agree."""
    X = df[NUMERIC].astype(float).copy()
    for c in COLUMNS:
        X[f"column_{c}"] = (df["column"] == c).astype(float)
    for l in LABELS:
        X[f"label_{l}"] = df[f"label_{l}"].astype(float)
    return X

def from_request(f: CardFeatures) -> pd.DataFrame:
    row = f.model_dump()
    labels = row.pop("labels")
    row.update({f"label_{l}": int(l in labels) for l in LABELS})
    return pd.DataFrame([row])
