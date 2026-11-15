#!/usr/bin/env python3
"""只查这次改了的行的 Rust 格式（CI 的「Rust fmt」用；本机是生产机，不许跑 rustfmt，见 AGENTS.md）。

仓库里的老代码从来没跑过 rustfmt：2026-11-15 第一次在 CI 上跑 `cargo fmt --all`，要改 300 个文件、两万多行。
一次全格式化掉，以后每一批搬 upstream 的改动（upstream 也不查格式）都会在这 300 个文件上冲突，所以老代码不动，
只要求新写、改过的行是 rustfmt 的样子。

用法：先在 src-tauri 里跑过 `cargo fmt --all`（工作区里就是全格式化以后的样子），再
    python3 -I scripts/rustfmt-changed-lines.py <基准提交|pr> <输出的 patch>
挑出 rustfmt 的改动里碰到「基准..HEAD 加了或改了的行」的那些块，工作区只留这些，写成普通的 patch
（在仓库根目录 `git apply` 就行）。有要改的退出码 1，没有 0。

基准写 pr：公开仓库的 pr/<n> 是「PR head 的树」挂在同步那一刻的公开 main 上（public-sync.sh），分支落后 product 时，
和 main 比会把它分出来以后别人合进来的改动反着算成这个 PR 的（2026-11-15 #256 没改 Rust，却被要求格式化 #257 改掉的旧行）。
所以顺着 main 往回找 src-tauri 和 HEAD 差得最少的提交，那就是分出来的地方：更新的多了别人改动的反向，更老的多了别人的改动。
"""
import re
import subprocess
import sys

HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def git(*args):
    # 不用 text=True：它会把 \r\n 换成 \n
    return subprocess.run(["git", *args], check=True, capture_output=True).stdout.decode("utf-8")


def lines_of(text):
    """按 \n 分行、留着换行符（str.splitlines 还会在 \u2028 之类的字符上分）"""
    parts = text.split("\n")
    return [p + "\n" for p in parts[:-1]] + ([parts[-1]] if parts[-1] else [])


def parse(diff):
    """{新路径: [(旧起始行, 旧行数, 块的行)]}，只要 -U0 / --inter-hunk-context 出来的块"""
    files, path, hunks = {}, None, None
    for line in diff.split("\n"):
        if line.startswith("diff --git "):
            path, hunks = None, None
        elif line.startswith("+++ "):
            path = None if line == "+++ /dev/null" else line[6:]
            hunks = files.setdefault(path, []) if path else None
        elif hunks is not None and (m := HUNK.match(line)):
            hunks.append((int(m[1]), 1 if m[2] is None else int(m[2]), int(m[3]), 1 if m[4] is None else int(m[4]), []))
        elif hunks and line[:1] in ("+", "-", " ", "\\"):
            hunks[-1][4].append(line)
    return files


def branch_point(limit=200, patience=30):
    """公开 main 上（从 HEAD 和 origin/main 的 merge-base 往回）src-tauri 和 HEAD 差得最少的提交；一样少取新的"""
    best, since_best = None, 0
    for c in git("rev-list", "--first-parent", f"-n{limit}", git("merge-base", "HEAD", "origin/main").strip()).split():
        n = sum(int(a) + int(d) for a, d, _ in (l.split("\t", 2) for l in git("diff", "--numstat", c, "HEAD", "--", "src-tauri").splitlines()) if a != "-")
        if best is None or n < best[1]:
            best, since_best = (c, n), 0
        else:
            since_best += 1
        if n == 0 or since_best >= patience:
            break
    return best[0]


def changed_lines(base):
    """基准..HEAD 里每个文件（HEAD 里的行号）加了或改了的行；删掉的地方记它后面那一行"""
    out = {}
    for path, hunks in parse(git("diff", "-U0", "-M", "--no-color", base, "HEAD", "--", "src-tauri")).items():
        lines = out.setdefault(path, set())
        for _, _, start, count, _ in hunks:
            lines.update(range(start, start + count) if count else (start, start + 1))
    return out


def main():
    base, out_path = sys.argv[1], sys.argv[2]
    if base == "pr":
        base = branch_point()
        print(f"和 {git('log', '-1', '--format=%h %s', base).strip()} 比（PR 从这里分出来）")
    touched = changed_lines(base)
    fmt = parse(git("diff", "-U0", "--inter-hunk-context=3", "--no-color", "--", "src-tauri"))
    kept_files, kept_hunks, all_hunks = 0, 0, 0
    for path, hunks in fmt.items():
        all_hunks += len(hunks)
        lines = touched.get(path, set())
        keep = []
        for old_start, old_count, _, _, body in hunks:
            span = range(old_start, old_start + old_count) if old_count else (old_start, old_start + 1)
            if any(n in lines for n in span):
                keep.append((old_start, old_count, body))
        # 工作区先退回 HEAD，再只把挑出来的块打上去（从后往前，前面的行号不受影响）
        head = lines_of(git("show", f"HEAD:{path}"))
        for old_start, old_count, body in reversed(keep):
            new = [l[1:] + "\n" for l in body if l[:1] in ("+", " ")]
            # 「\ No newline at end of file」跟在哪种行后面，那一边的最后一行就没有换行
            for i, l in enumerate(body):
                if l.startswith("\\") and i and body[i - 1][:1] in ("+", " ") and new:
                    new[-1] = new[-1].rstrip("\n")
            at = old_start - 1 if old_count else old_start
            head[at : at + old_count] = new
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write("".join(head))
        if keep:
            kept_files += 1
            kept_hunks += len(keep)
    patch = git("diff", "--no-color", "--", "src-tauri")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(patch)
    print(f"rustfmt 在 {len(fmt)} 个文件里有 {all_hunks} 处要改；碰到这次改动的：{kept_files} 个文件 {kept_hunks} 处")
    if patch:
        print(git("diff", "--stat", "--", "src-tauri"), end="")
    sys.exit(1 if patch else 0)


if __name__ == "__main__":
    main()
