/** Clash's routing form uses the existing rule plan as its only configuration state. */
export function createClashRoutingUi(ui) {
  const { state, t, esc, btn, field, section, modal, closeModal, localField, readLocal, policyChoices, selectOptions, orderedPlan, isFinalRule, splitRule, appendPlanItem, changed, render, api } = ui;
  const client = () => state.config.clients.clash;
  const plan = () => client().ruleSets;
  let compilation = null;
  let compileSignature = "";
  let failures = [];
  let pending = false;
  const signature = () => JSON.stringify(plan());
  const textRule = (item) => {
    const parts = splitRule(item.rule);
    if (isFinalRule(item.rule)) return parts[0];
    const options = parts.slice(2);
    if (options.length && !["no-resolve", "src", "extended-matching"].includes(options[0]?.toLowerCase())) options.shift();
    return [parts[0], parts[1], ...options].join(",");
  };
  const sourceUrls = (item) => item.sourceIds.map((id) => plan().sources.find((source) => source.id === id)?.url).filter(Boolean);
  const outputLabel = (name) => {
    if (plan().aggregateByPolicy) return name;
    const output = plan().outputs.find((item) => item.name === name);
    return output ? sourceUrls(output).join(" / ") || t("内联规则", "Inline rules") : name;
  };
  const policyField = (value) => localField("policy", value, { label: t("出口策略", "Outbound policy") }).replace("<input ", '<input list="clash-policy-choices" autocomplete="off" ') + `<datalist id="clash-policy-choices">${policyChoices(value).map((name) => `<option value="${esc(name)}"></option>`).join("")}</datalist>`;
  const checkPolicy = (value) => {
    if (!policyChoices().includes(value.trim())) throw Error(t("请选择已有且可用的出口策略。", "Choose an existing available outbound policy."));
    return value.trim();
  };

  function effectiveOrder() {
    const groups = new Map();
    const rows = [];
    for (const entry of orderedPlan(plan())) {
      if (!entry.item.enabled || (entry.kind === "direct" && isFinalRule(entry.item.rule))) continue;
      if (entry.kind === "output" && plan().aggregateByPolicy) {
        const key = entry.item.policy.trim();
        const existing = groups.get(key);
        if (existing) { existing.entries.push(entry); continue; }
        const row = { entries: [entry], policy: key, title: key };
        groups.set(key, row); rows.push(row);
      } else rows.push({ entries: [entry], policy: entry.item.policy, title: entry.kind === "output" ? entry.item.name : textRule(entry.item) });
    }
    return rows;
  }

  function renderPage() {
    if (plan().mode !== "compiled") return section(t("分流配置", "Routing"), `<p>${t("将旧原生规则转换为地址与出口策略表单。转换只修改草稿，保存并通过编译校验后生效。", "Convert native rules into source URL and outbound fields. Conversion changes the draft; saving activates it after compilation checks.")}</p>${btn(t("转换为分流配置", "Convert routing configuration"), "clash-migrate", pending ? "disabled" : "", "primary")}<div class="routing-errors">${failures.map((message) => `<p>${esc(message)}</p>`).join("")}</div><details class="routing-legacy"><summary>${t("检查或修正旧原生配置", "Review or repair native configuration")}</summary>${field("clients.clash.rules", client().rules)}${field("clients.clash.ruleProviders", client().ruleProviders, { multiline: true })}</details>`);
    const ordered = effectiveOrder();
    const positions = new Map(ordered.flatMap((row, index) => row.entries.map((entry) => [entry.item, index + 1])));
    const available = new Set(policyChoices());
    const compilationCurrent = compileSignature === signature();
    const rows = orderedPlan(plan()).filter((entry) => entry.kind !== "direct" || !isFinalRule(entry.item.rule)).map(({ item, kind, index }) => {
      const output = kind === "output";
      const urls = output ? sourceUrls(item) : [];
      const content = output ? urls.map((url) => `<div class="routing-url">${esc(url)}</div>`).join("") + (item.inlineRules.length ? `<span class="small muted">${t(`另有 ${item.inlineRules.length} 条内联规则`, `${item.inlineRules.length} inline rules`)}</span>` : "") : `<code>${esc(textRule(item))}</code>`;
      const missingSources = output && (item.sourceIds.some((id) => !plan().sources.some((source) => source.id === id && source.enabled)) || (!item.sourceIds.length && !item.inlineRules.length));
      const outputName = plan().aggregateByPolicy ? item.policy.trim() : item.name;
      const compileErrors = output && compilationCurrent ? failures.filter((message) => message.startsWith(`${outputName}:`)) : [];
      return `<tr><td class="routing-position">${positions.get(item) || "—"}</td><td class="routing-content"><span class="small muted">${output ? t("规则集", "Rule set") : t("单条规则", "Direct rule")}</span>${content}${compileErrors.map((message) => `<p class="danger-text small">${esc(message)}</p>`).join("")}${missingSources ? `<p class="danger-text small">${t("来源缺失或已停用，请编辑此规则集。", "Source missing or disabled. Edit this rule set.")}</p>` : ""}</td><td><select data-clash-field="policy" data-kind="${kind}" data-index="${index}" aria-label="${t("出口策略", "Outbound policy")}">${selectOptions(policyChoices(item.policy), item.policy)}</select>${!available.has(item.policy) ? `<p class="danger-text small">${t("出口不存在或已停用", "Outbound missing or disabled")}</p>` : ""}</td><td><label class="routing-enabled"><input type="checkbox" data-clash-field="enabled" data-kind="${kind}" data-index="${index}" ${item.enabled ? "checked" : ""}>${t("启用", "Enabled")}</label></td><td class="actions">${btn(t("编辑", "Edit"), output ? "edit-output" : "clash-edit-direct", `data-index="${index}"`)}${btn(t("删除", "Delete"), "clash-delete", `data-kind="${kind}" data-index="${index}"`, "quiet")}</td></tr>`;
    }).join("");
    const fallback = plan().directRules.find((item) => item.enabled && isFinalRule(item.rule));
    const help = plan().aggregateByPolicy ? t("同一出口的规则集合并、去重后分桶，在该出口首次出现的位置匹配。单条规则独立排序。", "Rule sets sharing an outbound are merged, deduplicated and bucketed at their first position. Direct rules keep separate positions.") : t("每个规则集独立去重、分桶，按各自顺序匹配。单条规则不参与编译。", "Each rule set is deduplicated and bucketed separately, retaining its own position. Direct rules are not compiled.");
    return section(t("分流配置", "Routing"), `<div class="routing-aggregation"><label><input type="checkbox" class="toggle" role="switch" data-clash-field="aggregate" ${plan().aggregateByPolicy ? "checked" : ""}>${t("按策略聚合后分桶输出", "Aggregate by policy before bucketing")}</label><p class="help">${help}</p></div><div class="toolbar">${btn(t("添加规则集", "Add rule set"), "add-output", "", "primary")}${btn(t("添加单条规则", "Add direct rule"), "clash-add-direct")}${btn(t("调整匹配顺序", "Reorder matching"), "clash-order")}</div><div class="table-wrap"><table class="routing-table"><thead><tr><th>${t("匹配顺序", "Match order")}</th><th>${t("规则集地址 / 单条规则", "Rule-set URL / Direct rule")}</th><th>${t("出口策略", "Outbound policy")}</th><th>${t("状态", "Status")}</th><th>${t("操作", "Actions")}</th></tr></thead><tbody>${rows || `<tr><td colspan="5" class="empty">${t("添加规则集地址并选择策略，或添加一条规则。", "Add a rule-set URL and choose a policy, or add a direct rule.")}</td></tr>`}</tbody></table></div><div class="routing-footer"><label>${t("兜底策略", "Final outbound")}<select data-clash-field="fallback" aria-label="${t("兜底策略", "Final outbound")}">${selectOptions(policyChoices(fallback?.policy || ""), fallback?.policy || "")}</select></label><span class="help">${t("未命中任何规则时使用", "Used when no rule matches")}</span><a href="#groups">${t("管理策略组", "Manage policy groups")}</a></div><details class="routing-results"><summary>${t("编译结果", "Compilation results")}</summary><p class="help">${t("domain、ipcidr 各自超过 1000 条时独立输出，其余并入 classical。", "Domain and ipcidr buckets are emitted separately above 1,000 rules each; smaller buckets join classical.")}</p><div class="toolbar">${btn(t("读取编译状态", "Read compilation status"), "clash-status", pending ? "disabled" : "")}${btn(t("刷新编译缓存", "Refresh compiled cache"), "clash-refresh", pending ? "disabled" : "")}</div>${renderCompilation()}</details>`, "");
  }

  function renderCompilation() {
    if (compileSignature !== signature()) return `<p class="muted">${t("配置已更改或尚未读取结果；保存后可检查编译状态。", "Configuration changed or results not loaded. Save before checking compilation.")}</p>`;
    return failures.map((message) => `<p class="danger-text">${esc(message)}</p>`).join("") + (compilation || []).map((item) => `<div class="routing-result"><strong>${esc(outputLabel(item.outputName))}</strong><span>${item.cached ? t(`${item.ruleCount} 条 · 已去重 ${item.duplicateCount} 条`, `${item.ruleCount} rules · ${item.duplicateCount} duplicates removed`) : t("待编译", "Pending compilation")}</span>${item.artifacts?.length ? `<p class="small">${item.artifacts.map((artifact) => `${esc(artifact.behavior)} · ${artifact.count}`).join(" / ")}</p>` : ""}${(item.warnings || []).map((message) => `<p class="help">${esc(message)}</p>`).join("")}</div>`).join("");
  }

  function editDirect(index) {
    const original = index === null ? null : plan().directRules[index];
    const parts = splitRule(original ? textRule(original) : "DOMAIN-SUFFIX,");
    const types = ["DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "DOMAIN-REGEX", "IP-CIDR", "IP-CIDR6", "GEOIP", "GEOSITE", "IP-ASN", "SRC-IP-CIDR", "SRC-IP-ASN", "PROCESS-NAME", "PROCESS-PATH", "PROCESS-NAME-REGEX", "NETWORK", "DSCP", "IN-PORT", "SRC-PORT", "DST-PORT", "AND", "OR", "NOT"];
    const form = { type: parts[0], value: parts[1] || "", policy: original?.policy || "Proxy", options: parts.slice(2).join(",") };
    modal(t("单条规则", "Direct rule"), localField("type", form.type, { label: t("匹配类型", "Match type"), options: [...new Set([...types, form.type])] }) + localField("value", form.value, { label: t("匹配值 / 逻辑表达式", "Match value / Logical expression"), multiline: ["AND", "OR", "NOT"].includes(form.type) }) + policyField(form.policy) + `<details><summary>${t("附加选项", "Options")}</summary>${localField("options", form.options, { label: "no-resolve / src" })}</details>`, () => {
      const value = readLocal(form);
      const match = value.value.trim();
      if (!match || /[\r\n]/.test(match) || !types.includes(value.type)) throw Error(t("请填写有效的单条匹配条件。", "Enter a valid single match condition."));
      if (!["AND", "OR", "NOT"].includes(value.type) && splitRule(match).length !== 1) throw Error(t("匹配值不能包含额外的规则或出口策略。", "The match value cannot contain additional rules or an outbound."));
      const options = value.options.trim();
      if (options && (options.split(",").some((option) => !["no-resolve", "src"].includes(option.trim().toLowerCase())) || !["IP-CIDR", "IP-CIDR6", "GEOIP", "IP-ASN"].includes(value.type))) throw Error(t("此规则不支持该附加选项。", "This rule does not support that option."));
      const next = { ...(original || { id: crypto.randomUUID(), enabled: true, order: 0 }), name: original?.name || value.type, rule: [value.type, match, ...(options ? [options] : [])].join(","), policy: checkPolicy(value.policy) };
      if (original) plan().directRules[index] = next; else appendPlanItem(plan(), "direct", next);
      closeModal(); changed(); render();
    });
  }

  function orderDialog() {
    const rows = effectiveOrder();
    modal(t("实际匹配顺序", "Effective match order"), `<p class="help">${t("上方优先匹配，兜底始终在最后。开关本身不改写独立规则的顺序；在此移动聚合块会将其成员一起移动。", "Top entries match first; the final rule stays last. Toggling aggregation preserves individual order; moving a block here moves all its members.")}</p><div class="routing-order-list">${rows.map((row, index) => `<div class="routing-order-row"><span>${index + 1}</span><div><strong>${esc(row.title)}</strong><p class="help">${row.entries[0].kind === "output" ? t(`${row.entries.length} 个规则集`, `${row.entries.length} rule sets`) : t("单条规则", "Direct rule")} → ${esc(row.policy)}</p></div><div>${btn(t("上移", "Up"), "clash-move", `data-index="${index}" data-direction="-1" ${index === 0 ? "disabled" : ""}`)}${btn(t("下移", "Down"), "clash-move", `data-index="${index}" data-direction="1" ${index === rows.length - 1 ? "disabled" : ""}`)}</div></div>`).join("")}</div>`, () => closeModal(), t("完成", "Done"));
    document.querySelector("#modal").classList.add("routing-order-dialog");
  }

  async function action(button) {
    const name = button.dataset.action;
    if (!name.startsWith("clash-")) return false;
    const index = button.dataset.index === undefined ? null : Number(button.dataset.index);
    if (name === "clash-add-direct" || name === "clash-edit-direct") editDirect(index);
    else if (name === "clash-order") orderDialog();
    else if (name === "clash-move") {
      const rows = effectiveOrder();
      const other = index + Number(button.dataset.direction);
      if (other < 0 || other >= rows.length) return true;
      [rows[index], rows[other]] = [rows[other], rows[index]];
      const entries = rows.flatMap((row) => row.entries);
      const active = new Set(entries.map((entry) => entry.item));
      entries.push(...orderedPlan(plan()).filter((entry) => !active.has(entry.item)));
      entries.forEach((entry, order) => { entry.item.order = order; });
      changed(); render(); orderDialog();
    } else if (name === "clash-delete") {
      modal(t("删除分流规则", "Delete routing rule"), `<p>${t("删除此条分流规则？复用的来源和策略组会保留。", "Delete this routing entry? Shared sources and policy groups remain available.")}</p>`, () => {
        plan()[button.dataset.kind === "output" ? "outputs" : "directRules"].splice(index, 1);
        closeModal(); changed(); render();
      }, t("删除", "Delete"));
    } else if (name === "clash-migrate") {
      if (pending) return true;
      pending = true; failures = []; render();
      const sent = JSON.stringify(state.config);
      try {
        const result = await api("/api/config/clash-routing", { method: "POST", body: sent });
        if (JSON.stringify(state.config) !== sent) throw Error(t("草稿已改变，请重新转换。", "The draft changed. Convert it again."));
        failures = result.issues;
        if (!failures.length) state.config.clients.clash = result.client;
      } finally { pending = false; changed(); render(); }
    } else if (name === "clash-status" || name === "clash-refresh") {
      if (pending) return true;
      if (JSON.stringify(state.config) !== state.saved) throw Error(t("请先保存配置。", "Save the configuration first."));
      const sent = signature();
      pending = true;
      button.disabled = true;
      button.textContent = t("处理中…", "Working…");
      try {
        const result = await api(`/api/rule-sets/${name === "clash-refresh" ? "refresh" : "status"}?target=clash`, name === "clash-refresh" ? { method: "POST" } : {});
        compilation = result.outputs; compileSignature = sent;
        failures = (result.outputFailures || []).map((item) => `${item.outputName}: ${item.reason}`);
      } catch (error) {
        compilation = null; compileSignature = sent; failures = [error.message];
        throw error;
      } finally {
        pending = false; render();
        const results = document.querySelector(".routing-results");
        if (results) results.open = true;
      }
    }
    return true;
  }

  function change(input) {
    const key = input.dataset.clashField;
    if (!key) return false;
    if (key === "aggregate") plan().aggregateByPolicy = input.checked;
    else if (key === "fallback") {
      const policy = checkPolicy(input.value);
      const finals = plan().directRules.filter((item) => isFinalRule(item.rule));
      if (finals[0]) {
        finals[0].policy = policy; finals[0].enabled = true; finals[0].rule = "MATCH";
        finals.slice(1).forEach((item) => { item.enabled = false; });
      } else appendPlanItem(plan(), "direct", { id: crypto.randomUUID(), name: "MATCH", rule: "MATCH", policy, enabled: true, order: 0 });
    } else {
      const item = plan()[input.dataset.kind === "output" ? "outputs" : "directRules"][Number(input.dataset.index)];
      item[key] = key === "enabled" ? input.checked : checkPolicy(input.value);
    }
    changed(); render();
    return true;
  }
  return { render: renderPage, action, change, policyField, checkPolicy };
}
