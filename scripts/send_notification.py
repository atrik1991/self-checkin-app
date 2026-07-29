"""
GitHub Actions から定期実行され、送信タイミングが来ていれば
push_subscriptions 全員にチェックイン質問の通知を送る。

必要な環境変数:
  SUPABASE_URL
  SUPABASE_SERVICE_KEY   (service_role キー。RLSを越えて読み書きするため必須)
  VAPID_PRIVATE_KEY      (PEMファイルの中身をそのまま)
  VAPID_SUBJECT          (例: mailto:you@example.com)
  DAILY_TARGET_MIN / DAILY_TARGET_MAX  (省略時 3/5)
  ACTIVE_START_HOUR / ACTIVE_END_HOUR  (省略時 8/23, JST)
"""

import datetime
import json
import os
import random
import sys
import tempfile

import requests
from pywebpush import WebPushException, webpush

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
VAPID_PRIVATE_KEY_PEM = os.environ["VAPID_PRIVATE_KEY"]
VAPID_SUBJECT = os.environ.get("VAPID_SUBJECT", "mailto:admin@example.com")
APP_URL = os.environ.get("APP_URL", "").rstrip("/")

DAILY_TARGET_MIN = int(os.environ.get("DAILY_TARGET_MIN", 3))
DAILY_TARGET_MAX = int(os.environ.get("DAILY_TARGET_MAX", 5))
ACTIVE_START_HOUR = int(os.environ.get("ACTIVE_START_HOUR", 8))
ACTIVE_END_HOUR = int(os.environ.get("ACTIVE_END_HOUR", 23))
MIN_GAP_MINUTES = 25

JST = datetime.timezone(datetime.timedelta(hours=9))

HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
}


def now_jst():
    return datetime.datetime.now(JST)


def rest_get(path):
    r = requests.get(f"{SUPABASE_URL}/rest/v1/{path}", headers=HEADERS, timeout=15)
    r.raise_for_status()
    return r.json()


def rest_patch(path, body):
    r = requests.patch(
        f"{SUPABASE_URL}/rest/v1/{path}",
        headers={**HEADERS, "Prefer": "return=minimal"},
        json=body,
        timeout=15,
    )
    r.raise_for_status()


def rest_post(path, body):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/{path}",
        headers={**HEADERS, "Prefer": "return=minimal"},
        json=body,
        timeout=15,
    )
    r.raise_for_status()


def rest_delete(path):
    r = requests.delete(f"{SUPABASE_URL}/rest/v1/{path}", headers=HEADERS, timeout=15)
    r.raise_for_status()


def get_schedule():
    rows = rest_get("notification_schedule?id=eq.1")
    return rows[0]


def random_gap_seconds(remaining_span_seconds, remaining_sends):
    slot = remaining_span_seconds / max(remaining_sends, 1)
    min_gap = MIN_GAP_MINUTES * 60
    hi = max(min_gap, slot)
    return random.uniform(min_gap, hi)


def ensure_today(schedule):
    """日付が変わっていたら当日分のスケジュールを再抽選する"""
    today = now_jst().date()
    day_date = datetime.date.fromisoformat(schedule["day_date"])
    if day_date == today:
        return schedule

    daily_target = random.randint(DAILY_TARGET_MIN, DAILY_TARGET_MAX)
    start = now_jst()
    active_start = start.replace(hour=ACTIVE_START_HOUR, minute=0, second=0, microsecond=0)
    base = max(start, active_start)
    active_end = start.replace(hour=ACTIVE_END_HOUR, minute=0, second=0, microsecond=0)
    span = max((active_end - base).total_seconds(), 0)
    next_send = base + datetime.timedelta(seconds=random_gap_seconds(span, daily_target))

    patch = {
        "day_date": today.isoformat(),
        "daily_target": daily_target,
        "sends_today": 0,
        "next_send_at": next_send.isoformat(),
    }
    rest_patch("notification_schedule?id=eq.1", patch)
    schedule.update(patch)
    return schedule


def pick_question():
    rows = rest_get(
        "checkin_questions?active=eq.true&select=id,text,ask_count"
        "&order=ask_count.asc,last_asked_at.asc.nullsfirst&limit=6"
    )
    if not rows:
        return None
    return random.choice(rows)


def mark_question_asked(question):
    rest_patch(
        f"checkin_questions?id=eq.{question['id']}",
        {
            "last_asked_at": now_jst().isoformat(),
            "ask_count": question.get("ask_count", 0) + 1,
        },
    )


def get_subscriptions():
    return rest_get("push_subscriptions?select=id,endpoint,p256dh,auth")


def send_to_subscription(sub, payload, vapid_key_path):
    try:
        webpush(
            subscription_info={
                "endpoint": sub["endpoint"],
                "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]},
            },
            data=json.dumps(payload),
            vapid_private_key=vapid_key_path,
            vapid_claims={"sub": VAPID_SUBJECT},
            ttl=3600,
        )
        return True
    except WebPushException as e:
        status = e.response.status_code if e.response is not None else None
        print(f"  push failed for sub {sub['id']}: {e} (status={status})")
        if status in (404, 410):
            rest_delete(f"push_subscriptions?id=eq.{sub['id']}")
            print(f"  removed expired subscription {sub['id']}")
        return False


def main():
    schedule = get_schedule()
    schedule = ensure_today(schedule)

    now = now_jst()
    next_send_at = datetime.datetime.fromisoformat(schedule["next_send_at"])
    if next_send_at.tzinfo is None:
        next_send_at = next_send_at.replace(tzinfo=datetime.timezone.utc)

    if schedule["sends_today"] >= schedule["daily_target"]:
        print("本日分の送信は完了済み。何もしない。")
        return
    if now < next_send_at:
        print(f"次回送信予定 {next_send_at.isoformat()} にはまだ早い。何もしない。")
        return
    if not (ACTIVE_START_HOUR <= now.hour < ACTIVE_END_HOUR):
        print("アクティブ時間帯外。何もしない。")
        return

    question = pick_question()
    if not question:
        print("送信対象の質問がありません。")
        return

    subs = get_subscriptions()
    if not subs:
        print("購読者がいません。スケジュールだけ進める。")

    with tempfile.NamedTemporaryFile("w", suffix=".pem", delete=False) as f:
        f.write(VAPID_PRIVATE_KEY_PEM)
        vapid_key_path = f.name

    payload = {
        "title": "じぶんチェックイン",
        "body": question["text"],
        "questionId": question["id"],
    }

    success = 0
    for sub in subs:
        if send_to_subscription(sub, payload, vapid_key_path):
            success += 1

    mark_question_asked(question)
    rest_post(
        "notification_log",
        {
            "question_id": question["id"],
            "subscriptions_count": len(subs),
            "success_count": success,
        },
    )

    sends_today = schedule["sends_today"] + 1
    daily_target = schedule["daily_target"]
    patch = {"sends_today": sends_today}

    if sends_today < daily_target:
        active_end = now.replace(hour=ACTIVE_END_HOUR, minute=0, second=0, microsecond=0)
        span = max((active_end - now).total_seconds(), 0)
        remaining = daily_target - sends_today
        next_send = now + datetime.timedelta(seconds=random_gap_seconds(span, remaining))
        patch["next_send_at"] = next_send.isoformat()
    else:
        # 翌日8時に仮設定(次回実行時に ensure_today で再抽選される)
        tomorrow = (now + datetime.timedelta(days=1)).replace(
            hour=ACTIVE_START_HOUR, minute=0, second=0, microsecond=0
        )
        patch["next_send_at"] = tomorrow.isoformat()

    rest_patch("notification_schedule?id=eq.1", patch)
    print(f"送信完了: 質問「{question['text']}」→ {success}/{len(subs)} 件成功")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
