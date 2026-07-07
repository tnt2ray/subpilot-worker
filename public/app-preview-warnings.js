export function groupPreviewWarnings(warnings) {
  const groups = [];
  const groupedCoverage = new Map();
  for (const message of warnings) {
    const coverage = parsePreviewCoverageWarning(message);
    if (!coverage) {
      groups.push({ summary: message, details: [] });
      continue;
    }
    const key = [coverage.target, coverage.currentSource, coverage.previousSource, coverage.effect].join("\0");
    let group = groupedCoverage.get(key);
    if (!group) {
      group = {
        target: coverage.target,
        currentSource: coverage.currentSource,
        previousSource: coverage.previousSource,
        effect: coverage.effect,
        details: []
      };
      groupedCoverage.set(key, group);
      groups.push(group);
    }
    group.details.push(message);
  }
  const renderedGroups = groups.map((group) => group.effect ? {
    summary: formatPreviewCoverageSummary(group),
    details: group.details
  } : group);
  return prioritizePreviewWarningGroups(renderedGroups);
}

export function prioritizePreviewWarningGroups(groups) {
  const normal = [];
  const redundant = [];
  const overflow = [];
  for (const group of groups) {
    if (isPreviewOverflowWarningGroup(group)) {
      overflow.push(group);
    } else if (isPreviewRedundantWarningGroup(group)) {
      redundant.push(group);
    } else {
      normal.push(group);
    }
  }
  return [...normal, ...redundant, ...overflow];
}

export function isPreviewRedundantWarningGroup(group) {
  return group.summary.includes("当前规则冗余") || group.details.some((message) => message.includes("当前规则冗余"));
}

export function isPreviewOverflowWarningGroup(group) {
  return group.summary.includes("覆盖诊断还有") && group.summary.includes("条提示未显示");
}

export function parsePreviewCoverageWarning(message) {
  const match = String(message).match(/^(Surge|Clash|Stash) Rule (.+?) 被前面的 (.+?) 覆盖（(.+)）。$/);
  if (!match) return null;
  const detail = match[4] || "";
  const effectSeparator = detail.lastIndexOf("；");
  return {
    target: match[1],
    currentSource: summarizeCoverageLabel(match[2]),
    previousSource: summarizeCoverageLabel(match[3]),
    effect: effectSeparator >= 0 ? detail.slice(effectSeparator + 1) : detail
  };
}

export function summarizeCoverageLabel(label) {
  return simplifyPreviewRuleSetNames(String(label).replace(/ 内第 \d+ 行$/, ""));
}

export function formatPreviewCoverageSummary(group) {
  const sameSource = group.currentSource === group.previousSource;
  const previousText = sameSource
    ? (group.currentSource.includes("规则集") ? "同一规则集内前面的规则" : "同一位置前面的规则")
    : `前面的${group.previousSource}`;
  const countText = group.details.length > 1 ? `，共 ${group.details.length} 条` : "";
  return `${group.target} Rule ${group.currentSource} 有部分规则被${previousText}覆盖${countText}（${group.effect}）。`;
}

export function simplifyPreviewRuleSetNames(message) {
  return String(message).replace(/规则集 (https?:\/\/.+?)(?=(?: 内第 \d+ 行| 内容| 不是| 未配置| 由|$))/g, (_match, url) => {
    return `规则集 ${formatRuleSetDisplayName(url)}`;
  });
}

export function formatRuleSetDisplayName(value) {
  try {
    const url = new URL(value);
    const filename = url.pathname.split("/").filter(Boolean).pop() || url.hostname;
    return decodeURIComponent(filename);
  } catch {
    return value;
  }
}
