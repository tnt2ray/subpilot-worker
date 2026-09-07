/** Clash's routing form uses the existing rule plan as its only configuration state. */
export function createClashRoutingUi(ui) {
  const { state, t, esc, btn, iconButton, field, section, modal, closeModal, localField, readLocal, policyChoices, selectOptions, orderedPlan, isFinalRule, splitRule, appendPlanItem, changed, render, api } = ui;
  const client = () => state.config.clients.clash;
  const plan = () => client().ruleSets;
  let failures = [];
  let pending = false;
  const textRule = (item) => {
    const parts = splitRule(item.rule);
    if (isFinalRule(item.rule)) return parts[0];
    const options = parts.slice(2);
    if (options.length && !["no-resolve", "src", "extended-matching"].includes(options[0]?.toLowerCase())) options.shift();
    return [parts[0], parts[1], ...options].join(",");
  };
  const sourceUrls = (item) => item.sourceIds.map((id) => plan().sources.find((source) => source.id === id)?.url).filter(Boolean);
  const outputLabel = (name) => {
    const output = plan().outputs.find((item) => item.name === name);
    return output ? sourceUrls(output).join(" / ") || t("手动填写的规则", "Manually entered rules") : name;
  };
  const policyField = (value) => localField("policy", value, { label: t("出口策略", "Outbound policy"), options: policyChoices(value) });
  const checkPolicy = (value) => {
    if (!policyChoices().includes(value.trim())) throw Error(t("请选择已有且可用的出口策略。", "Choose an existing available outbound policy."));
    return value.trim();
  };

  function effectiveOrder() {
    const rows = [];
    for (const entry of orderedPlan(plan())) {
      if (!entry.item.enabled) continue;
      rows.push({ entries: [entry], policy: entry.item.policy, title: entry.kind === "output" ? outputLabel(entry.item.name) : textRule(entry.item) });
    }
    return rows;
  }

  function renderPage() {
    if (plan().mode !== "compiled") return section("", `<p>${t("将现有规则集载入表单，保留 behavior、interval、出口和顺序。每条规则可填写多个 URL，系统合并去重并生成 rule-providers。应用后仍需保存配置。", "Load existing rule sets into URL, behavior, interval and outbound fields, preserving their order. Multiple URLs in each row are merged and deduplicated into a generated provider. Save the draft to activate it.")}</p>${btn(t("使用规则集表单", "Use rule-set form"), "clash-migrate", pending ? "disabled" : "", "primary")}<div class="routing-errors">${failures.map((message) => `<p>${esc(message)}</p>`).join("")}</div>`);
    const ordered = effectiveOrder();
    const positions = new Map(ordered.flatMap((row, index) => row.entries.map((entry) => [entry.item, index + 1])));
    const available = new Set(policyChoices());
    const rows = orderedPlan(plan()).map(({ item, kind, index }) => {
      const output = kind === "output";
      const final = !output && isFinalRule(item.rule);
      const urls = output ? sourceUrls(item) : [];
      const content = output ? (item.provider ? `<p class="small muted">behavior: ${esc(item.provider.behavior)} · interval: ${esc(item.provider.interval)} s</p>` : "") + urls.map((url) => `<div class="routing-url">${esc(url)}</div>`).join("") + (item.inlineRules.length ? `<span class="small muted">${t(`手动填写 ${item.inlineRules.length} 条规则`, `${item.inlineRules.length} manually entered rules`)}</span>` : "") : `<code>${final ? "MATCH" : esc(textRule(item))}</code>`;
      const missingSources = output && (item.sourceIds.some((id) => !plan().sources.some((source) => source.id === id && source.enabled)) || (!item.sourceIds.length && !item.inlineRules.length));
      return `<tr><td class="routing-position">${positions.get(item) || "—"}</td><td class="routing-content"><span class="small muted">${output ? t("规则集", "Rule set") : t("单条规则", "Direct rule")}</span>${content}${output ? `<p class="small muted">DNS: ${esc(item.dnsServer || t("继承全局", "Inherit global"))}</p>` : ""}${missingSources ? `<p class="danger-text small">${t("来源缺失或已停用，请编辑此规则集。", "Source missing or disabled. Edit this rule set.")}</p>` : ""}</td><td><select data-clash-field="policy" data-kind="${kind}" data-index="${index}" aria-label="${t("出口策略", "Outbound policy")}">${selectOptions(policyChoices(item.policy), item.policy)}</select>${!available.has(item.policy) ? `<p class="danger-text small">${t("出口不存在或已停用", "Outbound missing or disabled")}</p>` : ""}</td><td><label class="routing-enabled"><input type="checkbox" data-clash-field="enabled" data-kind="${kind}" data-index="${index}" ${item.enabled ? "checked" : ""} ${final ? "disabled" : ""}>${t("启用", "Enabled")}</label></td><td class="actions">${iconButton("edit", output ? "edit-output" : "clash-edit-direct", `data-index="${index}"`, t("编辑", "Edit"))}${iconButton("trash", "clash-delete", `data-kind="${kind}" data-index="${index}" ${final ? "disabled" : ""}`, t("删除", "Delete"))}</td></tr>`;
    }).join("");
    return section("", `<div class="toolbar">${btn(t("添加规则集", "Add rule set"), "add-output", "", "primary")}${btn(t("添加单条规则", "Add direct rule"), "clash-add-direct")}${btn(t("调整匹配顺序", "Reorder matching"), "clash-order")}</div><div class="table-wrap"><table class="routing-table"><thead><tr><th>${t("匹配顺序", "Match order")}</th><th>${t("规则集地址 / 单条规则", "Rule-set URL / Direct rule")}</th><th>${t("出口策略", "Outbound policy")}</th><th>${t("状态", "Status")}</th><th>${t("操作", "Actions")}</th></tr></thead><tbody>${rows || `<tr><td colspan="5" class="empty">${t("添加规则集地址并选择策略，或添加一条规则。", "Add a rule-set URL and choose a policy, or add a direct rule.")}</td></tr>`}</tbody></table></div>`, "");
  }

  function editDirect(index) {
    const original = index === null ? null : plan().directRules[index];
    if (original && isFinalRule(original.rule)) {
      modal(t("编辑 MATCH 兜底规则", "Edit MATCH final rule"), `<p><code>MATCH</code></p>` + policyField(original.policy), () => {
        original.policy = checkPolicy(readLocal({ policy: original.policy }).policy);
        closeModal(); changed(); render();
      });
      return;
    }
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
      const next = { ...(original || { id: crypto.randomUUID(), enabled: true, order: 0 }), rule: [value.type, match, ...(options ? [options] : [])].join(","), policy: checkPolicy(value.policy) };
      if (original) plan().directRules[index] = next; else appendPlanItem(plan(), "direct", next);
      closeModal(); changed(); render();
    });
  }

  function orderDialog() {
    const rows = effectiveOrder();
    modal(t("实际匹配顺序", "Effective match order"), `<p class="help">${t("上方优先匹配，兜底始终在最后。每个条目独立排序，相同出口的条目也不会合并。", "Top entries match first; the final rule stays last. Each entry has its own position, even when entries share an outbound.")}</p><div class="routing-order-list">${rows.map((row, index) => `<div class="routing-order-row"><span>${index + 1}</span><div><strong>${esc(row.title)}</strong><p class="help">${row.entries[0].kind === "output" ? t(`${row.entries.length} 个规则集`, `${row.entries.length} rule sets`) : t("单条规则", "Direct rule")} → ${esc(row.policy)}</p></div><div>${btn(t("上移", "Up"), "clash-move", `data-index="${index}" data-direction="-1" ${isFinalRule(row.entries[0].item.rule) || index === 0 ? "disabled" : ""}`)}${btn(t("下移", "Down"), "clash-move", `data-index="${index}" data-direction="1" ${isFinalRule(row.entries[0].item.rule) || index === rows.length - 1 || isFinalRule(rows[index + 1]?.entries[0].item.rule) ? "disabled" : ""}`)}</div></div>`).join("")}</div>`, () => closeModal(), t("完成", "Done"));
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
      if (other < 0 || other >= rows.length || isFinalRule(rows[index].entries[0].item.rule) || isFinalRule(rows[other].entries[0].item.rule)) return true;
      [rows[index], rows[other]] = [rows[other], rows[index]];
      const entries = rows.flatMap((row) => row.entries);
      const active = new Set(entries.map((entry) => entry.item));
      entries.push(...orderedPlan(plan()).filter((entry) => !active.has(entry.item)));
      entries.forEach((entry, order) => { entry.item.order = order; });
      changed(); render(); orderDialog();
    } else if (name === "clash-delete") {
      if (button.dataset.kind === "direct" && isFinalRule(plan().directRules[index]?.rule)) return;
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
    }
    return true;
  }

  function change(input) {
    const key = input.dataset.clashField;
    if (!key) return false;
    const item = plan()[input.dataset.kind === "output" ? "outputs" : "directRules"][Number(input.dataset.index)];
    if (input.dataset.kind === "direct" && isFinalRule(item.rule) && key === "enabled") { input.checked = item.enabled; return true; }
    item[key] = key === "enabled" ? input.checked : checkPolicy(input.value);
    changed(); render();
    return true;
  }
  return { render: renderPage, action, change, policyField, checkPolicy };
}
