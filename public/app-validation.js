export function validateActionsCompilationSettings(value, language = "zh") {
  if (!value?.enabled) return null;
  const message = (zh, en) => language === "zh" ? zh : en;
  if (typeof value.repository !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/.test(value.repository.trim())
    || [".", ".."].includes(value.repository.trim().split("/")[1])) {
    return message("Actions 规则编译的 GitHub 仓库必须填写 owner/repo。", "Enter the GitHub repository for Actions rule compilation as owner/repo.");
  }
  const ref = typeof value.ref === "string" ? value.ref.trim() : "";
  if (!ref || ref.length > 255 || ref === "@" || ref.startsWith("-") || /[\s\u0000-\u001f\u007f~^:?*\[\\]/.test(ref)
    || ref.includes("..") || ref.includes("@{") || ref.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))) {
    return message("Actions 规则编译的 GitHub 分支或标签无效。", "Enter a valid GitHub branch or tag for Actions rule compilation.");
  }
  if (["rules", "refs/heads/rules"].includes(ref)) {
    return message("工作流分支不能使用固定产物分支 rules。", "The workflow branch must differ from the fixed output branch rules.");
  }
  return null;
}
