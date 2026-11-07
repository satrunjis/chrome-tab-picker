// Compute this from ALL tabs; search must never rescale the result.
export function compareRecency(a, b) {
  return (b.lastUsed ?? 0) - (a.lastUsed ?? 0) ||
    a.windowId - b.windowId || a.index - b.index || a.id - b.id;
}

export function withRecency(tabs) {
  return [...tabs].sort(compareRecency).map((tab, rank, all) => {
    // 65% keeps secondary text readable on normal and selected backgrounds.
    const brightness = all.length <= 1 ? 1 : 1 - 0.35 * rank / (all.length - 1);
    const gray = value => {
      const channel = Math.round(value * brightness);
      return `rgb(${channel}, ${channel}, ${channel})`;
    };
    return { ...tab, brightness, primaryColor: gray(238), secondaryColor: gray(212) };
  });
}

export function relativeTime(lastUsed, now = Date.now()) {
  if (!Number.isFinite(lastUsed) || lastUsed <= 0) return '—';
  const minutes = Math.floor(Math.max(0, now - lastUsed) / 60000);
  if (minutes < 1) return 'сейчас';
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'вчера';
  const suffix = days % 10 === 1 && days % 100 !== 11 ? 'день' :
    days % 10 >= 2 && days % 10 <= 4 && (days % 100 < 12 || days % 100 > 14) ? 'дня' : 'дней';
  return `${days} ${suffix}`;
}

export function domainLabel(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname || (parsed.protocol === 'file:' ? 'Локальный файл' : parsed.protocol.replace(':', ''));
  } catch { return 'Без адреса'; }
}
