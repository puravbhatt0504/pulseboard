from datetime import datetime, timezone

from eta.github_import import label_flags, rows

NOW = datetime(2026, 6, 1, tzinfo=timezone.utc)  # settle 60 days -> only issues opened by 2026-04-02 are rows

def issue(n, created, closed=None, labels=(), who=None, body="", reason="completed", pr=False):
    i = {"number": n, "created_at": created, "closed_at": closed, "state_reason": reason if closed else None,
         "labels": [{"name": l} for l in labels], "assignees": [{"login": who}] if who else [],
         "body": body, "comments": 1}
    if pr:
        i["pull_request"] = {}
    return i

def test_label_keywords():
    assert label_flags(["Type: Bug", "P1"]) == {"label_bug": 1, "label_feature": 0, "label_chore": 0, "label_urgent": 1}
    assert label_flags(["enhancement", "documentation"])["label_feature"] == 1
    assert label_flags(["documentation"])["label_chore"] == 1

def test_rows_settle_cap_and_history_without_leakage():
    issues = [
        issue(1, "2026-01-01T00:00:00Z", "2026-01-01T10:00:00Z", who="ann"),            # 10 h
        issue(2, "2026-01-01T05:00:00Z", "2026-01-03T05:00:00Z", who="ann"),            # 48 h, created before #1 closed
        issue(3, "2026-01-02T00:00:00Z", "2026-01-02T04:00:00Z", labels=["bug"], who="ann",
              body="- [ ] a\n- [x] b\ntext"),                                            # 4 h
        issue(4, "2026-01-02T00:00:00Z", "2026-01-02T01:00:00Z", reason="not_planned"),  # dropped
        issue(5, "2026-01-02T00:00:00Z", "2026-01-02T01:00:00Z", pr=True),               # dropped
        issue(6, "2026-01-05T00:00:00Z"),                                                 # still open -> capped 1440 h
        issue(7, "2026-01-05T00:00:00Z", "2026-05-01T00:00:00Z"),                         # took > 60 days -> capped
        issue(8, "2026-05-20T00:00:00Z", "2026-05-20T02:00:00Z"),                         # too recent: not a row
    ]
    out = rows(issues, board_id=0, now=NOW)
    assert sorted(round(r["hours"]) for r in out) == [4, 10, 48, 1440, 1440]
    by_hours = {round(r["hours"]): r for r in out}
    # #3: only #1 (10 h) had closed by its creation; #2 was still open and assigned to ann
    r3 = by_hours[4]
    assert r3["board_median_hours"] == 10 and r3["assignee_median_hours"] == 10
    assert r3["open_cards_assignee"] == 1
    assert r3["checklist_items"] == 2 and r3["label_bug"] == 1 and r3["column"] == "backlog"
    # #2 had no closed history at creation -> earliest known board median
    assert by_hours[48]["board_median_hours"] == 10
