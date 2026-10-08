/**
 * 语料加载与全文统计。
 *
 * 面向「一个目录下很多文本文件」的常见形态（分章小说、文档集、日志），
 * 不假设任何特定的文件命名。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';

export const DEFAULT_EXTENSIONS = ['.md', '.markdown', '.txt', '.text'];

/** 递归收集文本文件，按路径排序（保证可复现）。 */
export async function walkFiles(dir, extensions = DEFAULT_EXTENSIONS) {
	const exts = new Set(extensions.map((e) => e.toLowerCase()));
	const out = [];

	async function visit(current) {
		const entries = await readdir(current, { withFileTypes: true });
		for (const entry of entries) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
				await visit(full);
			} else if (entry.isFile() && exts.has(extname(entry.name).toLowerCase())) {
				out.push(full);
			}
		}
	}

	const info = await stat(dir);
	if (info.isFile()) return [dir];
	await visit(dir);
	return out.sort();
}

/** 读入整个语料目录。返回 [{ path, name, text }]。 */
export async function loadCorpus(dir, extensions = DEFAULT_EXTENSIONS) {
	const files = await walkFiles(dir, extensions);
	const docs = [];
	for (const path of files) {
		const text = await readFile(path, 'utf8');
		docs.push({ path, name: path.split(/[\\/]/).pop(), text });
	}
	return docs;
}

/**
 * 切句。
 *
 * 同时处理中英标点：中文的 。！？… 与拉丁的 .!?（要求后面跟空白或行尾，
 * 避免把小数点和缩写切开）。换行也是边界。
 */
const SENTENCE_SPLIT = /[。！？…]+|(?<=[.!?])(?=\s)|\n+/;

export function sentences(text) {
	return text
		.split(SENTENCE_SPLIT)
		.map((s) => s.trim())
		.filter(Boolean);
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

const PUNCTUATION = ['，', '。', '！', '？', '…', '—', '、', '；', '：', '“', '”', '（', '）', '·', ',', '.', '!', '?', ';', ':', '"', "'"];

function ratio(values, predicate) {
	if (!values.length) return 0;
	let hit = 0;
	for (const v of values) if (predicate(v)) hit += 1;
	return Math.round((hit / values.length) * 1000) / 1000;
}

function median(sorted) {
	if (!sorted.length) return 0;
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10;
}

/**
 * 全文统计。产出可直接填进 style-profile 的 `rhythm` 与 `punctuation`。
 */
export function computeStats(docs) {
	const full = docs.map((d) => d.text).join('\n');
	const stripped = full.replace(/\s+/g, '');
	const all = [];
	for (const doc of docs) all.push(...sentences(doc.text));

	const lengths = all.map((s) => s.length);
	const sorted = [...lengths].sort((a, b) => a - b);

	const punctCounts = {};
	for (const p of PUNCTUATION) {
		const count = full.split(p).length - 1;
		if (count > 0) punctCounts[p] = count;
	}
	const per1k = {};
	const denom = Math.max(1, stripped.length);
	for (const [p, count] of Object.entries(punctCounts)) {
		per1k[p] = Math.round((count / denom) * 1000 * 100) / 100;
	}

	// 对白/引号内容占比（中英文引号都算）
	const quoted = [...full.matchAll(/[“"]([^”"]*)[”"]/g)].reduce((sum, m) => sum + m[1].length, 0);

	const avg = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;

	return {
		corpus: {
			files: docs.length,
			chars: full.length,
			nonWhitespaceChars: stripped.length,
			cjkChars: (full.match(new RegExp(CJK, 'g')) || []).length,
			sentences: all.length,
		},
		rhythm: {
			avgSentenceLen: Math.round(avg * 10) / 10,
			medianSentenceLen: median(sorted),
			p90SentenceLen: sorted.length ? sorted[Math.floor(sorted.length * 0.9)] : 0,
			maxSentenceLen: sorted.length ? sorted[sorted.length - 1] : 0,
			shortSentenceRatio: ratio(lengths, (v) => v <= 10),
			longSentenceRatio: ratio(lengths, (v) => v >= 40),
			note: '由全文实测得出；paragraphMaxSentences 需按你的文本结构单独决定',
		},
		punctuation: {
			per1k,
			quoteRatio: Math.round((quoted / denom) * 1000) / 1000,
			note: 'per1k 为每千字出现次数；定性字段请用 grade() 按你的语料自行标定',
		},
	};
}

/** 把每千字率转成定性档位。阈值可覆盖。 */
export function grade(rate, { frequent = 8, occasional = 3 } = {}) {
	if (rate >= frequent) return 'frequent';
	if (rate >= occasional) return 'occasional';
	return 'rare';
}

/** 高频短语与 n-gram —— 用来发现笔者的用词偏好，而不是靠印象。 */
export function phraseStats(docs, { topPhrases = 200, ngrams = [2, 3, 4] } = {}) {
	const SEGMENT_SPLIT = /[，。！？…—、；：“”"'（）()《》\s·,.!?;:]+/;
	const segments = [];
	for (const doc of docs) {
		for (const sentence of sentences(doc.text)) {
			for (const seg of sentence.split(SEGMENT_SPLIT)) {
				const s = seg.trim();
				if (s.length >= 3) segments.push(s);
			}
		}
	}

	const phraseCount = new Map();
	for (const s of segments) phraseCount.set(s, (phraseCount.get(s) || 0) + 1);

	const gramOut = {};
	for (const n of ngrams) {
		const counter = new Map();
		for (const doc of docs) {
			for (const sentence of sentences(doc.text)) {
				const clean = [...sentence].filter((ch) => CJK.test(ch)).join('');
				for (let i = 0; i + n <= clean.length; i += 1) {
					const g = clean.slice(i, i + n);
					counter.set(g, (counter.get(g) || 0) + 1);
				}
			}
		}
		gramOut[n] = [...counter.entries()]
			.filter(([, c]) => c >= 3)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 120)
			.map(([gram, count]) => ({ gram, count }));
	}

	return {
		topPhrases: [...phraseCount.entries()]
			.filter(([, c]) => c >= 3)
			.sort((a, b) => b[1] - a[1])
			.slice(0, topPhrases)
			.map(([phrase, count]) => ({ phrase, count })),
		ngrams: gramOut,
		segmentCount: segments.length,
		uniqueSegments: phraseCount.size,
	};
}
