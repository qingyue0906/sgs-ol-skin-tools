#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
三国杀OL 网页端资源抓取工具（纯标准库，无需 pip 安装任何依赖）

三种模式（可组合使用）:
  python grabber.py --har login.har              # 解析浏览器导出的 HAR，提取动皮+静皮+CG视频并下载
  python grabber.py --ids skin_ids.txt           # 按皮肤 ID 下载动皮（每行一个 ID，# 开头为注释）
  python grabber.py --urls cg_urls.txt           # 按 URL 清单下载（每行一个直链）

可选参数:
  --out DIR      输出目录，默认 ./output
  --workers N    并发下载数，默认 4
  --no-static    不下载静态皮肤大图（默认抓取）
  --skels        连同 HAR 中所有 .sk/.skel/.atlas 骨骼文件一起下载（技能特效等）

输出结构:
  output/skins/{皮肤ID}/   动皮文件 + static.png(静皮大图)
  output/cg/              CG 视频
  output/extra/           --skels 抓到的其他骨骼文件

资源规律（均已实测验证）:
  OL互通版动皮(Spine JSON 三层 daiji/beijing/qianjing，含 _2 高清变体):
    https://web.sanguosha.com/220/h5_2/res/runtime/pc/animate/skinEffectBig/{id}/
  OL互通版动皮(新目录变体 skinEffectNew，无 _2 高清变体; 新老皮肤分属不同目录，脚本自动探测):
    https://web.sanguosha.com/220/h5_2/res/runtime/pc/animate/skinEffectNew/{id}/
  OL互通版武将形象(完整人物+攻击/技能/互动动画 xingxiang，多数动皮皮肤都有，同样按目录探测):
    https://web.sanguosha.com/220/h5_2/res/runtime/pc/animate/skinEffect{Big,New}/{id}/xingxiang.json
  OL互通版静皮大图:
    https://web.sanguosha.com/220/h5_2/res/runtime/pc/general/big/static/{id}.png
  十周年动皮(旧格式 LayaAir .sk / Spine .skel):
    https://web.sanguosha.com/10/pc/res/assets/runtime/general/big/dynamic/{id}/

说明:
  - 全程无登录、无模拟浏览器，纯 HTTP 静态资源下载（CDN 无鉴权，已实测）
  - OL动皮目录存在 skinEffectBig / skinEffectNew 两个变体，按 ID 探测哪个存在再下载，404 的目录不产生任务
  - atlas 下载后自动解析其引用的贴图页并补全缺失的多页图集（如 xingxiang_2~_5.png）
  - 已存在的文件自动跳过；失败自动重试 3 次；按 Content-Length 校验完整性
  - 动皮是骨骼动画不是视频，需本地播放器渲染；社区参考: LayaAir IDE + OBS 录屏
"""
import argparse
import json
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

OL_BASES = [
    "https://web.sanguosha.com/220/h5_2/res/runtime/pc/animate/skinEffectBig",
    "https://web.sanguosha.com/220/h5_2/res/runtime/pc/animate/skinEffectNew",
]
OL_STATIC_BASE = "https://web.sanguosha.com/220/h5_2/res/runtime/pc/general/big/static"
TH_BASE = "https://web.sanguosha.com/10/pc/res/assets/runtime/general/big/dynamic"

OL_NAMES = ["daiji", "beijing", "qianjing"]
OL_SUFFIXES = [".json", ".atlas", ".png", "_2.png"]
XINGXIANG_FILES = ["xingxiang.json", "xingxiang.atlas", "xingxiang.png"]
OL_KNOWN_FILES = {n + s for n in OL_NAMES for s in OL_SUFFIXES} | set(XINGXIANG_FILES)
TH_FILES = [
    "daiji.sk", "beijing.sk", "daiji.png", "beijing.png",
    "daiji.skel", "beijing.skel", "daiji.atlas", "beijing.atlas",
]
VIDEO_EXT = (".mp4", ".webm", ".flv", ".mov", ".m4v", ".ts")
SKEL_EXT = (".sk", ".skel", ".atlas")

OL_RE = re.compile(r"animate/(?:skinEffectBig|skinEffectNew)/(\d+)/([\w.\-]+)$", re.I)
TH_RE = re.compile(r"general/big/dynamic/(\d+)/([\w.\-]+)$", re.I)
STATIC_RE = re.compile(r"general/big/static/(\d+)\.png$", re.I)


def http_get(url, timeout=30):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Referer": "https://web.sanguosha.com/",
    })
    return urllib.request.urlopen(req, timeout=timeout)


def probe(url, timeout=15):
    """探测资源是否存在（GET 首包后立即关闭，不读取正文）"""
    try:
        resp = http_get(url, timeout=timeout)
        resp.close()
        return True
    except urllib.error.HTTPError as exc:
        return exc.code != 404


def download_one(url, dest, retries=3):
    dest = Path(dest)
    if dest.exists() and dest.stat().st_size > 0:
        return "skip"
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(1, retries + 1):
        try:
            resp = http_get(url)
            total = resp.headers.get("Content-Length")
            with open(tmp, "wb") as f:
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    f.write(chunk)
            if total is not None and tmp.stat().st_size < int(total):
                raise IOError("size mismatch: %s < %s" % (tmp.stat().st_size, total))
            tmp.replace(dest)
            return "ok"
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return "404"
            if attempt < retries:
                time.sleep(1.5 * attempt)
            else:
                return "fail(HTTP %d)" % exc.code
        except Exception as exc:
            if attempt < retries:
                time.sleep(1.5 * attempt)
            else:
                return "fail(%s)" % type(exc).__name__
    return "fail(unknown)"


def parse_har(path):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    entries = data.get("log", {}).get("entries", [])
    ol_ids, th_ids, static_ids = set(), set(), set()
    extras, videos, skels = {}, [], []
    seen_v = set()
    for e in entries:
        req = e.get("request", {})
        url = (req.get("url") or "").split("#")[0]
        if not url:
            continue
        m = OL_RE.search(url)
        if m:
            sid, fn = m.group(1), m.group(2)
            ol_ids.add(sid)
            if fn not in OL_KNOWN_FILES:
                extras.setdefault(sid, []).append(url)
            continue
        m = TH_RE.search(url)
        if m:
            sid, fn = m.group(1), m.group(2)
            th_ids.add(sid)
            if fn not in TH_FILES:
                extras.setdefault(sid, []).append(url)
            continue
        m = STATIC_RE.search(url)
        if m:
            static_ids.add(m.group(1))
            continue
        low = url.lower()
        resp = e.get("response", {})
        mime = ((resp.get("content") or {}).get("mimeType") or "").lower()
        if mime.startswith("video/") or low.endswith(VIDEO_EXT):
            if url not in seen_v:
                seen_v.add(url)
                videos.append(url)
        elif low.endswith(SKEL_EXT):
            skels.append(url)
    return sorted(ol_ids), sorted(th_ids), sorted(static_ids), extras, videos, skels


def read_ids(path):
    ids = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        for tok in re.split(r"[,\s]+", line):
            if tok.isdigit():
                ids.append(tok)
    return ids


def read_urls(path):
    urls = []
    seen = set()
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        url = line.split("#")[0].strip()
        if url and url not in seen:
            seen.add(url)
            urls.append(url)
    return urls


def basename(url, fallback_idx):
    name = url.split("?")[0].rstrip("/").rsplit("/", 1)[-1]
    if not name or "." not in name:
        name = "file_%04d" % fallback_idx
    return name


def atlas_pages(path):
    """读取本地 atlas 文件，返回所有贴图页文件名（size: 行的上一行，须为 png 文件名）"""
    pages = []
    try:
        prev = None
        for line in Path(path).read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            if line.startswith("size:") and prev and re.fullmatch(r"[\w./\-]+\.png", prev, re.I):
                pages.append(prev)
            prev = line
    except OSError:
        pass
    return pages


def collect_tasks(har_files=None, ids_files=None, urls_files=None,
                  out_dir="output", no_static=False, skels=False, log=None):
    """解析输入（HAR/ID清单/URL清单），构建下载任务列表 [(url, dest)]。

    log(str) 可选回调；返回任务列表（为空表示没有可下载内容）。
    """
    log = log or (lambda s: None)
    out = Path(out_dir)
    skin_dir, cg_dir, extra_dir = out / "skins", out / "cg", out / "extra"

    ol_ids, th_ids, static_ids = set(), set(), set()
    extras, videos, skels_list = {}, [], []

    for hp in har_files or []:
        try:
            h_ol, h_th, h_st, h_ex, h_vid, h_skel = parse_har(hp)
        except Exception as exc:
            log("[HAR] 解析失败 %s: %s" % (hp, exc))
            continue
        log("[HAR] %s -> OL动皮 %d 个, 十周年动皮 %d 个, 静皮 %d 个, CG视频 %d 个%s"
            % (hp, len(h_ol), len(h_th), len(h_st), len(h_vid),
               (", 骨骼 %d 个" % len(h_skel)) if h_skel else ""))
        ol_ids.update(h_ol)
        th_ids.update(h_th)
        static_ids.update(h_st)
        for k, v in h_ex.items():
            extras.setdefault(k, []).extend(v)
        videos.extend(h_vid)
        if skels:
            skels_list.extend(h_skel)

    for fp in ids_files or []:
        ids = read_ids(fp)
        log("[IDS] %s -> %d 个" % (fp, len(ids)))
        for sid in ids:
            if sid in ol_ids or sid in th_ids:
                continue
            # 纯 --ids 输入: 自动探测两个生态
            ol_ids.add(sid)
            th_ids.add(sid)
            static_ids.add(sid)

    for fp in urls_files or []:
        urls = read_urls(fp)
        log("[URLS] %s -> %d 个" % (fp, len(urls)))
        videos.extend(urls)

    tasks = []  # (url, dest)
    for sid in sorted(ol_ids):
        folder = skin_dir / sid
        for base in OL_BASES:
            if not probe(base + "/%s/daiji.json" % sid):
                continue
            has_hd = probe(base + "/%s/daiji_2.png" % sid)
            has_xx = probe(base + "/%s/xingxiang.json" % sid)
            for name in OL_NAMES:
                for suf in OL_SUFFIXES:
                    if suf == "_2.png" and not has_hd:
                        continue
                    fn = name + suf
                    tasks.append((base + "/%s/%s" % (sid, fn), folder / fn))
            if has_xx:
                for fn in XINGXIANG_FILES:
                    tasks.append((base + "/%s/%s" % (sid, fn), folder / fn))
    for sid in sorted(th_ids):
        folder = skin_dir / sid
        for fn in TH_FILES:
            tasks.append((TH_BASE + "/%s/%s" % (sid, fn), folder / fn))
    if not no_static:
        for sid in sorted(static_ids):
            tasks.append((OL_STATIC_BASE + "/%s.png" % sid,
                          skin_dir / sid / "static.png"))
    for sid, urls in extras.items():
        folder = skin_dir / sid
        for i, u in enumerate(dict.fromkeys(urls)):
            tasks.append((u, folder / basename(u, i)))
    for i, url in enumerate(dict.fromkeys(videos)):
        tasks.append((url, cg_dir / basename(url, i)))
    for i, url in enumerate(dict.fromkeys(skels_list)):
        tasks.append((url, extra_dir / basename(url, i)))
    return tasks


def run_jobs(tasks, workers=4, stop_event=None, log=None):
    """并发下载任务列表，返回统计 dict（ok/skip/404/fail）。

    - 第一遍下载主任务；第二遍读取本地 atlas 补全缺失贴图页
    - stop_event(threading.Event) 置位后取消剩余排队任务
    - log(str) 可选回调，逐条输出下载结果与汇总
    """
    log = log or (lambda s: None)
    stop = stop_event or threading.Event()
    stats = {"ok": 0, "skip": 0, "404": 0, "fail": 0}
    t0 = time.time()

    def run_pool(items, label):
        if not items:
            return
        log("%s %d 个" % (label, len(items)))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futs = {pool.submit(download_one, u, d): (u, d) for u, d in items}
            for fut in as_completed(futs):
                if stop.is_set():
                    try:
                        pool.shutdown(wait=False, cancel_futures=True)
                    except TypeError:
                        pool.shutdown(wait=False)
                    break
                u, d = futs[fut]
                st = fut.result()
                if st not in stats:
                    st = "fail"
                stats[st] += 1
                tag = {"ok": "[OK]  ", "skip": "[SKIP]", "404": "[N/A] "}.get(st, "[FAIL]")
                log("%s %s -> %s" % (tag, u, d))

    run_pool(tasks, "任务")

    # 第二遍: 读取已下载的 atlas，补全其引用的缺失贴图页（多页图集如 xingxiang_2~_5.png）
    atlas_tasks = []
    for atlas_file in sorted({d for u, d in tasks if str(d).endswith(".atlas")}):
        sid = atlas_file.parent.name
        for page in atlas_pages(atlas_file):
            dest = atlas_file.parent / page
            if dest.exists() and dest.stat().st_size > 0:
                continue
            for base in OL_BASES:
                if probe(base + "/%s/%s" % (sid, page)):
                    atlas_tasks.append((base + "/%s/%s" % (sid, page), dest))
                    break
    run_pool(atlas_tasks, "补下 atlas 引用贴图")

    log("完成: 下载 %d, 跳过 %d, 不存在 %d, 失败 %d, 耗时 %.1fs"
        % (stats["ok"], stats["skip"], stats["404"], stats["fail"], time.time() - t0))
    return stats


def main():
    ap = argparse.ArgumentParser(description="三国杀OL 网页端资源抓取工具")
    ap.add_argument("--har", nargs="+", metavar="FILE", help="浏览器导出的 HAR 文件（可多个）")
    ap.add_argument("--ids", nargs="+", metavar="FILE", help="皮肤 ID 清单文件")
    ap.add_argument("--urls", nargs="+", metavar="FILE", help="URL 清单文件")
    ap.add_argument("--out", default="output", help="输出目录，默认 output")
    ap.add_argument("--workers", type=int, default=4, help="并发数，默认 4")
    ap.add_argument("--no-static", action="store_true", help="不下载静态皮肤大图")
    ap.add_argument("--skels", action="store_true", help="同时下载 HAR 中的其他骨骼文件")
    args = ap.parse_args()

    if not (args.har or args.ids or args.urls):
        ap.error("至少需要 --har / --ids / --urls 之一")

    tasks = collect_tasks(args.har, args.ids, args.urls,
                          args.out, args.no_static, args.skels, log=print)
    if not tasks:
        print("没有可下载的任务")
        return

    print("任务总数: %d, 并发: %d" % (len(tasks), args.workers))
    stats = run_jobs(tasks, args.workers, log=print)
    if stats["fail"]:
        sys.exit(1)


if __name__ == "__main__":
    if not sys.stdout.isatty():
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    main()