import { validateActionsCompilationSettings } from "./app-validation.js";

/** Actions settings and dialogs share the application's existing draft and modal. */
export function createActionsUi(context) {
  const { state, $, t, esc, btn, field, formatDate, api, modal, closeModal, updateStatus, toast, acceptSavedConfig } = context;
  let progressRequest = 0;
  let refreshingProgress = false;
  let progressContent = "";

  function renderActionsCompilationSettings() {
    const options = state.config.settings.actionsCompilation || { enabled: false, repository: "", ref: "main" };
    const path = "settings.actionsCompilation";
    return `<section class="section"><div class="section-heading"><div class="help-title">
        <h2>${t("Actions 规则编译（选配）", "Actions rule compilation (optional)")}</h2>
        <details class="settings-help">
          <summary aria-label="${t("了解 Actions 规则编译", "About Actions rule compilation")}"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.7-2.5 1.8-2.5 3.5M12 16v.1"/></svg></summary>
          <div class="settings-help-content">
            <p>${t("将规则编译交给 GitHub Actions，减轻 Worker 处理大规则集时的超时压力。", "Offload rule compilation to GitHub Actions to reduce Worker timeouts when processing large rule sets.")}</p>
            <p>${t("支持 Surge 文本规则、Clash YAML 和 sing-box SRS。未启用或产物未就绪时，由 Worker 处理并提供规则。", "Supports Surge text rules, Clash YAML and sing-box SRS. The Worker processes and serves rules when Actions is disabled or artifacts are not ready.")}</p>
            <p>${t("编译结果保存在公开 GitHub 仓库，规则内容会公开。", "Compiled rules are stored in a public GitHub repository, so their contents are public.")}</p>
            <p>${t("GitHub Token 仅选择目标仓库，授予 Actions、Contents、Workflows、Secrets 读写权限。同一个 Token 用于安装与日常编译，加密保存在 KV；启用期间请勿撤销。", "Limit the GitHub token to the target repository and grant Actions, Contents, Workflows and Secrets read/write access. The same token is used for installation and ongoing compilation, stored encrypted in KV; keep it valid while Actions compilation is enabled.")}</p>
            <p>${t("按顺序完成检查、安装和启用。仓库文件公开；凭据仅保存为加密数据或 GitHub Secrets。不会保存其他页面的草稿。", "Check, install and enable in order. Repository files are public; credentials remain encrypted or in GitHub Secrets. Other page drafts are not saved.")}</p>
            <p class="help">${t("自动填入上次成功安装时使用的地址。建议填写本部署的 workers.dev 地址，避免自定义域名的人机验证。仅检查地址格式，不检查连通性；请确认地址属于本部署。实际连接由 GitHub Action 执行。", "Uses the address from the last successful installation. Prefer this deployment's workers.dev address to avoid custom-domain bot challenges. Only address format is checked, not connectivity; ensure it belongs to your deployment. GitHub Actions makes the actual connection.")}</p>
            <p class="help">${t("向导会安装或更新通用工作流与编译器。产物固定使用 rules 分支，按三个客户端分目录保存。", "The wizard installs or updates the shared workflow and compiler. Artifacts use the fixed rules branch with a directory for each client.")}</p>
          </div>
        </details>
      </div></div>`
      + field(`${path}.enabled`, options.enabled, { label: t("启用 Actions 规则编译", "Enable Actions rule compilation") })
      + `<div id="actions-compiler-settings" ${options.enabled ? "" : "hidden"}>`
      + field(`${path}.repository`, options.repository, { label: t("公开 GitHub 仓库（owner/repo）", "Public GitHub repository (owner/repo)") })
      + field(`${path}.ref`, options.ref, { label: t("工作流分支（仓库默认分支）", "Workflow branch (repository default)") })
      + `<div class="toolbar">${btn(t("配置向导", "Setup wizard"), "actions-setup", "", "primary")}${btn(t("查看编译进度", "View compilation progress"), "actions-progress")}</div>`
      + `</div></section>`;
  }
  function actionsDispatchFailure(code) {
    const hints = {
      401: t("GitHub Token 无效或已过期，请通过配置向导更新。", "The GitHub token is invalid or expired. Update it through the setup wizard."),
      403: t("请检查 GitHub Token 的 Actions 读写权限、组织审批状态及 API 调用限制。", "Check the GitHub token's Actions read/write permission, organization approval and API rate limits."),
      404: t("请检查仓库及 GitHub Token 的访问权限，并通过配置向导重新安装工作流。", "Check the repository and the GitHub token's access, then reinstall the workflow through the setup wizard."),
      422: t("请检查工作流分支是否存在、工作流是否支持手动触发（workflow_dispatch），以及输入参数是否正确。", "Check that the workflow branch exists, the workflow supports manual dispatch (workflow_dispatch), and its inputs are valid.")
    };
    return code ? `${hints[code] || t("请检查 GitHub 仓库和 Actions 设置后重试。", "Check the GitHub repository and Actions settings, then retry.")} (HTTP ${code})`
      : t("网络异常或请求超时，暂时无法确认 GitHub 是否收到请求。请先查看仓库 Actions，再决定是否重试。", "A network error or timeout prevented confirmation that GitHub received the request. Check repository Actions before retrying.");
  }
  function actionsProgressStage(output) {
    const stages = {
      workflow_update_required: [t("需更新工作流", "Workflow update required"), "warning", t("请返回系统设置，运行配置向导以更新工作流和编译脚本。", "Return to System settings and run the setup wizard to update the workflow and compiler script.")],
      pending: [t("等待提交", "Waiting to submit"), "pending", t("尚未提交编译请求，等待后台处理。", "The compilation request has not been submitted yet. Waiting for background processing.")],
      awaiting: [t("等待请求结果", "Awaiting request result"), "pending", t("已尝试提交请求，尚未确认 GitHub 是否接收。请稍后刷新。", "A submission was attempted, but receipt by GitHub is still unconfirmed. Refresh shortly.")],
      accepted: [t("等待编译结果", "Awaiting compilation result"), "pending", t("GitHub 已接收请求，尚未确认编译完成。排队情况和执行进度请查看仓库 Actions。", "GitHub accepted the request; completion is not yet confirmed. Check repository Actions for queue status and execution progress.")],
      dispatch_failed: [output.httpStatus ? t("提交失败", "Submission failed") : t("请求结果未确认", "Request not confirmed"), "warning", actionsDispatchFailure(output.httpStatus)],
      retrying: [t("等待重试", "Awaiting retry"), "warning", t("上次提交已超过 60 分钟，仍未确认完成。后台会再次尝试，也可手动重新提交。", "The last submission was over 60 minutes ago and completion is still unconfirmed. The background process will retry, or you can resubmit manually.")],
      complete: [t("已就绪", "Ready"), "ready", ""]
    };
    const [label, tone, description] = stages[output.state] || [t("状态待确认", "Status unknown"), "pending", t("请刷新状态，或前往仓库 Actions 查看运行情况。", "Refresh the status or check repository Actions for execution details.")];
    return { label, tone, description };
  }
  function renderActionsProgress(status) {
    const hasOutputs = status.enabled && status.total > 0;
    const allReady = hasOutputs && status.completed === status.total;
    const retryable = status.outputs.find((output) => ["pending", "awaiting", "accepted", "dispatch_failed", "retrying"].includes(output.state));
    const heading = !status.enabled ? t("尚未启用 Actions 编译", "Actions compilation is not enabled")
      : !hasOutputs ? t("暂无需要编译的规则集", "No rule sets need compilation")
      : allReady ? t("Actions 产物全部就绪", "All Actions artifacts are ready") : t("Actions 编译进度", "Actions compilation progress");
    const description = !status.enabled ? t("当前由 Worker 处理规则。可在系统设置中通过配置向导启用 Actions 规则编译。", "Rules are currently processed by the Worker. Enable Actions rule compilation through the setup wizard in System settings.")
      : !hasOutputs ? t("当前已保存配置中，没有需要合并或转换的规则集。请检查各客户端的规则来源编排。", "The saved configuration has no rule sets requiring merging or conversion. Check the rule plans for each client.")
      : allReady ? t("在对应客户端中更新订阅，即可使用已发布的规则集。", "Update the subscription in each client to use the published rule sets.")
      : t("Actions 正在后台处理或确认结果。未就绪的规则由 Worker 处理，更新订阅无需等待 Actions 完成。", "Actions processing or publication confirmation is pending. The Worker handles unready rule sets, so subscription updates do not need to wait for Actions.");
    const renderRow = (output) => {
      const stage = actionsProgressStage(output);
      return `<li class="actions-progress-item"><div class="actions-progress-item-heading"><strong>${esc(output.name)}</strong><span class="actions-progress-state ${stage.tone}">${esc(stage.label)}</span></div>
        ${stage.description ? `<p class="actions-progress-description">${esc(stage.description)}</p>` : ""}
        ${output.hasPublishedVersion && output.state !== "complete" ? `<p class="help">${t("刷新期间可继续使用已发布的规则。", "Previously published rules remain available during refresh.")}</p>` : ""}
        ${!output.hasPublishedVersion ? `<p class="help">${output.workerFallbackReady ? t("当前由 Worker 缓存提供规则，订阅可继续使用。", "Worker-cached rules are available for subscriptions.") : t("Worker 将按需准备规则，无需等待 Actions 产物。", "The Worker prepares rules on demand without waiting for Actions artifacts.")}</p>` : ""}
        ${output.lastAttemptAt ? `<p class="help actions-progress-attempt">${t("最近提交尝试", "Last submission attempt")}: ${esc(formatDate(output.lastAttemptAt))}</p>` : ""}</li>`;
    };
    const rows = ["surge", "clash", "sing-box"].map((target) => {
      const outputs = status.outputs.filter((output) => output.target === target);
      const label = { surge: "Surge", clash: "Clash", "sing-box": "sing-box" }[target];
      return outputs.length ? `<section class="actions-progress-client"><h3>${label}<span class="small muted">${outputs.filter((output) => output.state === "complete").length} / ${outputs.length} ${t("已就绪", "ready")}</span></h3><ul class="actions-progress-list" aria-label="${label}">${outputs.map(renderRow).join("")}</ul></section>` : "";
    }).join("");
    return `
        <div class="actions-progress-overview" role="status"><div class="actions-progress-heading"><h3>${heading}</h3>${hasOutputs ? `<p class="actions-progress-count"><strong>${status.completed} / ${status.total}</strong><span>${t("Actions 产物已就绪", "Actions artifacts ready")}</span></p>` : ""}</div><p>${description}</p></div>
        ${hasOutputs ? rows : ""}
        ${retryable ? `<div class="actions-progress-retry">${btn(t("重新提交编译", "Resubmit compilation"), "actions-force-retry", `data-output="${esc(retryable.name)}" data-target="${esc(retryable.target)}" aria-describedby="actions-retry-help"`)}<p class="help" id="actions-retry-help">${t("重新提交后，GitHub 将检查全部规则集，跳过已就绪且未变化的规则集。无需等待 60 分钟重试间隔，但可能新增一个排队批次。", "After resubmission, GitHub checks all rule sets and skips unchanged ready ones. This bypasses the 60-minute retry interval, but may queue an extra batch.")}</p></div>` : ""}
        <p class="help actions-progress-note">${t("显示已保存配置的状态。点击“刷新状态”获取最新结果。", "Shows the saved configuration. Select Refresh status for the latest result.")}</p>
      `;
  }
  async function showActionsProgress() {
    const dialog = $("#modal");
    const body = $("#modal-body");
    const previousContent = body.firstChild;
    const previousSave = modal.save;
    const wasOpen = dialog.open;
    const request = ++progressRequest;
    const status = await api("/api/actions-compilation/status");
    if (request !== progressRequest || dialog.open !== wasOpen || body.firstChild !== previousContent || modal.save !== previousSave) return;
    progressContent = renderActionsProgress(status);
    modal(t("Actions 编译进度", "Actions compilation progress"),
      `<div class="actions-progress">${progressContent}</div>`, refreshVisibleProgress, t("刷新状态", "Refresh status"));
    $('#modal-actions [data-action="close-modal"]').textContent = t("关闭", "Close");
  }
  async function refreshVisibleProgress() {
    const dialog = $("#modal");
    const progress = $("#modal-body > .actions-progress");
    if (refreshingProgress || !dialog.open || !progress
      || modal.retryingActions || modal.installingActions || modal.skippingActionsUpgrade) return;
    refreshingProgress = true;
    const request = ++progressRequest;
    try {
      const status = await api("/api/actions-compilation/status");
      // A completed request must never reopen a dialog or replace another form's inputs.
      if (request !== progressRequest || !dialog.open || $("#modal-body > .actions-progress") !== progress
        || modal.retryingActions || modal.installingActions || modal.skippingActionsUpgrade) return;
      const content = renderActionsProgress(status);
      if (content !== progressContent) {
        progress.innerHTML = content;
        progressContent = content;
      }
    } finally {
      refreshingProgress = false;
    }
  }
  function applyActionsSettings(saved) {
    acceptSavedConfig(saved, { appliedPaths: ["settings.actionsCompilation"] });
    const section = $("#actions-compiler-settings")?.closest("section");
    if (section) section.outerHTML = renderActionsCompilationSettings();
    updateStatus();
  }
  async function skipActionsUpgrade() {
    if (modal.installingActions || modal.skippingActionsUpgrade) return;
    modal.skippingActionsUpgrade = true;
    const controls = [...$("#modal").querySelectorAll("input, button")];
    controls.forEach((control) => { control.disabled = true; });
    try {
      const current = await api("/api/config");
      const settings = { ...current.settings.actionsCompilation, enabled: false };
      const updated = await api("/api/config", { method: "PATCH", body: JSON.stringify({ version: 3, settings: { actionsCompilation: settings } }) });
      applyActionsSettings(updated);
      modal.actionsUpgradeRequired = false;
      modal.skippingActionsUpgrade = false;
      closeModal();
      toast(t("已关闭 Actions 规则编译，继续由 Worker 提供规则。", "Actions rule compilation is disabled. The Worker continues serving rules."));
    } catch (error) {
      toast(t("关闭未保存，请重试：", "Disabling was not saved. Please retry: ") + error.message);
    } finally {
      modal.skippingActionsUpgrade = false;
      controls.forEach((control) => { control.disabled = false; });
    }
  }
  async function checkActionsUpgrade() {
    if (!state.config.settings.actionsCompilation?.enabled) return;
    try {
      const status = await api("/api/actions-compilation/status");
      if (!status.enabled || status.workflowReady !== false) return;
      modal.actionsUpgradeRequired = true;
      await showActionsSetup({ automatic: true });
    } catch (error) {
      modal(t("暂时无法检查 Actions 工作流", "Unable to check the Actions workflow"),
        `<p>${esc(error.message)}</p>`, checkActionsUpgrade, t("重新检查", "Retry check"));
      if (modal.actionsUpgradeRequired) $('#modal-actions [data-action="close-modal"]').textContent = t("跳过并关闭 Actions 编译", "Skip and disable Actions compilation");
    }
  }
  async function showActionsSetup({ automatic = false } = {}) {
    const status = await api("/api/actions-compilation/install/status");
    const settings = state.config.settings.actionsCompilation || {};
    const tokenMask = "********";
    const tokenHelp = () => status.dispatchTokenConfigured
      ? t("已配置。保留掩码沿用，输入新 Token 后保存即可替换。", "Configured. Keep the mask to reuse the token, or enter a new token and save to replace it.")
      : t("请填写仅授权目标仓库的 Token。", "Enter a token with access to the target repository only.");
    const callbackOrigin = status.callbackOrigin || (/^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(location.hostname) ? location.origin : "");
    modal(t("Actions 规则编译配置向导", "Actions rule compilation setup wizard"),
      `<div class="actions-setup-form">
      ${automatic ? `<p class="actions-setup-notice" role="status">${t("检测到 Actions 工作流需要更新，正在使用已保存的配置自动安装。安装失败时可修正后重试；选择跳过将关闭 Actions 规则编译，继续由 Worker 提供规则。", "The Actions workflow needs updating. Installing automatically with your saved settings. If installation fails, correct the settings and retry, or skip to disable Actions compilation and keep the Worker serving rules.")}</p>` : ""}
      <div class="actions-setup-row">
        <label for="actions-setup-repo">${t("公开仓库", "Public repository")}</label>
        <div class="actions-setup-field">
          <input id="actions-setup-repo" value="${esc(settings.repository || "")}" placeholder="owner/repo" spellcheck="false" autocapitalize="none" aria-describedby="actions-setup-repo-help">
          <div class="actions-setup-note">
            <p id="actions-setup-repo-help">${t("格式：owner/repo", "Format: owner/repo")}</p>
            <a href="https://github.com/new" target="_blank" rel="noopener noreferrer">${t("创建仓库（添加 README）", "Create repository (include README)")}</a>
          </div>
        </div>
      </div>
      <div class="actions-setup-row">
        <label for="actions-setup-origin">${t("工作流访问地址", "Workflow callback address")}</label>
        <div class="actions-setup-field">
          <input id="actions-setup-origin" type="url" value="${esc(callbackOrigin)}" spellcheck="false" autocapitalize="none" required>
        </div>
      </div>
      <div class="actions-setup-row">
        <label for="actions-setup-token">GitHub Token</label>
        <div class="actions-setup-field">
          <input id="actions-setup-token" type="password" autocomplete="new-password" value="${status.dispatchTokenConfigured ? tokenMask : ""}" aria-describedby="actions-setup-token-help actions-setup-token-scope">
          <div class="actions-setup-note">
            <p id="actions-setup-token-help">${tokenHelp()}</p>
            <a href="https://github.com/settings/personal-access-tokens/new?name=SubPilot&amp;expires_in=none&amp;actions=write&amp;contents=write&amp;workflows=write&amp;secrets=write" target="_blank" rel="noopener noreferrer">${t("申请 Token（预选权限）", "Create token (preset permissions)")}</a>
          </div>
          <p class="actions-setup-note" id="actions-setup-token-scope">${t("请在 GitHub 选择仓库所有者，并仅授权目标仓库。", "On GitHub, choose the repository owner and grant access only to the target repository.")}</p>
        </div>
      </div>
      <details class="actions-setup-advanced"><summary>${t("高级设置", "Advanced settings")}</summary>
        <div class="actions-setup-row">
          <label for="actions-setup-ref">${t("工作流分支", "Workflow branch")}</label>
          <div class="actions-setup-field">
            <input id="actions-setup-ref" value="${esc(settings.ref || "main")}" spellcheck="false" autocapitalize="none" aria-describedby="actions-setup-ref-help">
            <p class="actions-setup-note" id="actions-setup-ref-help">${t("使用仓库默认分支。", "Use the repository's default branch.")}</p>
          </div>
        </div>
      </details></div>
      <ol id="actions-setup-results" role="status" aria-live="polite"></ol>`, async () => {
        if (modal.installingActions) return;
        const next = { enabled: true, repository: $("#actions-setup-repo").value.trim(), ref: $("#actions-setup-ref").value.trim() };
        const invalid = validateActionsCompilationSettings(next, state.lang);
        if (invalid) throw Error(invalid);
        let token = $("#actions-setup-token").value.trim();
        if (status.dispatchTokenConfigured && token === tokenMask) token = "";
        $("#actions-setup-token").value = status.dispatchTokenConfigured ? tokenMask : "";
        if (!token && !status.dispatchTokenConfigured) throw Error(t("请填写所需 Token", "Enter the required tokens"));
        const callbackOrigin = $("#actions-setup-origin").value.trim();
        const replaceExisting = true;
        const controls = [...$("#modal").querySelectorAll("input, button")];
        const results = $("#actions-setup-results"); results.replaceChildren();
        const report = (message) => { const li = document.createElement("li"); li.textContent = message; results.append(li); };
        modal.installingActions = true; controls.forEach((control) => { control.disabled = true; });
        try {
          const saved = await api("/api/config");
          if (!Object.values(saved.clients || {}).some((client) => client.ruleSets?.mode === "compiled")) throw Error(t("请先为至少一个客户端启用规则来源编排并保存配置。", "Enable and save a rule plan for at least one client first."));
          if (token) {
            await api("/api/actions-compilation/credentials", { method: "PUT", body: JSON.stringify({ token }) });
            status.dispatchTokenConfigured = true;
          }
          report(t("编译凭据已配置", "Compilation credentials configured"));
          report(t("正在检查访问地址和仓库，然后安装工作流…", "Checking callback and repository, then installing workflow…"));
          const installed = await api("/api/actions-compilation/install", { method: "POST", body: JSON.stringify({ settings: next, token, callbackOrigin, replaceExisting }) });
          for (const step of installed.completed) {
            const [zh, en] = step.split(" / ");
            report(t(zh, en === "configured" ? `${zh.split(" ")[0]} configured` : en || zh));
          }
          const updated = await api("/api/config", { method: "PATCH", body: JSON.stringify({ version: 3, settings: { actionsCompilation: next } }) });
          applyActionsSettings(updated);
          modal.actionsUpgradeRequired = false;
          status.dispatchTokenConfigured = true;
          report(t("已启用并保存。后台将向 Actions 提交规则处理任务；关闭窗口后可查看各客户端进度。", "Enabled and saved. Rule processing will be submitted to Actions; close this dialog to view progress for each client."));
          const countdown = document.createElement("p");
          countdown.setAttribute("role", "status");
          results.after(countdown);
          const expiresAt = Date.now() + 5000;
          const updateCountdown = () => {
            const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
            countdown.textContent = t(`配置成功，${seconds} 秒后自动关闭`, `Setup complete. Closing in ${seconds} seconds.`);
            if (!seconds) closeModal();
          };
          updateCountdown();
          modal.autoCloseTimer = setInterval(updateCountdown, 250);
          modal.save = null;
          $("#modal-actions").innerHTML = btn(t("关闭", "Close"), "close-modal");
        } catch (error) { report(error.message); }
        finally {
          token = "";
          $("#actions-setup-token").value = status.dispatchTokenConfigured ? tokenMask : "";
          $("#actions-setup-token-help").textContent = tokenHelp();
          modal.installingActions = false;
          controls.forEach((control) => { control.disabled = false; });
        }
      }, t("检查、安装并启用", "Check, install and enable"));
    $("#modal").classList.add("actions-setup-dialog");
    if (modal.actionsUpgradeRequired) {
      $('#modal-actions [data-action="close-modal"]').textContent = t("跳过并关闭 Actions 编译", "Skip and disable Actions compilation");
    }
    if (automatic) {
      try { await modal.save?.(); }
      catch (error) {
        const item = document.createElement("li");
        item.textContent = error.message;
        $("#actions-setup-results").append(item);
      }
    }
  }

  return { renderActionsCompilationSettings, showActionsProgress, applyActionsSettings, skipActionsUpgrade, checkActionsUpgrade, showActionsSetup };
}
