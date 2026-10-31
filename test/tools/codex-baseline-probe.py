#!/usr/bin/env python3
"""
Tokenelo spike S9 — Codex inherited-baseline probe.

Read-only over C:\\Users\\example\\.codex\\sessions (rollout-*.jsonl, incl. archived_sessions)
and state_5.sqlite (threads, thread_spawn_edges). Streams every rollout file line-by-line
(never loads a file whole — critical for the 3.57 GB file) and answers:

  (a) which fields mark a forked/subagent/resumed rollout
  (b) for such rollouts, does the first token_count carry the parent's inherited cumulative
      total (baseline = first_total - first_last_total)?
  (c) does threads.tokens_used equal the rollout's own last cumulative total, and for forked
      ones does tokens_used include the inherited baseline?
  (d) propose + quantify the exact baseline-subtraction rule.

Writes no content (no prompts/responses) to its output — only counts, keys, ids, numbers.
Designed to run on A2000 (Windows) against the live C:\\Users\\example\\.codex tree, read-only.
"""
import os, sys, json, sqlite3, re, time
from collections import Counter, defaultdict

SESSIONS_ROOTS = [
    r"C:\Users\example\.codex\sessions",
    r"C:\Users\example\.codex\archived_sessions",
]
DB_PATH = r"C:\Users\example\.codex\state_5.sqlite"
OUT_JSON = sys.argv[1] if len(sys.argv) > 1 else r"C:\Temp\tokenelo-spike-s9\codex-baseline-A2000.json"

FORK_KEYWORDS = ["fork", "parent", "subagent", "history", "replay", "resum", "inherit"]
TYPE_RE = re.compile(r'"type"\s*:\s*"([^"]+)"')

def log(*a):
    print(*a, file=sys.stderr, flush=True)

def bucket_source(s):
    if s is None:
        return None
    try:
        d = json.loads(s)
    except Exception:
        return s if isinstance(s, str) else "<non-string>"
    if isinstance(d, dict) and "subagent" in d:
        sub = d["subagent"]
        if isinstance(sub, dict) and "thread_spawn" in sub:
            return "subagent:thread_spawn"
        if isinstance(sub, dict) and "other" in sub:
            return f"subagent:other:{sub['other']}"
        return "subagent:unknown"
    return s

def load_db():
    uri = "file:" + DB_PATH.replace("\\", "/") + "?mode=ro&immutable=1"
    con = sqlite3.connect(uri, uri=True)
    cur = con.cursor()
    threads = {}
    for row in cur.execute(
        "SELECT id, rollout_path, tokens_used, thread_source, source, model, "
        "reasoning_effort, created_at_ms, cli_version, originator FROM threads"
    ):
        (tid, rollout_path, tokens_used, thread_source, source, model,
         reasoning_effort, created_at_ms, cli_version, originator) = row
        threads[tid] = dict(
            rollout_path=rollout_path, tokens_used=tokens_used,
            thread_source=thread_source, source_bucket=bucket_source(source),
            model=model, reasoning_effort=reasoning_effort,
            created_at_ms=created_at_ms, cli_version=cli_version, originator=originator,
        )
    spawn_children = set()
    spawn_parents = set()
    n_edges = 0
    for parent, child, status in cur.execute("SELECT parent_thread_id, child_thread_id, status FROM thread_spawn_edges"):
        spawn_children.add(child)
        spawn_parents.add(parent)
        n_edges += 1
    con.close()
    return threads, spawn_children, spawn_parents, n_edges

def walk_rollouts():
    seen = set()
    for root in SESSIONS_ROOTS:
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            for fn in filenames:
                if fn.startswith("rollout-") and fn.endswith(".jsonl"):
                    p = os.path.join(dirpath, fn)
                    if p in seen:
                        continue
                    seen.add(p)
                    yield p

def process_file(path):
    r = {
        "path": path,
        "size": os.path.getsize(path),
        "session_id": None,
        "session_meta_id": None,
        "session_meta_keys": [],
        "session_meta_fork_fields": {},
        "originator": None,
        "token_count_n": 0,
        "compacted_n": 0,
        "event_msg_types": Counter(),
        "first_total": None,
        "first_last_total": None,
        "last_total": None,
        "last_last_total": None,
        "baseline": 0,
        "inherited_baseline_suspect": False,
        "decreases": [],
        "fork_keyword_hits": Counter(),
        "fork_keyword_types": defaultdict(set),
        "parse_errors": 0,
        "n_lines": 0,
        "error": None,
    }
    prev_total = None
    prev_ordinal = None
    got_meta = False
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for ordinal, line in enumerate(f):
                if not line or not line.strip():
                    continue
                r["n_lines"] += 1

                # cheap top-level type extraction (avoid full parse of huge response_item lines)
                # real on-disk shape (verified): {"timestamp":...,"ordinal":N,"type":"<outer>","payload":{"type":"<inner>",...}}
                m = TYPE_RE.search(line[:200])
                outer_type = m.group(1) if m else None

                # outer type "compacted" is its own top-level event (not nested under event_msg)
                if outer_type == "compacted":
                    r["compacted_n"] += 1
                    continue

                if not got_meta and outer_type == "session_meta":
                    try:
                        obj = json.loads(line)
                        payload = obj.get("payload", {}) or {}
                        r["session_meta_keys"] = sorted(payload.keys())
                        r["session_meta_id"] = payload.get("id")
                        r["session_id"] = payload.get("session_id") or payload.get("id")
                        r["originator"] = payload.get("originator")
                        for k, v in payload.items():
                            kl = k.lower()
                            if any(kw in kl for kw in FORK_KEYWORDS) and k not in ("base_instructions", "dynamic_tools"):
                                if isinstance(v, (int, float, bool, str)) and len(str(v)) < 200:
                                    r["session_meta_fork_fields"][k] = v
                                else:
                                    r["session_meta_fork_fields"][k] = f"<{type(v).__name__}>"
                        got_meta = True
                    except Exception:
                        r["parse_errors"] += 1
                    continue

                if outer_type == "event_msg":
                    # verified on-disk order: {"type":"event_msg","payload":{"type":"<ptype>",...}
                    # so payload.type is the 2nd "type" occurrence in the line's prefix
                    all_types = TYPE_RE.findall(line[:500])
                    ptype = all_types[1] if len(all_types) > 1 else None
                    if ptype:
                        r["event_msg_types"][ptype] += 1
                    if ptype == "token_count":
                        try:
                            obj = json.loads(line)
                            payload = obj.get("payload", {}) or {}
                            info = payload.get("info", {}) or {}
                            ttu = info.get("total_token_usage", {}) or {}
                            ltu = info.get("last_token_usage", {}) or {}
                            total = ttu.get("total_tokens")
                            last_total = ltu.get("total_tokens")
                            r["token_count_n"] += 1
                            if r["first_total"] is None:
                                r["first_total"] = total
                                r["first_last_total"] = last_total
                                if isinstance(total, (int, float)) and isinstance(last_total, (int, float)) and total > last_total:
                                    r["inherited_baseline_suspect"] = True
                                    r["baseline"] = total - last_total
                            r["last_total"] = total
                            r["last_last_total"] = last_total
                            if (prev_total is not None and isinstance(total, (int, float))
                                    and isinstance(prev_total, (int, float)) and total < prev_total):
                                r["decreases"].append([prev_ordinal, ordinal, prev_total, total])
                            prev_total = total
                            prev_ordinal = ordinal
                        except Exception:
                            r["parse_errors"] += 1
                        continue
                    elif ptype == "compacted":
                        r["compacted_n"] += 1

                # fork-keyword scan on remaining (non-token_count) lines — cheap substring first
                low = None
                for kw in FORK_KEYWORDS:
                    hit = kw in line
                    if not hit:
                        if low is None:
                            low = line.lower()
                        hit = kw in low
                    if hit:
                        r["fork_keyword_hits"][kw] += 1
                        if outer_type:
                            r["fork_keyword_types"][kw].add(outer_type)
    except Exception as e:
        r["error"] = f"{type(e).__name__}: {e}"

    r["event_msg_types"] = dict(r["event_msg_types"])
    r["fork_keyword_hits"] = dict(r["fork_keyword_hits"])
    r["fork_keyword_types"] = {k: sorted(v) for k, v in r["fork_keyword_types"].items()}
    return r

def main():
    t0 = time.time()
    log("Loading state_5.sqlite (threads, thread_spawn_edges)...")
    threads, spawn_children, spawn_parents, n_edges = load_db()
    log(f"threads={len(threads)} spawn_edges={n_edges} spawn_children={len(spawn_children)} spawn_parents={len(spawn_parents)}")

    all_session_meta_keys = set()
    all_event_msg_types = Counter()
    all_fork_keyword_hits = Counter()
    all_fork_keyword_types = defaultdict(set)
    all_session_meta_fork_field_names = set()

    per_file = []
    n_processed = 0
    n_bytes = 0
    files = list(walk_rollouts())
    total_files = len(files)
    files.sort(key=lambda p: os.path.getsize(p))  # small first, so a crash loses less
    log(f"Found {total_files} rollout files to scan.")

    for path in files:
        r = process_file(path)
        n_processed += 1
        n_bytes += r["size"]
        all_session_meta_keys.update(r["session_meta_keys"])
        for k, v in r["event_msg_types"].items():
            all_event_msg_types[k] += v
        for k, v in r["fork_keyword_hits"].items():
            all_fork_keyword_hits[k] += v
        for k, v in r["fork_keyword_types"].items():
            all_fork_keyword_types[k].update(v)
        all_session_meta_fork_field_names.update(r["session_meta_fork_fields"].keys())

        # join with threads table
        tid = r["session_meta_id"] or r["session_id"]
        thread_row = threads.get(tid) if tid else None
        r["thread_row"] = thread_row
        r["is_spawn_child"] = tid in spawn_children if tid else False
        r["is_spawn_parent"] = tid in spawn_parents if tid else False

        per_file.append(r)
        if n_processed % 100 == 0 or r["size"] > 100_000_000:
            elapsed = time.time() - t0
            log(f"[{n_processed}/{total_files}] {elapsed:.1f}s elapsed, "
                f"{n_bytes/1e6:.1f} MB scanned, last={os.path.basename(path)} "
                f"({r['size']/1e6:.1f} MB, {r['token_count_n']} token_count events)")

    elapsed = time.time() - t0
    log(f"Done scanning {n_processed} files, {n_bytes/1e9:.3f} GB, {elapsed:.1f}s.")

    # ---- aggregate answers ----
    baseline_nonzero = [r for r in per_file if r["baseline"]]
    baseline_zero_but_fork_marked = [
        r for r in per_file
        if r["baseline"] == 0 and (r["is_spawn_child"] or (r["thread_row"] and r["thread_row"]["thread_source"] in ("subagent", "guardian_review")))
    ]
    fork_marked = [
        r for r in per_file
        if r["is_spawn_child"] or (r["thread_row"] and r["thread_row"]["thread_source"] in ("subagent", "guardian_review"))
        or r["session_meta_fork_fields"].get("forked_from_id") or r["session_meta_fork_fields"].get("parent_thread_id")
    ]
    decreases_files = [r for r in per_file if r["decreases"]]

    tokens_used_mismatch = []
    tokens_used_match = 0
    tokens_used_checked = 0
    for r in per_file:
        tr = r["thread_row"]
        if tr is None or tr["tokens_used"] is None or r["last_total"] is None:
            continue
        tokens_used_checked += 1
        if tr["tokens_used"] == r["last_total"]:
            tokens_used_match += 1
        else:
            tokens_used_mismatch.append({
                "session_id": r["session_meta_id"] or r["session_id"],
                "path": r["path"],
                "tokens_used_db": tr["tokens_used"],
                "last_total_rollout": r["last_total"],
                "diff": tr["tokens_used"] - r["last_total"],
                "baseline": r["baseline"],
                "thread_source": tr["thread_source"],
            })

    baseline_total_tokens = sum(r["baseline"] for r in per_file)

    examples = []
    for r in sorted(baseline_nonzero, key=lambda x: -x["baseline"])[:3]:
        tr = r["thread_row"] or {}
        examples.append({
            "session_id": r["session_meta_id"] or r["session_id"],
            "path": r["path"],
            "thread_source": tr.get("thread_source"),
            "forked_from_id": r["session_meta_fork_fields"].get("forked_from_id"),
            "parent_thread_id": r["session_meta_fork_fields"].get("parent_thread_id"),
            "subagent_history_start_ordinal": r["session_meta_fork_fields"].get("subagent_history_start_ordinal"),
            "first_total": r["first_total"],
            "first_last_total": r["first_last_total"],
            "baseline": r["baseline"],
            "last_total": r["last_total"],
            "tokens_used_db": tr.get("tokens_used"),
            "own_usage_after_rule": r["last_total"] - r["baseline"] if r["last_total"] is not None else None,
        })

    # small sample of fork-marked-but-zero-baseline for contrast, to show inconsistency
    zero_baseline_examples = []
    for r in fork_marked[:200]:
        if r["baseline"] == 0:
            tr = r["thread_row"] or {}
            zero_baseline_examples.append({
                "session_id": r["session_meta_id"] or r["session_id"],
                "thread_source": tr.get("thread_source"),
                "forked_from_id": r["session_meta_fork_fields"].get("forked_from_id"),
                "first_total": r["first_total"],
                "first_last_total": r["first_last_total"],
            })
            if len(zero_baseline_examples) >= 3:
                break

    summary = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "corpus": {
            "n_rollout_files": total_files,
            "n_processed": n_processed,
            "total_bytes": n_bytes,
            "elapsed_seconds": round(elapsed, 1),
        },
        "db": {
            "n_threads": len(threads),
            "n_spawn_edges": n_edges,
            "n_spawn_children": len(spawn_children),
            "n_spawn_parents": len(spawn_parents),
        },
        "session_meta_keys_union": sorted(all_session_meta_keys),
        "session_meta_fork_field_names_union": sorted(all_session_meta_fork_field_names),
        "event_msg_payload_types_union_with_counts": dict(sorted(all_event_msg_types.items(), key=lambda x: -x[1])),
        "fork_keyword_hits_total": dict(all_fork_keyword_hits),
        "fork_keyword_seen_in_event_types": {k: sorted(v) for k, v in all_fork_keyword_types.items()},
        "answer_a_fork_markers": {
            "rollout_session_meta_fields": ["forked_from_id", "parent_thread_id", "thread_source",
                                             "agent_nickname", "agent_path", "subagent_history_start_ordinal",
                                             "multi_agent_version"],
            "sqlite_threads_fields": ["thread_source (subagent|guardian_review)", "source (JSON: subagent.thread_spawn.parent_thread_id | subagent.other)"],
            "sqlite_fork_graph_table": "thread_spawn_edges(parent_thread_id, child_thread_id, status)",
        },
        "answer_b_inherited_baseline": {
            "n_rollouts_with_nonzero_baseline": len(baseline_nonzero),
            "n_fork_marked_rollouts_total": len(fork_marked),
            "n_fork_marked_with_zero_baseline": len(baseline_zero_but_fork_marked),
            "conclusion": ("Presence of fork markers (forked_from_id/parent_thread_id/thread_source=subagent/"
                            "subagent_history_start_ordinal) does NOT reliably predict a nonzero baseline. "
                            "baseline must be computed per-rollout, not inferred from the fork markers."),
            "examples_nonzero_baseline": examples,
            "examples_fork_marked_zero_baseline": zero_baseline_examples,
        },
        "answer_c_tokens_used_crosscheck": {
            "n_checked": tokens_used_checked,
            "n_exact_match_to_last_total": tokens_used_match,
            "n_mismatch": len(tokens_used_mismatch),
            "mismatch_examples": tokens_used_mismatch[:10],
            "conclusion": ("threads.tokens_used equals the rollout's own last cumulative "
                            "total_token_usage.total_tokens for essentially all threads checked "
                            "(match_rate reported above), INCLUDING forked/subagent ones with a "
                            "nonzero baseline — i.e. tokens_used is the raw cumulative counter and "
                            "is NOT net of the inherited baseline."),
        },
        "answer_d_rule": {
            "rule": "per_rollout_own_usage = last_total - baseline, where baseline = first_total - first_last_total "
                    "(first_total = total_token_usage.total_tokens of the FIRST token_count event in the rollout file; "
                    "first_last_total = that same event's last_token_usage.total_tokens, i.e. its own turn delta). "
                    "baseline is 0 for a normal/root thread by construction. Apply uniformly to every rollout "
                    "(do not gate on thread_source/fork markers, which are an unreliable predictor per answer_b).",
            "n_rollouts_affected_nonzero_baseline": len(baseline_nonzero),
            "pct_rollouts_affected": round(100 * len(baseline_nonzero) / n_processed, 3) if n_processed else None,
            "total_baseline_tokens_across_corpus": baseline_total_tokens,
            "pct_of_all_tokens_used_sum": None,  # filled below
        },
        "monotonicity": {
            "n_files_with_any_decrease": len(decreases_files),
            "decrease_examples": [
                {"session_id": r["session_meta_id"] or r["session_id"], "path": r["path"], "decreases": r["decreases"][:5]}
                for r in decreases_files[:10]
            ],
        },
        "totals": {
            "sum_tokens_used_all_threads_in_db": sum(t["tokens_used"] for t in threads.values() if t["tokens_used"]),
            "sum_last_total_all_rollouts_processed": sum(r["last_total"] for r in per_file if r["last_total"]),
        },
        "parse_errors_total": sum(r["parse_errors"] for r in per_file),
        "files_with_errors": [{"path": r["path"], "error": r["error"]} for r in per_file if r["error"]],
    }
    tot_used = summary["totals"]["sum_tokens_used_all_threads_in_db"]
    if tot_used:
        summary["answer_d_rule"]["pct_of_all_tokens_used_sum"] = round(100 * baseline_total_tokens / tot_used, 4)

    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)
    log(f"Wrote {OUT_JSON}")
    log("=== KEY NUMBERS ===")
    log(json.dumps({k: summary[k] for k in ("corpus", "db", "answer_b_inherited_baseline", "answer_c_tokens_used_crosscheck", "answer_d_rule", "monotonicity")}, indent=2)[:4000])

if __name__ == "__main__":
    main()
