import { splitPolicyGroupSpec, parseGroupOption, validatePolicyPriority } from "./app-policy-group-spec.js";
import { getPath, setPath, splitRule } from "./app-model.js";
import { createSingboxGroupForm } from "./singbox-ui.js";

/** Editors update the shared draft through the same application callbacks. */
export function createEditorsUi(context) {
  const {
    state, $, t, esc, label, collection, currentClient, localField, readLocal,
    modal, closeModal, changed, render, policyChoices, validateNativeShape, isObject,
    isFinalRule, selectOptions, surgeOptionChoices, compiledFinalOptions,
    SURGE_RULE_TYPES, SURGE_RULE_SET_TYPES, SURGE_DIRECT_RULE_TYPES,
    nextPlanOrder, appendPlanItem, outputSourceUrls, sourcesForUrls, pruneUnusedRuleSources,
    clashPolicyField, checkClashPolicy
  } = context;

  function updateChainFilterVisibility() {
    const toggle = $('#modal-body [data-local="chainExit"]');
    const row = $('#modal-body [data-local="chainFilter"]')?.closest(".form-row");
    if (row) row.hidden = !toggle?.checked;
  }
  function editEntity(kind, index) {
    const items = collection(kind);
    const original = index === null ? kind === "nodes" ? { id: crypto.randomUUID(), config: "", chainFilter: [], enabled: true, chainExit: false, includeInGroups: true } : { id: crypto.randomUUID(), name: "", url: "", fetchUserAgent: state.config.settings.userAgentSurge, enabled: true } : items[index];
    const entries = Object.entries(original).filter(([key]) => !["id", "urlEncrypted"].includes(key));
    const fields = kind === "nodes" ? entries.filter(([key]) => key !== "chainFilter").flatMap((entry) => entry[0] === "chainExit" ? [entry, ["chainFilter", original.chainFilter || []]] : [entry]) : entries;
    const body = fields.map(([key, value]) => localField(key, value, key === "chainFilter" ? {
      label: t("前置节点筛选", "Upstream node selection"),
      help: t("每行一个关键词。节点名称或标签包含任一关键词即选中，不区分大小写，不支持正则。仅为命中的非出口节点生成链式节点，留空不生成。链路：本机 → 命中节点 → 当前出口节点 → 目标网站。", "One keyword per line. Select nodes whose name or labels contain any keyword, ignoring case; regular expressions are not supported. Only matching non-exit nodes generate chained nodes; leave empty to generate none. Path: device → matching node → current exit node → destination.")
    } : key === "config" ? { multiline: true } : {})).join("");
    modal(t("编辑共享资源", "Edit shared resource"), body, () => {
      const updated = readLocal(original);
      if (kind !== "nodes" && !updated.name.trim()) throw Error(t("请填写名称", "Enter a name"));
      if (index === null) items.push(updated);
      else items[index] = updated;
      closeModal();
      changed();
      render();
    });
    if (kind === "nodes") updateChainFilterVisibility();
  }
  function editGroup(name) {
    if (state.client === "singbox") { editSingboxGroup(name); return; }
    const original = name ? { name, spec: currentClient().groups[name], enabled: !currentClient().disabledGroups.includes(name) } : { name: "", spec: "select, {all}", enabled: true };
    const surge = state.client === "surge";
    const clash = state.client === "clash";
    if (clash) {
      const parts = splitPolicyGroupSpec(original.spec);
      original.defaultSelected = parts.slice(1).map(parseGroupOption).find((option) => option?.key === "default-selected")?.value || "";
      original.spec = parts.filter((part, index) => !index || parseGroupOption(part)?.key !== "default-selected").join(", ");
    }
    if (surge) {
      const parts = splitPolicyGroupSpec(original.spec);
      const options = parts.slice(1).map(parseGroupOption).filter(Boolean);
      original.category = options.find((option) => option.key.toLowerCase() === "category")?.value || "";
      const priority = options.find((option) => option.key.toLowerCase() === "policy-priority")?.value || "";
      original.priority = priority.startsWith('"') && priority.endsWith('"') ? priority.slice(1, -1).split(";").join("\n") : priority;
      original.spec = parts.filter((part, index) => !index || !["category", "policy-priority"].includes(parseGroupOption(part)?.key.toLowerCase())).join(", ");
    }
    const surgeOptions = surge ? localField("category", original.category, { label: t("分类（可选）", "Category (optional)") })
      + localField("priority", original.priority, { label: t("Smart 策略优先级（每行 regex:factor）", "Smart policy priority (one regex:factor per line)"), multiline: true, rows: 3 })
      + `<p class="help">${t("例如 Premium:0.9。权重必须大于 0；小于 1 更优先，大于 1 降低优先级，首个匹配项生效。仅用于 smart 或输出为 smart 的 url-test。分类与 HTTPS 测速需要支持这些参数的 Surge Beta。", "Example: Premium:0.9. Factors must be positive; below 1 increases preference, above 1 reduces it. The first match wins. Applies to smart or url-test emitted as smart. Category and HTTPS testing require a Surge Beta with support for these features.")}</p>` : "";
    const clashOptions = clash ? localField("defaultSelected", original.defaultSelected, { label: t("默认成员（仅 select，可选）", "Default member (select only, optional)") }) + `<p class="help">${t("填写输出中的完整成员名称；已保存的客户端选择可能覆盖此默认值。", "Enter the complete emitted member name; a saved client selection may override this default.")}</p>` : "";
    modal(t("编辑策略组", "Edit policy group"), localField("name", original.name, { readonly: name === "Proxy" }) + localField("spec", original.spec, { label: t("组配置", "Group definition"), multiline: true }) + surgeOptions + clashOptions + localField("enabled", original.enabled) + `<p class="help">${state.client === "surge" ? t("可使用 smart；兼容将 url-test 输出为 smart。smart 成员必须是代理节点，hidden=true 可隐藏组。", "Use smart; url-test is also emitted as smart for compatibility. Smart requires proxy-node members; hidden=true hides a group.") : state.client === "clash" ? t("支持 select、url-test、fallback 和 load-balance；hidden=true 的显示效果需要客户端或面板支持。", "Supports select, url-test, fallback and load-balance. hidden=true requires client or dashboard support.") : t("支持 select 和 url-test，分别输出为 selector 和 urltest；不支持 hidden。", "Supports select and url-test, emitted as selector and urltest. hidden is unsupported.")} ${t("修改名称不会自动重写规则引用。", "Renaming does not rewrite rule references.")}</p>`, () => {
      const value = readLocal(original);
      if (clash && value.defaultSelected.trim()) {
        const parts = splitPolicyGroupSpec(value.spec);
        const selected = value.defaultSelected.trim();
        if (parts[0]?.toLowerCase() !== "select") throw Error(t("默认成员仅适用于 select", "Default member only applies to select"));
        if (/[,={}\r\n\u0000-\u001f\u007f]/.test(selected)) throw Error(t("默认成员名称无效", "Invalid default member name"));
        if (parts.slice(1).some((part) => parseGroupOption(part)?.key === "default-selected")) throw Error(t("请勿重复填写默认成员", "Do not specify the default member twice"));
        parts.push(`default-selected=${selected}`);
        value.spec = parts.join(", ");
      }
      if (surge) {
        const parts = splitPolicyGroupSpec(value.spec);
        const category = value.category.trim();
        const priority = value.priority.split("\n").map((line) => line.trim()).filter(Boolean).join(";");
        if (category && /[,{}";#\r\n\u0000-\u001f\u007f]/.test(category)) throw Error(t("分类包含无效字符", "Category contains invalid characters"));
        const inlineKeys = parts.slice(1).map((part) => parseGroupOption(part)?.key.toLowerCase());
        if (category && inlineKeys.includes("category") || priority && inlineKeys.includes("policy-priority")) throw Error(t("请勿在组配置和独立字段中重复填写分类或优先级", "Do not duplicate category or priority in the group definition and separate fields"));
        if (priority) {
          if (!["smart", "url-test"].includes(parts[0]?.toLowerCase())) throw Error(t("策略优先级仅适用于 Smart", "Policy priority only applies to Smart"));
          const error = validatePolicyPriority(`"${priority}"`);
          if (error) throw Error(t(error, "Use valid regex:factor entries with finite positive factors"));
          parts.push(`policy-priority="${priority}"`);
        }
        if (category) parts.push(`category=${category}`);
        value.spec = parts.join(", ");
      }
      value.name = value.name.trim();
      if (!value.name || /[\r\n,=]/.test(value.name)) throw Error(t("策略组名称无效", "Invalid group name"));
      if (name === "Proxy" && (value.name !== "Proxy" || !value.enabled)) throw Error(t("Proxy 必须保留并启用", "Proxy must remain enabled"));
      if (value.name !== name && value.name in currentClient().groups) throw Error(t("策略组名称已存在", "Group name already exists"));
      if (name) {
        delete currentClient().groups[name];
        currentClient().disabledGroups = currentClient().disabledGroups.filter((item) => item !== name);
      }
      currentClient().groups[value.name] = value.spec;
      if (!value.enabled) currentClient().disabledGroups.push(value.name);
      closeModal();
      changed();
      render();
    });
  }
  function editSingboxGroup(name) {
    const client = currentClient();
    const original = { name: name || "", enabled: !client.disabledGroups.includes(name) };
    let form;
    modal(t("编辑 sing-box 策略组", "Edit sing-box group"), localField("name", original.name, { readonly: name === "Proxy" }) + localField("enabled", original.enabled) + '<div id="singbox-group-form" class="sb-form"></div>', () => {
      const value = readLocal(original), spec = form.read();
      value.name = value.name.trim();
      if (!value.name || /[\r\n,=]/.test(value.name)) throw Error(t("策略组名称无效", "Invalid group name"));
      if (name === "Proxy" && (value.name !== "Proxy" || !value.enabled)) throw Error(t("Proxy 必须保留并启用", "Proxy must remain enabled"));
      if (value.name !== name && (Object.hasOwn(client.groups, value.name) || [...client.outbounds || [], ...client.endpoints || []].some((item) => item.tag === value.name) || ["DIRECT", "REJECT", "REJECT-DROP"].includes(value.name.toUpperCase()))) throw Error(t("名称与已有策略或节点冲突", "Name conflicts with an existing policy or node"));
      if (name) { delete client.groups[name]; client.disabledGroups = client.disabledGroups.filter((item) => item !== name); }
      client.groups[value.name] = spec;
      if (!value.enabled) client.disabledGroups.push(value.name);
      closeModal(); changed(); render();
    });
    form = createSingboxGroupForm($("#singbox-group-form"), name ? client.groups[name] : "select, {all}", policyChoices().filter((choice) => choice !== name), { t, esc });
  }
  function editJson(path, lines = false) {
    const value = getPath(state.config, path);
    modal(label(path.split(".").at(-1)), `<textarea id="json-editor" class="code code-editor" rows="20" spellcheck="false">${esc(lines ? value.join("\n") : typeof value === "string" ? value : JSON.stringify(value, null, 2))}</textarea><p class="help">${t("应用更改后，请点击页面底部的「保存配置」。", "After applying changes, click Save configuration at the bottom of the page.")}</p>`, () => {
      const text = $("#json-editor").value;
      const next = lines ? text.split("\n").map((line) => line.trim()).filter(Boolean) : typeof value === "string" ? text : JSON.parse(text);
      if (Array.isArray(value) !== Array.isArray(next) || typeof value !== typeof next) throw Error(t("数据类型必须保持一致", "The value must retain its data type"));
      if (path.startsWith("clients.singbox")) validateNativeShape(next, path);
      if (isObject(value) && !isObject(next)) throw Error(t("需要 JSON 对象", "A JSON object is required"));
      if (path === "clients.surge.rules") validateSurgeFinal(next);
      setPath(state.config, path, next);
      state.invalid.delete(path);
      closeModal();
      changed();
      render();
    });
  }
  function validateSurgeFinal(rules) {
    const effective = rules.filter((line) => line.trim() && !line.trim().startsWith("#"));
    if (effective.filter(isFinalRule).length !== 1 || splitRule(effective.at(-1) || "")[0].toUpperCase() !== "FINAL") throw Error(t("必须保留唯一的 FINAL 兜底规则，并放在最后。", "Keep exactly one FINAL rule at the end."));
  }
  function updateSurgeRuleForm() {
    const type = $('#modal-body [data-local="type"]');
    if (!type || !$('#modal-body [data-surge-options]')) return;
    const option = $('#modal-body [data-local="options"]');
    const previous = option.value;
    const choices = surgeOptionChoices(type.value);
    option.innerHTML = selectOptions(choices, choices.includes(previous) ? previous : "");
    const value = $('#modal-body [data-local="value"]');
    value.disabled = type.value === "FINAL";
  }
  function editSurgeRule(path, index, compiled = false, selectedType) {
    const plan = currentClient().ruleSets;
    const rules = compiled ? plan.directRules : getPath(state.config, path);
    const original = index === null ? null : rules[index];
    const parts = splitRule(compiled ? original?.rule || "DOMAIN-SUFFIX,,Proxy" : original || "DOMAIN-SUFFIX,,Proxy");
    const type = parts[0].toUpperCase() === "MATCH" && compiled ? "FINAL" : parts[0].toUpperCase();
    const final = type === "FINAL";
    const optionStart = final ? 2 : compiled && ["no-resolve", "src", "extended-matching"].includes(parts[2]?.toLowerCase()) ? 2 : 3;
    const options = final && compiled ? compiledFinalOptions(parts) : parts.slice(optionStart);
    const form = { type: selectedType || type, value: final ? "" : parts[1] || "", policy: compiled ? original?.policy || "Proxy" : parts[final ? 1 : 2] || "Proxy", options: options.join(","), ...(compiled ? { enabled: original?.enabled ?? true } : {}) };
    if (selectedType && selectedType !== type && !surgeOptionChoices(selectedType).includes(form.options)) form.options = "";
    const hasFinal = rules.some((rule, i) => i !== index && isFinalRule(compiled ? rule.rule : rule));
    const legacyRuleSet = compiled && original && SURGE_RULE_SET_TYPES.includes(type);
    const direct = compiled && !legacyRuleSet;
    const types = direct ? SURGE_DIRECT_RULE_TYPES : legacyRuleSet ? SURGE_RULE_SET_TYPES : SURGE_RULE_TYPES;
    const choices = types.filter((entry) => entry !== "FINAL" || !hasFinal);
    const title = direct ? t("编辑 Surge 单条规则", "Edit Surge direct rule") : legacyRuleSet ? t("编辑 Surge 规则集引用", "Edit Surge rule-set reference") : t("编辑 Surge 规则", "Edit Surge rule");
    const help = direct ? t("一条规则填写一个匹配值。逻辑规则可填写括号表达式。FINAL 在末尾匹配剩余请求。", "Use one match value per rule or a parenthesized logical expression. FINAL matches remaining requests at the end.") : legacyRuleSet ? t("此条目是已有的规则集引用。新增规则集请使用“添加规则集”。", "This entry is an existing rule-set reference. Use Add rule set for new rule sets.") : t("一条规则填写一个匹配值；RULE-SET / DOMAIN-SET 填写地址。逻辑规则可填写括号表达式。FINAL 在末尾匹配剩余请求。", "Use one match value per rule, a URL for RULE-SET / DOMAIN-SET, or a parenthesized logical expression. FINAL matches remaining requests at the end.");
    modal(title, localField("type", form.type, { label: t("匹配类型", "Match type"), options: final ? ["FINAL"] : [...new Set([...choices, form.type])] }) + localField("value", form.value, { label: direct ? t("匹配值", "Match value") : legacyRuleSet ? t("规则集地址", "Rule-set URL") : t("匹配值 / 规则集地址", "Match value / Rule-set URL"), multiline: true }) + localField("policy", form.policy, { options: policyChoices(form.policy) }) + `<div data-surge-options>${localField("options", form.options, { label: t("附加选项", "Options"), options: [...new Set([...surgeOptionChoices(form.type), form.options])] })}</div>` + (compiled ? localField("enabled", form.enabled, { disabled: final }) : "") + `<p class="help">${help}</p>`, () => {
      const value = readLocal(form);
      if (final && (value.type !== "FINAL" || compiled && !value.enabled)) throw Error(t("兜底规则必须保留并启用", "The final rule must remain enabled"));
      if (direct && SURGE_RULE_SET_TYPES.includes(value.type)) throw Error(t("规则集请使用“添加规则集”。", "Use Add rule set for rule sets."));
      if (!value.value.trim() && value.type !== "FINAL") throw Error(t("请填写匹配值", "Enter a match value"));
      if (/[\r\n]/.test(value.value.trim())) throw Error(t("每条规则只能填写一个匹配值，请分别添加多条规则。", "Use one match value per rule; add separate rules for multiple values."));
      if (value.type === "FINAL" && hasFinal) throw Error(t("已有 FINAL 兜底规则。", "A FINAL rule already exists."));
      const line = [value.type, ...(value.type === "FINAL" ? [] : [value.value.trim()]), value.policy, ...value.options.split(",").filter(Boolean)].join(",");
      if (compiled) {
        const next = { ...(original || { id: crypto.randomUUID(), order: nextPlanOrder(plan) }), enabled: value.enabled, policy: value.policy, rule: line };
        if (index === null) appendPlanItem(plan, "direct", next); else rules[index] = next;
      } else {
        const next = [...rules];
        if (index === null) {
          const finalIndex = next.findIndex(isFinalRule);
          next.splice(value.type !== "FINAL" && finalIndex >= 0 ? finalIndex : next.length, 0, line);
        } else next[index] = line;
        validateSurgeFinal(next);
        setPath(state.config, path, next);
      }
      closeModal(); changed(); render();
    });
    $('#modal-body [data-local="value"]').disabled = form.type === "FINAL";
    if (final) $('#modal-body [data-local="type"]').disabled = true;
  }
  function editSurgeRuleText(path, index) {
    const rules = getPath(state.config, path);
    const original = rules[index];
    modal(t("编辑原生规则", "Edit native rule"), `<textarea id="rule-native" class="code code-editor" rows="12">${esc(original)}</textarea>`, () => {
      const value = $("#rule-native").value;
      if (isFinalRule(original) && !isFinalRule(value)) throw Error(t("不能修改兜底规则类型", "Cannot change the final rule type"));
      validateSurgeFinal(rules.map((rule, i) => i === index ? value : rule));
      rules[index] = value;
      closeModal(); changed(); render();
    });
  }
  function ruleSetDownloadName(plan, urls) {
    const first = urls.split("\n").map((url) => url.trim()).find(Boolean);
    let base = "rules";
    if (first) {
      const url = new URL(first);
      const filename = url.pathname.split("/").filter(Boolean).at(-1) || url.hostname;
      let decoded = filename;
      try { decoded = decodeURIComponent(filename); } catch { /* Keep the encoded filename. */ }
      base = decoded.replace(/\.(?:ya?ml|list|txt|json|srs|mrs)$/i, "").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "rules";
    }
    const names = new Set(plan.outputs.map((output) => output.name));
    let name = base;
    for (let suffix = 2; [name, `${name}-domain`, `${name}-ipcidr`, `${name}-dns`].some((value) => names.has(value)) || names.has(name.replace(/-(domain|ipcidr|dns)$/, "")); suffix += 1) name = `${base}-${suffix}`;
    return name;
  }
  function editOutput(index) {
    const plan = currentClient().ruleSets;
    const surge = state.client === "surge";
    const singbox = state.client === "singbox";
    const clash = state.client === "clash";
    const original = index === null ? { name: "", enabled: true, policy: "Proxy", sourceIds: [], inlineRules: [], order: nextPlanOrder(plan), surgeOptions: [] } : plan.outputs[index];
    const initialUrls = outputSourceUrls(original);
    const displayedUrls = state.invalid.get(`plan.${state.client}.output.${index}.sourceUrls`) ?? initialUrls;
    const domainSources = original.sourceIds.length > 0 && original.sourceIds.every((id) => ["surge-domain-set", "plain-domain"].includes(plan.sources.find((source) => source.id === id)?.format));
    const sourceFormats = [...new Set(original.sourceIds.map((id) => plan.sources.find((source) => source.id === id)?.format || "auto"))];
    const form = { ...original, dnsServer: original.dnsServer || "", sourceUrls: initialUrls, sourceFormat: sourceFormats.length > 1 ? "existing" : sourceFormats[0] || "auto", surgeType: original.surgeType || (domainSources ? "DOMAIN-SET" : "RULE-SET"), surgeOptions: original.surgeOptions.join(","), behavior: original.provider?.behavior || (index === null ? "classical" : "auto"), interval: original.provider?.interval ?? 86400 };
    const formats = [["auto", t("自动识别", "Automatic")], ["sing-box-binary", t("sing-box SRS（独立直连）", "sing-box SRS (direct download)")], ["surge-rule-set", "Surge RULE-SET"], ["surge-domain-set", "Surge DOMAIN-SET"], ["clash-yaml", "Clash YAML"], ["plain-domain", t("域名文本", "Domain text")], ["plain-ipcidr", t("IP-CIDR 文本", "IP-CIDR text")], ["plain-classical", t("规则文本（classical）", "Rule text (classical)")]].filter(([format]) => !clash || ["auto", "clash-yaml", "plain-domain", "plain-ipcidr", "plain-classical"].includes(format));
    if (form.sourceFormat === "existing") formats.unshift(["existing", t("保留各地址已有格式", "Keep each URL’s existing format")]);
    const simple = clash || singbox;
    const sourceSettings = singbox || clash ? `<div class="form-row"><label for="output-source-format">${t("来源格式", "Source format")}</label><select id="output-source-format" data-local="sourceFormat">${formats.map(([value, label]) => `<option value="${esc(value)}" ${value === form.sourceFormat ? "selected" : ""}>${esc(label)}</option>`).join("")}</select></div><p class="help">${singbox ? t("自动识别时，.srs 地址各自独立输出，由 sing-box 下载，不参与合并或转换；其他文本来源合并去重后转换。无 .srs 后缀的二进制地址请选择 SRS 格式。明确选择的格式适用于本行所有地址。", "Automatic mode outputs each .srs URL independently for sing-box to download; text sources are merged, deduplicated and converted. Choose SRS for binary URLs without a .srs extension. An explicit format applies to all URLs in this row.") : t("自动识别按下载内容判断格式并生成规则集，不依赖 URL 后缀。明确指定格式后，兼容的单个来源可由 Clash 直接下载；文本格式应与 behavior 一致。所选格式用于本行所有地址。", "Automatic mode detects downloaded content and generates a rule set without relying on URL extensions. An explicit format allows a single compatible source to be downloaded directly by Clash; text format must match behavior. The selected format applies to all URLs in this row.")}</p>` : "";
    const providerSettings = clash ? localField("behavior", form.behavior, { label: "behavior", options: [...(form.behavior === "auto" ? ["auto"] : []), "domain", "ipcidr", "classical"] }) + localField("interval", form.interval, { label: t("interval（秒）", "interval (seconds)") }) + `<p class="help">${t("多个 URL 由系统合并去重。interval 为客户端下载间隔；自动识别来源的更新由系统规则缓存刷新控制。", "Multiple URLs are merged and deduplicated. interval controls client downloads; automatic sources update through system rule-cache refreshes.")}</p>` : "";
    const dnsTags = singbox ? (currentClient().dns.servers || []).map((server) => server.tag).filter(Boolean) : [];
    const dnsSettings = localField("dnsServer", form.dnsServer, {
      label: t("DNS 解析服务器（留空继承全局）", "DNS resolver (empty inherits global settings)"),
      ...(singbox ? { options: [...new Set(["", ...dnsTags, form.dnsServer])] } : { placeholder: "223.5.5.5 / https://dns.example.com/dns-query" })
    }) + `<p class="help">${singbox ? t("在 DNS 页添加解析服务器后可在此选择。文本来源仅提取独立域名规则；SRS 直接引用原规则集，请使用适合 DNS 匹配的 SRS。按本页顺序匹配，优先于 DNS 页规则。", "Add resolvers on the DNS tab, then select one here. Text sources contribute standalone domain rules; SRS sets are referenced as provided and must be suitable for DNS matching. Entries match in routing order, before DNS-tab rules.") : surge ? t("仅作用于规则集内的域名；已有 Host 映射优先。需要 Surge Mac 5.10+ / iOS 5.14.3+。代理请求的远端解析不受此设置保证。", "Applies to domains in the set; existing Host mappings take priority. Requires Surge Mac 5.10+ / iOS 5.14.3+. Remote resolution by a proxy is not guaranteed to use this resolver.") : t("Clash 指 Clash Verge 的 Mihomo 内核。需要启用 DNS；只对域名匹配生效，纯 IP 规则集不可指定。", "Clash means Clash Verge with the Mihomo core. DNS must be enabled; only domain matches apply, and IP-only sets cannot specify a resolver.")}</p>`;
    const advancedSettings = simple ? `<details><summary>${t("规则集其他设置", "Other rule-set settings")}</summary>${localField("enabled", form.enabled, { label: t("启用此规则集", "Enable this rule set") })}${clash ? localField("surgeOptions", form.surgeOptions, { label: t("解析 IP 前不查询 DNS", "Do not resolve IP matches"), options: ["", "no-resolve"] }) : ""}</details>` : "";
    const intro = surge ? t("选择规则集类型并填写下载地址。多个地址合并去重，共用一个出口策略。RULE-SET 包含规则类型和匹配值；DOMAIN-SET 每行填写域名，以点开头表示包含子域名。", "Choose the set type and enter download URLs. Multiple URLs are merged and deduplicated under one outbound policy. RULE-SET contains typed rules; DOMAIN-SET lists domains, with a leading dot to include subdomains.") : singbox ? t("填写规则下载地址并选择出口策略。SRS 各自独立输出；文本来源合并去重，使用同一个出口策略。", "Enter rule download URLs and choose an outbound policy. Each SRS is output independently; text sources are merged and deduplicated under the same policy.") : t("填写规则下载地址并选择出口策略。多个地址的规则合并去重，使用同一个出口策略。", "Enter rule download URLs and choose an outbound policy. Rules from multiple URLs are merged and deduplicated under one outbound policy.");
    const surgeSettings = surge ? localField("surgeType", form.surgeType, { label: t("规则集类型", "Rule-set type"), options: SURGE_RULE_SET_TYPES }) : "";
    const legacyInline = form.inlineRules.length ? `<p class="help">${t(`保留已有的 ${form.inlineRules.length} 条手填规则。新增独立规则请使用“添加单条规则”。`, `The ${form.inlineRules.length} existing manual rules are retained. Use Add direct rule for new individual rules.`)}</p>` : "";
    const title = surge ? t("编辑 Surge 规则集", "Edit Surge rule set") : clash ? t("编辑 Clash 规则集", "Edit Clash rule set") : t("编辑 sing-box 规则集", "Edit sing-box rule set");
    modal(title, `<p class="help">${intro}</p>` + surgeSettings + sourceSettings + localField("sourceUrls", displayedUrls, { label: t("规则下载地址（每行一个）", "Rule download URLs (one per line)"), multiline: true, rows: 5 }) + providerSettings + legacyInline + dnsSettings + (clash ? clashPolicyField(form.policy) : localField("policy", form.policy, { label: t("出口策略（作用于全部规则）", "Outbound policy (for all rules)"), options: policyChoices(form.policy) })) + (surge ? localField("surgeOptions", form.surgeOptions, { options: [...new Set([...surgeOptionChoices(form.surgeType), form.surgeOptions])] }) : "") + (simple ? "" : localField("enabled", form.enabled, { label: t("启用此规则集", "Enable this rule set") })) + advancedSettings, () => {
      const value = readLocal(form);
      value.dnsServer = value.dnsServer.trim();
      if (singbox && value.dnsServer && !dnsTags.includes(value.dnsServer)) throw Error(t("DNS 服务器不存在，请重新选择。", "DNS server is missing; choose another server."));
      if (clash && value.dnsServer && (value.behavior === "ipcidr" || !currentClient().dnsEnabled)) throw Error(t("指定 DNS 需要启用 Clash DNS，且 behavior 不能为 ipcidr。", "Enable Clash DNS and use domain or classical behavior to assign a resolver."));
      if (clash) value.policy = checkClashPolicy(value.policy);
      if (!value.sourceUrls.trim() && !value.inlineRules.length) throw Error(t("请填写规则下载地址。", "Enter a rule download URL."));
      const linked = value.sourceUrls === initialUrls ? null : sourcesForUrls(plan, value.sourceUrls, original.sourceIds);
      const next = { ...original, dnsServer: value.dnsServer, name: original.name || ruleSetDownloadName(plan, value.sourceUrls), policy: value.policy, enabled: value.enabled, inlineRules: value.inlineRules, surgeOptions: value.surgeOptions.split(",").filter(Boolean), sourceIds: linked ? linked.ids : original.sourceIds };
      if (surge) {
        if (!SURGE_RULE_SET_TYPES.includes(value.surgeType)) throw Error(t("请选择 RULE-SET 或 DOMAIN-SET。", "Choose RULE-SET or DOMAIN-SET."));
        if (!surgeOptionChoices(value.surgeType).includes(value.surgeOptions)) throw Error(t("附加选项与规则集类型不兼容，请重新选择。", "Select options compatible with the rule-set type."));
        next.surgeType = value.surgeType;
      }
      if (clash) {
        if (!Number.isSafeInteger(value.interval) || value.interval <= 0) throw Error(t("interval 必须为正整数秒数。", "interval must be a positive integer in seconds."));
        if (value.behavior === "auto") {
          if (original.provider || value.interval !== 86400) throw Error(t("请先选择 domain、ipcidr 或 classical。", "Choose domain, ipcidr or classical first."));
        } else {
          if (!["domain", "ipcidr", "classical"].includes(value.behavior)) throw Error(t("behavior 无效。", "Invalid behavior."));
          next.provider = { behavior: value.behavior, interval: value.interval };
        }
      }
      const sources = linked ? linked.sources : structuredClone(plan.sources);
      if (singbox || clash) {
        if (!formats.some(([format]) => format === value.sourceFormat)) throw Error(t("来源格式无效", "Invalid source format"));
        if (value.sourceFormat !== "existing") {
          const sharedIds = new Set(plan.outputs.filter((_, i) => i !== index).flatMap((output) => output.sourceIds));
          next.sourceIds = next.sourceIds.map((id) => {
            const source = sources.find((item) => item.id === id);
            if (!source || source.format === value.sourceFormat) return id;
            if (!sharedIds.has(id)) { source.format = value.sourceFormat; return id; }
            const copy = { ...source, id: crypto.randomUUID(), format: value.sourceFormat, order: Math.max(-1, ...sources.map((item) => item.order)) + 1 };
            sources.push(copy);
            return copy.id;
          });
        }
      }
      plan.sources = sources;
      state.invalid.delete(`plan.${state.client}.output.${index}.sourceUrls`);
      if (index === null) appendPlanItem(plan, "output", next); else plan.outputs[index] = next;
      pruneUnusedRuleSources(plan);
      closeModal(); changed(); render();
    });
  }
  function confirmDelete(message, operation) {
    modal(t("确认删除", "Confirm deletion"), `<p>${esc(message)}</p>`, () => {
      operation();
      closeModal();
      changed();
      render();
    }, t("删除", "Delete"));
  }

  function editDirect(index) {
    if (state.client === "surge") editSurgeRule(null, index, true);
    else if (state.client === "singbox") editSingboxDirect(index);
  }
  function editSingboxDirect(index) {
    const plan = currentClient().ruleSets, original = index === null ? null : plan.directRules[index];
    const parts = splitRule(original?.rule || "DOMAIN-SUFFIX,example.com");
    const types = ["DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "DOMAIN-REGEX", "IP-CIDR", "IP-CIDR6", "SRC-IP", "SRC-IP-CIDR", "PROCESS-NAME", "PROCESS-PATH", "PROCESS-PATH-REGEX", "DST-PORT", "DEST-PORT", "SRC-PORT", "NETWORK", "PROTOCOL", "FINAL", "MATCH"];
    const form = { matchType: parts[0].toUpperCase(), matchValue: ["FINAL", "MATCH"].includes(parts[0].toUpperCase()) ? "" : parts[1] || "", policy: original?.policy || "Proxy", enabled: original?.enabled ?? true };
    modal(t("编辑 sing-box 单条规则", "Edit sing-box direct rule"), localField("matchType", form.matchType, { label: t("匹配类型", "Match type"), options: isFinalRule(original?.rule) ? [form.matchType] : types.filter((type) => !isFinalRule(type) || !plan.directRules.some((item) => isFinalRule(item.rule))) }) + localField("matchValue", form.matchValue, { label: t("匹配值（FINAL / MATCH 留空）", "Match value (empty for FINAL / MATCH)") }) + localField("policy", form.policy, { options: policyChoices(form.policy) }) + localField("enabled", form.enabled, { disabled: isFinalRule(original?.rule) }) + `<p class="help">${t("每条编排规则填写一个匹配值；复杂逻辑和原生动作可在上方“路由与规则集”表单中配置。", "Use one match value per compiled rule. Configure complex logic and native actions in the Routing & rule sets form above.")}</p>`, () => {
      const value = readLocal(form), final = ["FINAL", "MATCH"].includes(value.matchType);
      if (isFinalRule(original?.rule) && (!final || !value.enabled)) throw Error(t("兜底规则必须保留并启用", "The final rule must remain enabled"));
      if (final && plan.directRules.some((item) => item !== original && isFinalRule(item.rule))) throw Error(t("已有兜底规则", "A final rule already exists"));
      if (!types.includes(value.matchType)) throw Error(t("此编排类型无法等价转换，请使用原生路由表单", "This compiled type cannot be converted; use the native routing form"));
      if (!final && (!value.matchValue.trim() || /[,\r\n]/.test(value.matchValue))) throw Error(t("请填写单个有效匹配值", "Enter one valid match value"));
      const originalFinal = ["FINAL", "MATCH"].includes(parts[0].toUpperCase());
      const hasOptions = parts.length > (originalFinal ? 2 : 3)
        || parts.slice(originalFinal ? 1 : 2).some((part) => ["no-resolve", "src", "extended-matching", "dns-failed"].includes(part.toLowerCase()));
      if (hasOptions) throw Error(t("此旧规则含附加选项，请通过原生路由表单改写后删除旧规则", "This legacy rule has extra options; rewrite it in the native routing form, then delete the old rule"));
      const rule = final ? value.matchType : `${value.matchType},${value.matchValue.trim()},${value.policy}`;
      const next = { ...(original || { id: crypto.randomUUID(), order: nextPlanOrder(plan) }), rule, policy: value.policy, enabled: value.enabled };
      if (index === null) appendPlanItem(plan, "direct", next); else plan.directRules[index] = next;
      closeModal(); changed(); render();
    });
  }

  return {
    updateChainFilterVisibility, editEntity, editGroup, editSingboxGroup, editJson,
    validateSurgeFinal, updateSurgeRuleForm, editSurgeRule, editSurgeRuleText,
    ruleSetDownloadName, editOutput, confirmDelete, editDirect, editSingboxDirect
  };
}
