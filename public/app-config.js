import { getPath, setPath } from "./app-model.js";

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Retain edits made while our own save was in flight.
function replayEdits(base, draft, saved) {
  if (same(base, draft)) return structuredClone(saved);
  if (!object(base) || !object(draft) || !object(saved)) return structuredClone(draft);
  const result = structuredClone(saved);
  for (const key of new Set([...Object.keys(base), ...Object.keys(draft)])) {
    if (same(base[key], draft[key])) continue;
    if (!Object.hasOwn(draft, key)) delete result[key];
    else result[key] = replayEdits(base[key], draft[key], saved[key]);
  }
  return result;
}

export function createConfigState(state) {
  function acceptSavedConfig(saved, { base = JSON.parse(state.saved), appliedPaths = [] } = {}) {
    const draft = structuredClone(state.config);
    for (const path of appliedPaths) setPath(draft, path, structuredClone(getPath(saved, path)));
    state.config = replayEdits(base, draft, saved);
    state.config.updatedAt = saved.updatedAt;
    state.saved = JSON.stringify(saved);
  }
  return { acceptSavedConfig };
}
