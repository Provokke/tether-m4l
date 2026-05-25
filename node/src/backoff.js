export function nextDelay(attempt, { baseMs = 500, capMs = 30_000, floorMs = 100, random = Math.random } = {}) {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.min(attempt, 30));
  return Math.max(floorMs, Math.round(random() * ceiling));
}
