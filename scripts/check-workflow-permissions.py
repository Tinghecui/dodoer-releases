#!/usr/bin/env python3
"""调用方给的权限够不够被调用的 workflow 用（.github/workflows 里 `uses: ./.github/workflows/x.yml` 的 job）。

不够的话 GitHub 不报错、不跑，整个 run 直接 startup_failure，也没有 job 日志：2026-11-14 cowork-release.yml 的发布 job
改成 actions: write 以后，qa-package.yml 还给 actions: read，AI QA 现编包一直起不来。actionlint 不查这个。

用法：check-workflow-permissions.py <workflow 目录>；有不够的退出码 1。
"""
import pathlib
import sys

import yaml

LEVEL = {"none": 0, "read": 1, "write": 2}
NAME = {v: k for k, v in LEVEL.items()}


def perms(value):
    """permissions 的写法（字符串或映射）→ {范围: 级别}；没写返回 None（继承）。"""
    if value is None:
        return None
    if value == "write-all":
        return {"*": 2}
    if value == "read-all":
        return {"*": 1}
    return {k: LEVEL[v] for k, v in (value or {}).items()}


def level(p, scope):
    return p.get(scope, p.get("*", 0))


def main(root):
    root = pathlib.Path(root)
    docs = {f.name: yaml.safe_load(f.read_text()) for f in sorted(root.glob("*.yml"))}
    bad = 0
    for name, doc in docs.items():
        for job_id, job in (doc.get("jobs") or {}).items():
            uses = job.get("uses", "")
            if not uses.startswith("./.github/workflows/"):
                continue
            callee = docs.get(pathlib.Path(uses).name)
            if callee is None:
                continue
            given = perms(job.get("permissions"))
            if given is None:
                given = perms(doc.get("permissions"))
            if given is None:
                continue  # 用仓库的默认权限，这里看不出来
            top = perms(callee.get("permissions"))
            for callee_job_id, callee_job in (callee.get("jobs") or {}).items():
                need = perms(callee_job.get("permissions"))
                if need is None:
                    need = top
                if need is None:
                    continue  # 继承调用方的，一定够
                for scope in need:
                    if level(given, scope) < level(need, scope):
                        bad += 1
                        print(f"::error file={root / name}::{name} 的 job {job_id} 调 {pathlib.Path(uses).name} 的 {callee_job_id}，"
                              f"给的 {scope}: {NAME[level(given, scope)]}，那个 job 要 {scope}: {NAME[level(need, scope)]}。"
                              "不够的话整个 run 是 startup_failure")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else ".github/workflows"))
