export function createGeoipUi({ $, t, esc, btn, formatDate, api, toast }) {
  const mmdb = { status: null, loading: false, statusError: false, file: null, uploading: false, progress: 0, outcome: "", error: "", request: 0 };

  function renderMmdbSettings() {
    const mmdbPaths = [["Surge macOS", "~/Library/Application Support/com.nssurge.surge-mac/GeoLite2-Country.mmdb"], ["Clash Verge Windows", "%APPDATA%\\io.github.clash-verge-rev.clash-verge-rev\\Country.mmdb"], ["Clash Verge macOS", "~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/Country.mmdb"]];
    return `<section class="section mmdb-panel" aria-labelledby="mmdb-heading">
      <div class="section-heading"><h2 id="mmdb-heading">GeoIP MMDB</h2>${btn(t("刷新数据库信息", "Refresh database information"), "refresh-mmdb", `id="mmdb-refresh" ${mmdb.loading || mmdb.uploading ? "disabled" : ""}`, "quiet")}</div>
      <p class="help mmdb-description" data-help>${t("上传 MMDB 数据库用于节点地理位置识别。", "Upload an MMDB database for node geolocation.")}</p>
      <div class="mmdb-layout">
        <div id="mmdb-status" role="status" aria-live="polite"></div>
        <div class="mmdb-upload-panel" aria-labelledby="mmdb-upload-heading">
          <div class="help-title mmdb-upload-heading">
            <h3 id="mmdb-upload-heading">${t("上传数据库", "Upload database")}</h3>
            <details class="settings-help mmdb-help">
              <summary aria-label="${t("查看数据库文件路径提示", "Show database file path tips")}"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.7-2.5 1.8-2.5 3.5M12 16v.1"/></svg></summary>
      <div class="mmdb-path-help" aria-label="${t("MMDB 文件路径参考", "MMDB file path reference")}">
        <p class="help">${t("可从本机客户端选择现有文件：", "Select an existing file from a local client:")}</p>
        <dl>${mmdbPaths.map(([client, path]) => `<div class="mmdb-path-row"><dt>${esc(client)}</dt><dd><code>${esc(path)}</code></dd></div>`).join("")}</dl>
      </div>
            </details>
          </div>
          <div class="mmdb-upload-controls">
            <label for="mmdb-upload">${t("选择数据库文件", "Choose database file")}</label>
            <input type="file" id="mmdb-upload" accept=".mmdb" aria-describedby="mmdb-upload-help" ${mmdb.uploading ? "disabled" : ""}>
            ${btn(t("上传", "Upload"), "upload-mmdb", 'id="mmdb-submit" disabled', "primary")}
          </div>
          <p class="help" id="mmdb-upload-help">${t("最大 25 MiB。选择文件后点击上传，成功后立即生效。", "Up to 25 MiB. Select a file, then click Upload. Changes take effect on success.")}</p>
          <div id="mmdb-transfer" role="status" aria-live="polite"></div>
        </div>
      </div>

    </section>`;
  }

  function mmdbSize(size) {
    return `${(size / 1024 / 1024).toFixed(2)} MiB`;
  }
  // Status polling leaves the selected file and upload controls in place.
  function updateMmdbStatusView() {
    const status = $("#mmdb-status");
    if (!status) return;
    const current = mmdb.status;
    const rows = current?.uploaded ? [
      [t("当前文件", "Current file"), current.fileName || "—"],
      [t("数据库类型", "Database type"), current.databaseType || t("未知", "Unknown")],
      [t("文件大小", "File size"), mmdbSize(current.size || 0)],
      [t("数据库版本（构建时间）", "Database version (build time)"), current.builtAt ? formatDate(current.builtAt) : t("未提供构建时间", "Build time unavailable")],
      [t("上传时间", "Uploaded at"), formatDate(current.updatedAt)]
    ] : [];
    status.innerHTML = (rows.length ? `<dl class="mmdb-metadata">${rows.map(([name, value], index) => `<div${index === 0 ? ' class="mmdb-current-file"' : ""}><dt>${esc(name)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>` : "")
      + (current && !current.uploaded ? `<p class="muted mmdb-empty">${t("尚未上传 MMDB 数据库。", "No MMDB database uploaded.")}</p>` : "")
      + (mmdb.loading ? `<p class="muted">${t("正在读取数据库信息…", "Loading database information…")}</p>` : "")
      + (mmdb.statusError ? `<p class="danger-text">${t("无法读取当前数据库信息，请重试。", "Could not load current database information. Please retry.")}</p>` : "");
    status.setAttribute("aria-busy", String(mmdb.loading));
    $("#mmdb-refresh").disabled = mmdb.loading || mmdb.uploading;
  }
  function updateMmdbView() {
    if (!$("#mmdb-status")) return;
    updateMmdbStatusView();
    $("#mmdb-upload").disabled = mmdb.uploading;
    $("#mmdb-submit").disabled = !mmdb.file || mmdb.uploading;
    $("#mmdb-submit").textContent = mmdb.uploading ? t("上传中…", "Uploading…") : t("上传", "Upload");
    const selected = mmdb.file ? `<p class="mmdb-file">${t("已选择：", "Selected: ")}${esc(mmdb.file.name)} · ${mmdbSize(mmdb.file.size)}</p>` : "";
    const message = mmdb.uploading ? (mmdb.progress < 100 ? t(`正在上传 ${mmdb.progress}%`, `Uploading ${mmdb.progress}%`) : t("传输完成，正在校验并保存数据库…", "Transfer complete. Validating and saving the database…")) : mmdb.outcome === "success" ? t("上传成功，当前数据库信息已更新。", "Upload succeeded. Current database information updated.") : mmdb.outcome === "invalid" ? t("请选择非空的 .mmdb 文件，大小不能超过 25 MiB。", "Choose a nonempty .mmdb file up to 25 MiB.") : mmdb.outcome === "error" ? t(`上传未完成：${mmdb.error}。可点击上传重试，或刷新数据库信息确认当前状态。`, `Upload did not complete: ${mmdb.error}. Retry the upload or refresh database information to check the current state.`) : mmdb.file ? t("文件已准备好，请点击上传。", "File ready. Click Upload to start.") : "";
    $("#mmdb-transfer").innerHTML = selected + (mmdb.uploading ? `<progress max="100" ${mmdb.progress < 100 ? `value="${mmdb.progress}"` : ""} aria-label="${t("MMDB 上传进度", "MMDB upload progress")}"></progress>` : "") + (message ? `<p class="${["error", "invalid"].includes(mmdb.outcome) ? "danger-text" : "muted"}">${esc(message)}</p>` : "");
    $("#mmdb-transfer").setAttribute("aria-busy", String(mmdb.uploading));
  }
  async function loadMmdbStatus() {
    if (mmdb.uploading) return;
    const request = ++mmdb.request;
    const view = $("#mmdb-status");
    mmdb.loading = true;
    mmdb.statusError = false;
    updateMmdbStatusView();
    try {
      const status = await api("/api/geoip/mmdb");
      if (request === mmdb.request && view === $("#mmdb-status")) mmdb.status = status;
    } catch {
      if (request === mmdb.request && view === $("#mmdb-status")) mmdb.statusError = true;
    } finally {
      if (request === mmdb.request) {
        mmdb.loading = false;
        if (view === $("#mmdb-status")) updateMmdbStatusView();
      }
    }
  }
  async function uploadMmdb() {
    if (!mmdb.file || mmdb.uploading) return;
    const file = mmdb.file;
    ++mmdb.request;
    mmdb.loading = false;
    mmdb.uploading = true;
    mmdb.progress = 0;
    mmdb.outcome = "";
    updateMmdbView();
    try {
      const status = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/geoip/mmdb");
        xhr.timeout = 120000;
        xhr.setRequestHeader("content-type", "application/octet-stream");
        xhr.setRequestHeader("x-subpilot-file-name", encodeURIComponent(file.name));
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) mmdb.progress = Math.min(100, Math.floor(event.loaded / event.total * 100));
          updateMmdbView();
        };
        xhr.upload.onload = () => { mmdb.progress = 100; updateMmdbView(); };
        xhr.onload = () => {
          if (xhr.status === 401) { reject(Error(t("会话已过期，请重新登录", "Session expired. Sign in again"))); return; }
          let result;
          try { result = JSON.parse(xhr.responseText); } catch { reject(Error(t("服务器返回无效响应", "Invalid server response"))); return; }
          if (xhr.status < 200 || xhr.status >= 300 || !result?.uploaded) reject(Error(result?.error || t(`服务器错误 (${xhr.status})`, `Server error (${xhr.status})`)));
          else resolve(result);
        };
        xhr.onerror = () => reject(Error(t("网络连接失败", "Network connection failed")));
        xhr.ontimeout = () => reject(Error(t("请求超时", "Request timed out")));
        xhr.onabort = () => reject(Error(t("上传已中断", "Upload interrupted")));
        xhr.send(file);
      });
      mmdb.status = status;
      mmdb.statusError = false;
      mmdb.file = null;
      mmdb.outcome = "success";
      if ($("#mmdb-upload")) $("#mmdb-upload").value = "";
      toast(t("MMDB 已上传", "MMDB uploaded"));
    } catch (error) {
      mmdb.outcome = "error";
      mmdb.error = error.message;
    } finally {
      mmdb.uploading = false;
      updateMmdbView();
    }
  }

  return { mmdb, render: renderMmdbSettings, load: loadMmdbStatus, update: updateMmdbView, upload: uploadMmdb };
}
