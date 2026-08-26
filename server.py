#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
三国杀OL 资源 WebUI 服务器（纯标准库，无需 pip 安装任何依赖）

提供:
  /web/             WebUI（下载面板 + 播放器面板）
  /output/          下载的资源（静态）
  /api/skins        皮肤列表 JSON（含 daiji.json 的可播放皮肤）
  /api/skin/{id}    某个皮肤的文件列表 JSON
  /api/cg           CG 视频列表
  /api/download     下载任务（GET 轮询状态 / POST 提交 / POST stop 取消）

用法:  python server.py [--port 8123] [--no-browser]
"""
import argparse
import json
import re
import sys
import tempfile
import threading
import time
import webbrowser
from email.parser import BytesParser
from email.policy import default as email_policy
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import grabber

ROOT = Path(__file__).resolve().parent
SKINS = ROOT / "output" / "skins"
MAX_LOG = 500


def port_in_use(port):
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", port))
        return False
    except OSError:
        return True
    finally:
        s.close()


class DownloadJob:
    """后台下载任务（单任务互斥）"""

    def __init__(self):
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.status = "idle"  # idle / running / done / stopped / error
        self.stats = {}
        self.total = 0
        self.log = []
        self.started = 0.0
        self.finished = 0.0
        self.error = ""
        self.thread = None

    def snapshot(self):
        with self.lock:
            return {
                "status": self.status,
                "total": self.total,
                "stats": dict(self.stats),
                "log": list(self.log),
                "elapsed": round((self.finished or time.time()) - self.started, 1)
                if self.started else 0,
                "error": self.error,
            }

    def _log(self, line):
        with self.lock:
            self.log.append(line)
            if len(self.log) > MAX_LOG:
                del self.log[:len(self.log) - MAX_LOG]

    def start(self, fields, har_bytes):
        if self.status == "running":
            return False, "已有下载任务在运行，请等待完成或先停止"
        with self.lock:
            self.__init__()
            self.stop_event = threading.Event()
            self.status = "running"
            self.started = time.time()
        self.thread = threading.Thread(target=self._run, args=(fields, har_bytes), daemon=True)
        self.thread.start()
        return True, "任务已开始"

    def stop(self):
        self.stop_event.set()
        return True, "正在停止（等待当前文件下载完）"

    def _run(self, fields, har_bytes):
        try:
            tmpdir = tempfile.TemporaryDirectory(prefix="sgs_webui_")
            try:
                ids_file, urls_file, har_file = None, None, None
                ids_text = (fields.get("ids_text") or "").strip()
                if ids_text:
                    ids_file = Path(tmpdir.name) / "ids.txt"
                    ids_file.write_text(ids_text, encoding="utf-8")
                urls_text = (fields.get("urls_text") or "").strip()
                if urls_text:
                    urls_file = Path(tmpdir.name) / "urls.txt"
                    urls_file.write_text(urls_text, encoding="utf-8")
                if har_bytes:
                    har_file = Path(tmpdir.name) / "upload.har"
                    har_file.write_bytes(har_bytes)

                try:
                    workers = int(fields.get("workers") or 4)
                except ValueError:
                    workers = 4
                no_static = bool(fields.get("no_static"))
                skels = bool(fields.get("skels"))

                tasks = grabber.collect_tasks(
                    [str(har_file)] if har_file else None,
                    [str(ids_file)] if ids_file else None,
                    [str(urls_file)] if urls_file else None,
                    out_dir=str(ROOT / "output"),
                    no_static=no_static, skels=skels, log=self._log)
                with self.lock:
                    self.total = len(tasks)
                if tasks:
                    self._log("任务总数: %d, 并发: %d" % (len(tasks), workers))
                    self.stats = grabber.run_jobs(tasks, workers,
                                                  self.stop_event, log=self._log)
                else:
                    self._log("没有可下载的任务")
            finally:
                tmpdir.cleanup()
            with self.lock:
                self.status = "stopped" if self.stop_event.is_set() else "done"
                self.finished = time.time()
        except Exception as exc:
            with self.lock:
                self.status = "error"
                self.error = "%s: %s" % (type(exc).__name__, exc)
                self.finished = time.time()
            self._log("任务异常: %s" % self.error)


JOB = DownloadJob()


def parse_multipart(body, content_type):
    """解析 multipart/form-data 请求体，返回 (fields: dict[str,str], files: dict[str,bytes])"""
    fields, files = {}, {}
    msg = BytesParser(policy=email_policy).parsebytes(
        ("Content-Type: " + content_type + "\r\nMIME-Version: 1.0\r\n\r\n").encode("utf-8")
        + body)
    for part in msg.iter_parts():
        cd = part.get("Content-Disposition", "")
        m = re.search(r'name="([^"]*)"', cd)
        if not m:
            continue
        name = m.group(1)
        if part.get_filename():
            files[name] = part.get_payload(decode=True) or b""
        else:
            payload = part.get_payload(decode=True)
            fields[name] = payload.decode("utf-8", "replace") if payload else ""
    return fields, files


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/":
            self.send_response(302)
            self.send_header("Location", "/web/")
            self.end_headers()
            return
        if path == "/api/skins":
            skins = []
            if SKINS.is_dir():
                for d in sorted(SKINS.iterdir()):
                    if d.is_dir() and (d / "daiji.json").exists():
                        skins.append(d.name)
            self._json({"skins": skins})
            return
        m = re.match(r"^/api/skin/(\d+)$", path)
        if m:
            d = SKINS / m.group(1)
            files = sorted(p.name for p in d.iterdir() if p.is_file()) if d.is_dir() else []
            self._json({"id": m.group(1), "files": files})
            return
        if path == "/api/cg":
            cgs = []
            cg_dir = ROOT / "output" / "cg"
            if cg_dir.is_dir():
                for f in sorted(cg_dir.iterdir()):
                    if f.is_file():
                        cgs.append(f.name)
            self._json({"cg": cgs})
            return
        if path == "/api/download":
            self._json(JOB.snapshot())
            return
        super().do_GET()

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/api/download":
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length)
            ctype = self.headers.get("Content-Type", "")
            fields, files = ({}, {})
            if ctype.startswith("multipart/form-data"):
                try:
                    fields, files = parse_multipart(body, ctype)
                except Exception as exc:
                    self._json({"ok": False, "error": "表单解析失败: %s" % exc}, 400)
                    return
            elif ctype.startswith("application/x-www-form-urlencoded"):
                for pair in body.decode("utf-8", "replace").split("&"):
                    if "=" in pair:
                        k, v = pair.split("=", 1)
                        from urllib.parse import unquote_plus
                        fields[unquote_plus(k)] = unquote_plus(v)
            if not (fields.get("ids_text") or fields.get("urls_text") or files.get("har")):
                self._json({"ok": False, "error": "请至少填写皮肤 ID 或 URL，或上传 HAR 文件"}, 400)
                return
            ok, msg = JOB.start(fields, files.get("har"))
            self._json({"ok": ok, "message": msg}, 200 if ok else 409)
            return
        if path == "/api/download/stop":
            JOB.stop()
            self._json({"ok": True, "message": "已请求停止"})
            return
        self._json({"ok": False, "error": "未知接口"}, 404)


def main():
    ap = argparse.ArgumentParser(description="三国杀OL 资源 WebUI 服务器")
    ap.add_argument("--port", type=int, default=8123)
    ap.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    args = ap.parse_args()
    url = "http://127.0.0.1:%d/web/" % args.port
    if port_in_use(args.port):
        print("端口 %d 已被占用，可能已有服务器在运行。" % args.port, flush=True)
        print("请关闭占用该端口的进程后重试，或改用 --port 指定其他端口。", flush=True)
        return 1
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.allow_reuse_address = True
    print("=" * 50, flush=True)
    print("三国杀OL 资源 WebUI 服务器", flush=True)
    print("页面地址: %s" % url, flush=True)
    print("关闭本窗口（或按 Ctrl+C）即可停止服务", flush=True)
    print("=" * 50, flush=True)
    if not args.no_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("服务器已停止", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    if not sys.stdout.isatty():
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    sys.exit(main())