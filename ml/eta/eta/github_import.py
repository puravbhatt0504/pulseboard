"""Real training data from GitHub issues: one row per settled issue, same columns as simulate.py.

    python -m eta.github_import microsoft/vscode [owner/repo ...] [--max-pages 50] [--settle-days 60] [-o models/data/eta.csv]

Then retrain with DATA_URL=file:///models/data/eta.csv (models/ is mounted at /models in the trainer).
Set GITHUB_TOKEN (5,000 requests/hour instead of 60), e.g. in PowerShell: $env:GITHUB_TOKEN = (gh auth token)

Survivorship: newly opened issues that are already closed are the fast ones, so a naive "closed issues" dataset
makes recent work look quick. Only issues opened >= settle_days before the fetch become rows, the target is capped
at settle_days (an issue that took longer, or is still open, counts as exactly settle_days), and open issues are
fetched too so slow ones aren't silently missing.

Mapping (issue -> card):
- board = repo; hours = closed_at - created_at (capped); issues closed as "not_planned"/duplicate and PRs are skipped.
- labels by keyword: bug, feature (enhancement/feature request), chore (docs/refactor/ci/deps), urgent (critical/p0/p1/blocker).
- checklist_items = "- [ ]" / "- [x]" lines in the body; description_length = body length.
- open_cards_assignee = the first assignee's issues open at this issue's creation.
- assignee/board medians = median capped hours of issues already CLOSED when this one was created (no future leakage).
- column: GitHub has no columns, so every row is "backlog" (the feature is constant for imported data).
ponytail: comments is the count now, so it leaks some future (long-running issues collect comments).
  Fix: fetch each issue's comment timestamps and count those near creation, if this feature dominates.
"""
import argparse
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import median

import httpx
import pandas as pd

LABEL_WORDS = {
    "bug": ("bug", "defect", "crash", "regression"),
    "feature": ("feature", "enhancement"),
    "chore": ("chore", "doc", "refactor", "ci", "dependenc", "maintenance", "cleanup"),
    "urgent": ("urgent", "critical", "p0", "p1", "blocker", "high priority", "priority: high"),
}
CHECKBOX = re.compile(r"^\s*[-*] \[[ xX]\]", re.M)

def fetch(repo: str, max_pages: int, token: str | None = None) -> list[dict]:
    headers = {"accept": "application/vnd.github+json", **({"authorization": f"Bearer {token}"} if token else {})}
    issues, url = [], f"https://api.github.com/repos/{repo}/issues?state=all&per_page=100&sort=created&direction=desc"
    with httpx.Client(headers=headers, timeout=30, follow_redirects=True) as c:
        for _ in range(max_pages):
            r = c.get(url)
            if r.status_code == 403 and r.headers.get("x-ratelimit-remaining") == "0":
                print(f"{repo}: rate limit hit after {len(issues)} items; set GITHUB_TOKEN for more", file=sys.stderr)
                break
            r.raise_for_status()
            issues += r.json()
            if 'rel="next"' not in r.headers.get("link", ""):
                break
            url = re.search(r'<([^>]+)>; rel="next"', r.headers["link"]).group(1)
    return issues

def label_flags(names: list[str]) -> dict[str, int]:
    low = [n.lower() for n in names]
    return {f"label_{k}": int(any(w in n for n in low for w in words)) for k, words in LABEL_WORDS.items()}

def ts(s: str | None):
    return datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None

def rows(issues: list[dict], board_id: int, now: datetime, settle_days: int = 60) -> list[dict]:
    cap = settle_days * 24.0
    items = [i for i in issues if "pull_request" not in i and i.get("state_reason") in (None, "completed", "reopened")]
    for i in items:
        i["_created"], i["_closed"] = ts(i["created_at"]), ts(i.get("closed_at"))
        i["_who"] = i["assignees"][0]["login"] if i.get("assignees") else None
        i["_hours"] = min(((i["_closed"] or now) - i["_created"]).total_seconds() / 3600, cap)
    closed = [i for i in items if i["_closed"]]
    settled = [i for i in items if i["_created"] <= now - timedelta(days=settle_days)]
    out = []
    # ponytail: O(n^2) history scans; fine for a few thousand issues per repo, index by close time if imports grow.
    for i in settled:
        created, who = i["_created"], i["_who"]
        before = [d for d in closed if d["_closed"] < created]
        board_hist = [d["_hours"] for d in before]
        who_hist = [d["_hours"] for d in before if who and d["_who"] == who]
        board_med = median(board_hist) if board_hist else None
        out.append({
            "created_at": created.replace(tzinfo=None),
            "board_id": board_id,
            "column": "backlog",
            **label_flags([l["name"] for l in i.get("labels", [])]),
            "description_length": len(i.get("body") or ""),
            "comments": i.get("comments", 0),
            "checklist_items": len(CHECKBOX.findall(i.get("body") or "")),
            "open_cards_assignee": sum(1 for o in items if who and o["_who"] == who and o is not i
                                       and o["_created"] < created and (o["_closed"] is None or o["_closed"] > created)),
            "day_of_week": created.weekday(),
            "hours": i["_hours"],
            "assignee_median_hours": median(who_hist) if who_hist else board_med,
            "board_median_hours": board_med,
        })
    if not out:
        return out
    df = pd.DataFrame(out)
    # The board's first issues have no closed history yet: fall back to the earliest known board median.
    known = df.sort_values("created_at")["board_median_hours"].dropna()
    fill = float(known.iloc[0]) if len(known) else 24.0
    df[["assignee_median_hours", "board_median_hours"]] = df[["assignee_median_hours", "board_median_hours"]].fillna(fill)
    return df.to_dict("records")

def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("repos", nargs="+")
    ap.add_argument("--max-pages", type=int, default=50)
    ap.add_argument("--settle-days", type=int, default=60)
    ap.add_argument("-o", "--out", default="models/data/eta.csv")
    a = ap.parse_args(argv)
    now, all_rows = datetime.now(timezone.utc), []
    for b, repo in enumerate(a.repos):
        r = rows(fetch(repo, a.max_pages, os.environ.get("GITHUB_TOKEN")), b, now, a.settle_days)
        print(f"{repo}: {len(r)} settled issues")
        all_rows += r
    if not all_rows:
        sys.exit("no settled issues found: raise --max-pages (with GITHUB_TOKEN) or lower --settle-days")
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(all_rows).sort_values("created_at").to_csv(a.out, index=False)
    print(f"wrote {len(all_rows)} rows to {a.out}")

if __name__ == "__main__":
    main()
