#!/usr/bin/env python3
"""Verify a WinVM Bridge package dir against its own MANIFEST.txt.

Usage: python3 verify-manifest.py <pkg-dir>
判据: 逐文件 sha256 全 OK + files/bytes 计数一致 + total-sha256 复算一致 + 无多余/缺失文件
退出码: 0 PASS / 1 FAIL
"""
import hashlib
import os
import sys


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: verify-manifest.py <pkg-dir>")
        return 1
    root = os.path.abspath(sys.argv[1])
    man = os.path.join(root, "MANIFEST.txt")
    if not os.path.isfile(man):
        print(f"FAIL: MANIFEST.txt not found in {root}")
        return 1

    declared_files = None
    declared_bytes = None
    declared_total = None
    rows = []
    in_rows = False
    with open(man, "r", encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if line.startswith("# ---- per-file"):
                in_rows = True
                continue
            if line.startswith("files: "):
                declared_files = int(line.split(": ", 1)[1])
            elif line.startswith("bytes: "):
                declared_bytes = int(line.split(": ", 1)[1])
            elif line.startswith("total-sha256: "):
                declared_total = line.split(": ", 1)[1].strip()
            elif in_rows and line.strip():
                rel, _, sha = line.rpartition("  ")
                rows.append((rel, sha))

    # 1) total-sha256 = sha256(rows.join('\n'))   与 pack-release.mjs:318 同口径
    recomputed = hashlib.sha256("\n".join(f"{r}  {s}" for r, s in rows).encode()).hexdigest()
    ok_total = recomputed == declared_total

    # 2) 逐文件校验
    bad = []
    total_bytes = 0
    for rel, sha in rows:
        p = os.path.join(root, rel)
        if not os.path.isfile(p):
            bad.append((rel, "MISSING", sha))
            continue
        actual = sha256_file(p)
        total_bytes += os.path.getsize(p)
        if actual != sha:
            bad.append((rel, actual[:12], sha[:12]))

    # 3) 磁盘上是否有 MANIFEST 未声明的文件（MANIFEST.txt 自身除外）
    on_disk = set()
    for dirpath, _dirnames, filenames in os.walk(root):
        for fn in filenames:
            rel = os.path.relpath(os.path.join(dirpath, fn), root).replace(os.sep, "/")
            if rel == "MANIFEST.txt":
                continue
            on_disk.add(rel)
    declared = {r for r, _ in rows}
    extra = sorted(on_disk - declared)

    print(f"pkg            : {root}")
    print(f"files declared : {declared_files}  (rows={len(rows)}, on-disk={len(on_disk)})")
    print(f"bytes declared : {declared_bytes}  (actual={total_bytes})")
    print(f"total-sha256   : {declared_total}")
    print(f"recomputed     : {recomputed}  -> {'MATCH' if ok_total else 'MISMATCH'}")

    fail = False
    if not ok_total:
        print("FAIL: total-sha256 mismatch")
        fail = True
    if declared_files is not None and declared_files != len(rows):
        print(f"FAIL: files count {declared_files} != rows {len(rows)}")
        fail = True
    if declared_bytes is not None and declared_bytes != total_bytes:
        print(f"FAIL: bytes {declared_bytes} != actual {total_bytes}")
        fail = True
    if bad:
        print(f"FAIL: {len(bad)} file(s) mismatch")
        for rel, got, want in bad[:20]:
            print(f"  - {rel}  got={got} want={want}")
        fail = True
    if extra:
        print(f"FAIL: {len(extra)} undeclared file(s)")
        for rel in extra[:20]:
            print(f"  + {rel}")
        fail = True

    print("RESULT:", "FAIL" if fail else "PASS")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
