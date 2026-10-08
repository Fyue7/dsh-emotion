/**
 * n-gram 重合检测 —— 「不成段复现原文」的可执行护栏。
 *
 * 原理：把语料切成 n-gram 建索引，扫描任意文本，找出与语料**逐字重合**的最长片段。
 *
 * 与查重的区别：我们只关心**长的**重合。短的重合是通用语言
 * （「我靠」「不知道」），不该算违规。所以判据是长度，不是相似度。
 *
 * 实测经验：在一个 65 万字的语料上，12-gram 有 99.8% 只出现一次，
 * 也就是说「罕见度」判据几乎恒真 —— **真正起作用的就是长度阈值**。
 * 因此本实现只看长度，不引入词频权重，行为更容易解释。
 */

/** FNV-1a 32 位哈希。 */
export function hash32(str) {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i += 1) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/**
 * 归一化：**只压掉空白**。
 * 保留标点是有意的 —— 否则跨句拼接会与原文“撞车”，产生大量误报。
 */
export function normalize(text) {
	return String(text ?? '').replace(/\s+/g, '');
}

/**
 * 建索引。返回 n、排序后的哈希数组，以及语料长度。
 *
 * 内存：每 n-gram 4 字节。65 万字的语料、n=12 约 3 MB —— 可以常驻。
 * 用哈希而非原串是为了控制内存；代价是理论上的哈希碰撞会带来极小概率误报。
 * 对「护栏」这一用途可以接受，但请知悉它不是密码学级别的判定。
 */
export function buildIndex(text, n = 12) {
	const s = normalize(text);
	if (s.length < n) return { n, hashes: new Uint32Array(0), chars: s.length };

	const hashes = new Uint32Array(s.length - n + 1);
	for (let i = 0; i < hashes.length; i += 1) hashes[i] = hash32(s.slice(i, i + n));
	hashes.sort();
	return { n, hashes, chars: s.length };
}

function contains(hashes, value) {
	let lo = 0;
	let hi = hashes.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const v = hashes[mid];
		if (v === value) return true;
		if (v < value) lo = mid + 1;
		else hi = mid - 1;
	}
	return false;
}

/**
 * 找出与语料逐字重合、且长度 ≥ minLen 的片段。
 *
 * @returns {{span: string, length: number}[]} 按长度降序、已去除被包含的片段
 */
export function findOverlaps(text, index, { minLen = 12 } = {}) {
	const { n, hashes } = index;
	if (!hashes.length || minLen < n) return [];

	const s = normalize(text);
	const hits = [];
	let i = 0;

	while (i + n <= s.length) {
		if (!contains(hashes, hash32(s.slice(i, i + n)))) {
			i += 1;
			continue;
		}
		// 命中就向右扩展
		let j = i + n;
		while (j < s.length && contains(hashes, hash32(s.slice(j - n + 1, j + 1)))) j += 1;
		const span = s.slice(i, j);
		if (span.length >= minLen) hits.push({ span, length: span.length });
		i = j;
	}

	hits.sort((a, b) => b.length - a.length);
	const out = [];
	for (const hit of hits) {
		if (!out.some((kept) => kept.span.includes(hit.span))) out.push(hit);
	}
	return out;
}
