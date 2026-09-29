import { ADDRESS_TOKEN, DOMAIN_TOKEN } from "./config-address-syntax.js";
import { LABELS } from "./app-model.js";

export function createUi(state) {
const $ = (selector, root = document) => root.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const t = (zh, en) => state.lang === "zh" ? zh : en;
const label = (key) => state.lang === "zh" ? LABELS[key] || key : key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
const paths = { grid: "M3 3h6v6H3zm12 0h6v6h-6zM3 15h6v6H3zm12 0h6v6h-6z", source: "M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h6", nodes: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M3 12h18M12 3c-5 5-5 13 0 18 5-5 5-13 0-18", settings: "m9 3-1 3-3 1v4l-2 1 2 2v4l3 1 1 2h6l1-2 3-1v-4l2-2-2-1V7l-3-1-1-3zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0", code: "m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18", link: "m10 14 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 10 5-5a4 4 0 0 0-6-6l-2 2", edit: "m4 15 11-11 5 5-11 11H4zM13 6l5 5", trash: "M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7", up: "m6 15 6-6 6 6", down: "m6 9 6 6 6-6", copy: "M8 8h13v13H8zM16 8V3H3v13h5", plus: "M12 4v16M4 12h16" };
const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.settings}"/></svg>`;
const btn = (text, action2, attrs = "", className = "") => `<button type="button" data-action="${action2}" class="${className}" ${attrs}>${text}</button>`;
const iconButton = (name, action, attrs = "", title = "") => btn(icon(name), action, `${attrs} aria-label="${esc(title || name)}" title="${esc(title || name)}"`, "icon-button");
const smallButton = (name, action2, attrs = "", title = "") => btn(icon(name) + (name === "edit" ? esc(title || t("编辑", "Edit")) : ""), action2, `${attrs} aria-label="${esc(title || name)}" title="${esc(title || name)}"`, name === "edit" ? "edit-button" : "icon-button");
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("#toast").hidden = true, 4500);
}
function isTextList(key, value) {
  return Array.isArray(value) && !["tailscaleNodes", "inbounds", "directRules", "servers", "rule_set", "outputs"].includes(key) && value.every((item) => typeof item === "string");
}
function displayTimeZoneOptions(current) {
  let zones = ["Asia/Shanghai", "Asia/Hong_Kong", "Asia/Taipei", "Asia/Singapore", "Asia/Tokyo", "Asia/Seoul", "Asia/Kolkata", "Asia/Dubai", "Europe/London", "Europe/Paris", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Australia/Sydney", "Pacific/Auckland"];
  try { if (typeof Intl.supportedValuesOf === "function") zones = Intl.supportedValuesOf("timeZone"); }
  catch { /* Older browsers retain the common time zone choices. */ }
  return [...new Set(["UTC", ...zones, ...(typeof current === "string" && current ? [current] : [])])].sort();
}
function field(path, value, options = {}) {
  const key = path.split(".").at(-1);
  const id = `field-${path.replaceAll(".", "-")}`;
  const title = options.label || label(key);
  if (path === "settings.displayTimeZone") options = { ...options, options: displayTimeZoneOptions(value) };
  if (path === "clients.surge.ipv6Vif") options = { ...options, options: ["off", "auto", "always"] };
  if (path === "clients.clash.mode") options = { ...options, options: ["rule", "global", "direct"] };
  if (path === "clients.clash.tun.stack") options = { ...options, options: ["system", "gvisor", "mixed", "mips"] };
  if (path === "clients.clash.dnsEnhancedMode") options = { ...options, options: ["fake-ip", "redir-host"] };
  const textList = isTextList(key, value);
  if (!options.local && path === "settings.excludeKeywords" && textList) {
    return `<div class="config-preview-field"><div class="section-heading"><span id="${id}-label">${esc(title)}</span>${iconButton("edit", "edit-json", `data-path="${esc(path)}" data-lines="true"`, t("编辑排除关键词", "Edit excluded keywords"))}</div>${value.length ? `<ul class="keyword-tags" aria-labelledby="${id}-label">${value.map((keyword) => `<li class="chip">${esc(keyword)}</li>`).join("")}</ul>` : `<p class="help">${t("未配置", "Not configured")}</p>`}</div>`;
  }
  if (!options.local && path === "settings.featureTagRules" && textList) {
    const rows = value.map((line) => {
      const separator = line.indexOf("=");
      const name = (separator < 0 ? line : line.slice(0, separator)).trim();
      const keywords = (separator < 0 ? line : line.slice(separator + 1)).split(",").map((item) => item.trim()).filter(Boolean);
      return `<div class="feature-tag-row"><dt>${esc(name || t("未命名", "Unnamed"))}</dt><dd>${keywords.length ? `<ul class="keyword-tags">${keywords.map((keyword) => `<li class="chip">${esc(keyword)}</li>`).join("")}</ul>` : `<span class="muted">${t("未配置", "Not configured")}</span>`}</dd></div>`;
    }).join("");
    return `<div class="config-preview-field"><div class="section-heading"><span id="${id}-label">${esc(title)}</span>${iconButton("edit", "edit-json", `data-path="${esc(path)}" data-lines="true"`, t("编辑节点特征标签", "Edit node feature tags"))}</div>${rows ? `<dl class="feature-tag-list" aria-labelledby="${id}-label">${rows}</dl>` : `<p class="help">${t("未配置", "Not configured")}</p>`}</div>`;
  }
  const structured = value && typeof value === "object";
  const multiline = options.multiline || typeof value === "string" && value.includes("\n");
  if (!options.local && !/token|secret|password|passphrase|authKey|caP12/i.test(key) && (textList || structured || multiline)) {
    const text = textList ? value.join("\n") : structured ? JSON.stringify(value, null, 2) : value;
    return `<div class="config-preview-field"><div class="section-heading"><span>${esc(title)}</span>${iconButton("edit", "edit-json", `data-path="${esc(path)}" data-lines="${textList}"`, t("编辑", "Edit"))}</div>${text ? renderConfigLines(text.split("\n")) : `<p class="help">${t("未配置", "Not configured")}</p>`}</div>`;
  }
  let control;
  const common = `id="${id}" data-field="${esc(path)}" ${state.invalid.has(path) ? 'aria-invalid="true"' : ""}`;
  if (typeof value === "boolean") control = `<input class="toggle" type="checkbox" ${common} ${value ? "checked" : ""} ${options.disabled ? "disabled" : ""}>`;
  else if (typeof value === "number") control = `<input type="number" ${common} data-kind="number" value="${esc(value)}">`;
  else if (options.options) control = `<select ${common}>${options.options.map((item) => `<option value="${esc(item)}" ${item === value ? "selected" : ""}>${esc(item)}</option>`).join("")}</select>`;
  else if (isTextList(key, value)) control = `<textarea ${common} data-kind="lines" rows="${Math.min(8, Math.max(3, value.length))}" spellcheck="false">${esc(value.join("\n"))}</textarea><div class="help">${esc(options.help || t("每行一项", "One item per line"))}</div>`;
  else if (value && typeof value === "object") control = `<textarea ${common} data-kind="json" class="code" rows="${Math.min(13, Math.max(4, JSON.stringify(value, null, 2).split("\n").length))}" spellcheck="false">${esc(JSON.stringify(value, null, 2))}</textarea><div class="help">JSON · ${t("保留完整原生字段", "Preserves native fields")}</div>`;
  else if (options.multiline || String(value).includes("\n")) control = `<textarea ${common} data-kind="text" class="code" rows="${options.rows || 7}" spellcheck="false">${esc(value)}</textarea>`;
  else control = `<input ${common} ${options.readonly ? "readonly" : ""} type="${/token|secret|password|passphrase|authKey/i.test(key) ? "password" : "text"}" value="${esc(value)}" autocomplete="off" spellcheck="false">`;
  if (state.invalid.has(path) && control.includes("<textarea")) control = control.replace(/(<textarea[^>]*>)[\s\S]*?(<\/textarea>)/, (_, open, close) => open + esc(state.invalid.get(path)) + close);
  if (options.local && !/token|secret|password|passphrase|authKey|caP12/i.test(key)) control = control.replace(/<textarea([^>]*?)class="code"/, '<textarea$1class="code code-editor"').replace(/<textarea(?![^>]*class=)/, '<textarea class="code-editor"');
  return `<div class="form-row"><label for="${id}">${esc(title)}</label><div class="field">${control}</div></div>`;
}
function section(title, content, extra = "") {
  const heading = title || extra ? `<div class="section-heading">${title ? `<h2>${esc(title)}</h2>` : ""}${extra}</div>` : "";
  return `<section class="section">${heading}${content}</section>`;
}
function clearHeadingTip(heading) {
  if (heading.parentElement.classList.contains("help-title")) heading.parentElement.replaceWith(heading);
}
function mountHelpTips(root, fallbackHeading) {
  for (const note of root.querySelectorAll("[data-help]")) {
    if (!note.textContent.trim()) { note.remove(); continue; }
    const heading = note.closest("section")?.querySelector(".section-heading h2, .section-heading h3") || fallbackHeading;
    let title = heading.parentElement;
    if (!title.classList.contains("help-title")) {
      title = document.createElement("div");
      title.className = "help-title";
      heading.before(title);
      title.append(heading);
    }
    let tip = title.querySelector(":scope > .settings-help");
    if (!tip) {
      tip = document.createElement("details");
      tip.className = "settings-help";
      tip.innerHTML = `<summary><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.7-2.5 1.8-2.5 3.5M12 16v.1"/></svg></summary><div class="settings-help-content"></div>`;
      $("summary", tip).setAttribute("aria-label", t("查看说明：", "About: ") + heading.textContent);
      title.append(tip);
    }
    note.removeAttribute("data-help");
    $(".settings-help-content", tip).append(note);
  }
}
function positionHelpTip(help) {
  if (!help.open) return;
  const content = help.querySelector(":scope > .settings-help-content, :scope > .mmdb-path-help");
  if (!content) return;
  const anchor = $("summary", help).getBoundingClientRect();
  const gap = 12;
  const width = Math.min(content.classList.contains("mmdb-path-help") ? 620 : 460, window.innerWidth - gap * 2);
  const below = window.innerHeight - anchor.bottom - gap * 2;
  const above = anchor.top - gap * 2;
  const useAbove = below < 220 && above > below;
  content.style.position = "fixed";
  content.style.width = `${width}px`;
  content.style.maxHeight = `${Math.max(80, Math.min(window.innerHeight - gap * 2, useAbove ? above : below))}px`;
  content.style.left = `${Math.max(gap, Math.min(anchor.left, window.innerWidth - width - gap))}px`;
  content.style.right = "auto";
  content.style.top = `${useAbove ? Math.max(gap, anchor.top - content.getBoundingClientRect().height - gap) : anchor.bottom + gap}px`;
}
function highlightConfigLine(line) {
  if (/^\s*(?:#|;|\/\/)/.test(line)) return `<span class="config-token-comment">${esc(line)}</span>`;
  // Tokenize only for display. Escape every token before adding trusted markup.
  const tokens = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|https?:\/\/[^\s,]+|\^\S+|[\w-]+(?=\s*=)|\b(?:true|false|auto|reject(?:-\w+)?|DIRECT|REJECT|Proxy|http-request|http-response)\b|\b\d+(?:\.\d+)*(?:\/\d+)?\b/g;
  const combinedTokens = new RegExp(`${ADDRESS_TOKEN.source}|${DOMAIN_TOKEN.source}|${tokens.source}`, "gi");
  let html = "", offset = 0;
  for (const match of line.matchAll(combinedTokens)) {
    const token = match[0];
    html += esc(line.slice(offset, match.index));
    const kind = new RegExp(`^(?:${ADDRESS_TOKEN.source})$`, "i").test(token) ? "number" : new RegExp(`^(?:${DOMAIN_TOKEN.source})$`, "i").test(token) ? "pattern" : /^['"]/.test(token) ? "string" : /^(?:https?:|\^)/.test(token) ? "pattern" : /^\d/.test(token) ? "number" : /^\s*=/.test(line.slice(match.index + token.length)) ? "key" : "keyword";
    html += `<span class="config-token-${kind}">${esc(token)}</span>`;
    offset = match.index + token.length;
  }
  return html + esc(line.slice(offset));
}
function renderConfigLines(lines) {
  return `<div class="client-config-values" role="region" aria-label="${t("配置内容（含行号）", "Configuration with line numbers")}" tabindex="0">${lines.flatMap((line) => line.split("\n")).map((line, index) => `<div class="client-config-line"><span class="config-line-number" aria-hidden="true">${index + 1}</span><code class="client-config-value">${highlightConfigLine(line)}</code></div>`).join("")}</div>`;
}
function localField(key, value, options = {}) {
  return field(key, value, { ...options, local: true }).replaceAll("data-field=", "data-local=");
}
function readLocal(original) {
  const result = structuredClone(original);
  for (const input of $("#modal-body").querySelectorAll("[data-local]")) {
    const key = input.dataset.local;
    let value = input.value;
    if (input.type === "checkbox") value = input.checked;
    else if (input.dataset.kind === "number") {
      value = Number(value);
      if (!Number.isFinite(value)) throw Error(t("请输入有效数字", "Enter a valid number"));
    } else if (input.dataset.kind === "lines") value = value.split("\n").map((line) => line.trim()).filter(Boolean);
    else if (input.dataset.kind === "json") value = JSON.parse(value);
    result[key] = value;
  }
  return result;
}
return { $, esc, t, label, icon, btn, iconButton, smallButton, isObject, toast, isTextList, field, section, clearHeadingTip, mountHelpTips, positionHelpTip, renderConfigLines, localField, readLocal };
}
