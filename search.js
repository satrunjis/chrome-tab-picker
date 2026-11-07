import { compareRecency } from './recency.js';

// Dynamic programming over Unicode code points. Rewards runs and word starts;
// returns original UTF-16 offsets so rendering never splits surrogate pairs.
export function fuzzyMatch(text, query) {
  const chars = Array.from(text);
  const needle = Array.from(query.toLocaleLowerCase());
  const offsets = [];
  let offset = 0;
  for (const char of chars) { offsets.push(offset); offset += char.length; }
  if (!needle.length) return { score: 0, positions: [] };
  let previous = new Map();
  for (let q = 0; q < needle.length; q++) {
    const current = new Map();
    let best = null;
    for (let i = 0; i < chars.length; i++) {
      const prior = previous.get(i - 1);
      if (prior && (!best || prior.score + (i - 1) * 0.2 > best.value)) {
        best = { ...prior, value: prior.score + (i - 1) * 0.2 };
      }
      if (chars[i].toLocaleLowerCase() !== needle[q]) continue;
      const boundary = i === 0 || /[\s/._:\-?#=&]/u.test(chars[i - 1]) ||
        (chars[i] !== chars[i].toLocaleLowerCase() && chars[i - 1] === chars[i - 1].toLocaleLowerCase());
      const bonus = 10 + (boundary ? 9 : 0);
      if (q === 0) current.set(i, { score: bonus - i * 0.2, positions: [offsets[i]] });
      else {
        const candidates = [];
        if (best) candidates.push({ score: best.value - (i - 1) * 0.2 + bonus, positions: best.positions });
        if (prior) candidates.push({ score: prior.score + bonus + 14, positions: prior.positions });
        candidates.sort((a, b) => b.score - a.score);
        if (candidates.length) current.set(i, { score: candidates[0].score, positions: [...candidates[0].positions, offsets[i]] });
      }
    }
    previous = current;
    if (!previous.size) return null;
  }
  const winner = [...previous.values()].sort((a, b) => b.score - a.score)[0];
  // Unmatched suffixes do not change match quality. In particular, the same
  // domain prefix must tie across URLs so MRU, not URL length, breaks the tie.
  return winner;
}

export function rankTabs(tabs, query) {
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean)
    .map(text => ({ text, titleBonus: 24 + Array.from(text).length * 8 }));
  return tabs.flatMap(tab => {
    let score = 0, contiguousTokens = 0;
    const titleText = tokens.length ? tab.title.toLocaleLowerCase() : '';
    const urlText = tokens.length ? tab.url.toLocaleLowerCase() : '';
    const titlePositions = new Set(), urlPositions = new Set();
    for (const token of tokens) {
      const title = fuzzyMatch(tab.title, token.text);
      const url = fuzzyMatch(tab.url, token.text);
      if (!title && !url) return [];
      const titleContiguous = !!title && titleText.includes(token.text);
      const urlContiguous = !!url && urlText.includes(token.text);
      const contiguous = titleContiguous || urlContiguous;
      if (contiguous) contiguousTokens++;
      // Match quality comes before field preference: a literal domain must beat
      // scattered letters in a title. Within that quality, prefer the title.
      score += Math.max(
        title && (!contiguous || titleContiguous) ? title.score + token.titleBonus : -Infinity,
        url && (!contiguous || urlContiguous) ? url.score : -Infinity
      );
      title?.positions.forEach(i => titlePositions.add(i));
      url?.positions.forEach(i => urlPositions.add(i));
    }
    return [{ ...tab, score, contiguousTokens, titlePositions, urlPositions }];
  }).sort((a, b) => b.contiguousTokens - a.contiguousTokens || b.score - a.score || compareRecency(a, b));
}
