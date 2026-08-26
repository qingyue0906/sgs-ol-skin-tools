"use strict";

const idsText = document.getElementById("idsText");
const urlsText = document.getElementById("urlsText");
const harFile = document.getElementById("harFile");
const workersIn = document.getElementById("workers");
const noStaticIn = document.getElementById("noStatic");
const skelsIn = document.getElementById("skels");
const btnStart = document.getElementById("btnStart");
const btnStop = document.getElementById("btnStop");
const dlStatus = document.getElementById("dlStatus");
const dlProgress = document.getElementById("dlProgress");
const dlLog = document.getElementById("dlLog");

const LOG_TAG_CLASS = {
  "[OK]  ": "ok", "[SKIP]": "skip", "[N/A] ": "na", "[FAIL]": "fail"
};
let pollTimer = null;
let shownLines = 0;
let busy = false;

function appendLog(lines) {
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) continue;
    const div = document.createElement("div");
    let cls = "info";
    for (const tag in LOG_TAG_CLASS) {
      if (line.startsWith(tag)) { cls = LOG_TAG_CLASS[tag]; break; }
    }
    if (line.startsWith("[HAR]") || line.startsWith("[IDS]") || line.startsWith("[URLS]")) cls = "info";
    if (line.startsWith("任务异常") || line.startsWith("[")) cls = "fail";
    div.className = cls;
    div.textContent = line;
    dlLog.appendChild(div);
    shownLines++;
  }
  dlLog.scrollTop = dlLog.scrollHeight;
}

function setBusy(b) {
  busy = b;
  btnStart.disabled = b;
  btnStop.disabled = !b;
  dlProgress.hidden = !b;
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function poll() {
  fetch("/api/download").then(r => r.json()).then(j => {
    if (shownLines < j.log.length) appendLog(j.log.slice(shownLines));
    const done = j.stats.ok + j.stats.skip + j.stats["404"] + j.stats.fail;
    if (j.total > 0) {
      dlProgress.value = Math.min(100, Math.round(done / j.total * 100));
    } else {
      dlProgress.value = 0;
    }
    let text = "状态: " + j.status;
    if (j.status === "running" && j.total > 0) {
      text += "（" + done + "/" + j.total + "）";
    }
    if (j.stats.ok || j.stats.skip || j.stats["404"] || j.stats.fail) {
      text += " 下载" + j.stats.ok + " 跳过" + j.stats.skip +
              " 不存在" + j.stats["404"] + " 失败" + j.stats.fail;
    }
    if (j.elapsed) text += " 耗时" + j.elapsed + "s";
    dlStatus.textContent = text;

    if (j.status === "done" || j.status === "stopped" || j.status === "error") {
      stopPolling();
      setBusy(false);
      if (j.status === "error") appendLog(["任务异常: " + j.error]);
      if (j.status === "done") {
        refreshSkins();
        dlStatus.textContent = "完成 ✅ " + text.replace(/^状态:\s*/, "");
      }
    }
  }).catch(e => {
    stopPolling();
    setBusy(false);
    dlStatus.textContent = "轮询失败: " + e;
  });
}

btnStart.addEventListener("click", () => {
  if (busy) return;
  const fd = new FormData();
  fd.append("ids_text", idsText.value);
  fd.append("urls_text", urlsText.value);
  fd.append("workers", workersIn.value || "4");
  if (noStaticIn.checked) fd.append("no_static", "1");
  if (skelsIn.checked) fd.append("skels", "1");
  if (harFile.files.length) fd.append("har", harFile.files[0]);

  fetch("/api/download", { method: "POST", body: fd })
    .then(r => r.json().then(j => ({ ok: r.ok, j })))
    .then(({ ok, j }) => {
      if (!ok) { dlStatus.textContent = "启动失败: " + (j.error || j.message); return; }
      dlLog.innerHTML = "";
      shownLines = 0;
      setBusy(true);
      dlStatus.textContent = "任务已开始...";
      poll();
      pollTimer = setInterval(poll, 1000);
    })
    .catch(e => { dlStatus.textContent = "启动失败: " + e; });
});

btnStop.addEventListener("click", () => {
  fetch("/api/download/stop", { method: "POST" })
    .then(r => r.json())
    .then(j => { dlStatus.textContent = j.message || "已请求停止"; })
    .catch(() => {});
});

window.addEventListener("beforeunload", stopPolling);