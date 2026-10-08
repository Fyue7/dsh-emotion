#!/usr/bin/env node
/**
 * distill —— 文本蒸馏流水线。
 *
 * 两步，对应两种不同性质的证据：
 *
 *   stats  机算轨：全文的量。句长分布、标点指纹、高频短语、n-gram。
 *          这些是**可复现的事实**，不需要读一遍就能算出来。
 *
 *   merge  人读轨：分片精读产出的 JSON digest 的合并。
 *          加上两道**必须**的校验门（保真门 + 安全门），产出 style-profile.json。
 *
 * 用法：
 *   node tools/distill.mjs stats  --corpus <dir> [--out stats.json] [--ext .md,.txt]
 *   node tools/distill.mjs merge  --digests <dir> --corpus <dir> [--stats stats.json]
 *                                 [--rules rules.json] [--out style-profile.json]
 *                                 [--samples 3] [--source "你的文本名"]
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { computeStats, grade, loadCorpus, phraseStats, sentences } from './lib/corpus.mjs';
import { createRules, classify, isLexiconWorthy } from './lib/safety.mjs';

/* ------------------------------------------------------------------ 参数 */

function parseArgs(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (token.startsWith('--')) {
			const key = token.slice(2);
			const next = argv[i + 1];
			if (next === undefined || next.startsWith('--')) out[key] = true;
			else {
				out[key] = next;
				i += 1;
			}
		} else out._.push(token);
	}
	return out;
}

function fail(message) {
	console.error(`错误：${message}`);
	process.exit(2);
}

async function writeJson(path, data) {
	await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/* ------------------------------------------------------------------ stats */

export async function cmdStats(args) {
	const dir = args.corpus;
	if (!dir) fail('缺少 --corpus <目录>');

	const extensions = args.ext ? String(args.ext).split(',').map((s) => s.trim()) : undefined;
	const docs = await loadCorpus(dir, extensions);
	if (!docs.length) fail(`目录里没有找到文本文件：${dir}`);

	const stats = computeStats(docs);
	const phrases = phraseStats(docs);

	// 定性档位：用本语料自己的分布标定，而不是拍脑袋的绝对阈值
	const pk = stats.punctuation.per1k;
	const grades = {
		ellipsis: grade(pk['…'] ?? 0),
		exclamation: grade(pk['！'] ?? pk['!'] ?? 0),
		question: grade(pk['？'] ?? pk['?'] ?? 0),
		dash: grade(pk['—'] ?? 0, { frequent: 1, occasional: 0.3 }),
	};
	stats.punctuation.grade = grades;

	const result = { ...stats, phrases };
	const out = args.out ?? 'distill-stats.json';
	await writeJson(out, result);

	console.log(`语料：${stats.corpus.files} 个文件，${stats.corpus.chars.toLocaleString()} 字符`);
	console.log(`句长：平均 ${stats.rhythm.avgSentenceLen} / 中位 ${stats.rhythm.medianSentenceLen}，` +
		`短句 ${(stats.rhythm.shortSentenceRatio * 100).toFixed(1)}%，长句 ${(stats.rhythm.longSentenceRatio * 100).toFixed(1)}%`);
	console.log(`标点（每千字）：${Object.entries(pk).slice(0, 6).map(([k, v]) => `${k}${v}`).join(' ')}`);
	console.log(`档位：${JSON.stringify(grades)}`);
	console.log(`写出：${out}`);
}

/* ------------------------------------------------------------------ merge */

/** 情绪标签 → §9 词库桶的默认映射（可用 --rules 覆盖）。 */
const DEFAULT_BUCKETS = {
	joy: ['希望/少年感', '热血/燃', '滑稽/自嘲'],
	sad: ['丧/颓', '悲伤/离别', '孤独', '怀念/乡愁'],
	tired: ['平静/倦怠'],
	anger: ['愤怒', '嘲讽/痞'],
	fear: ['恐惧/压迫'],
	tenderness: ['温柔/治愈', '少女/撒娇'],
};

/**
 * 保真门：两段式校验。
 *
 * 第一阶段查「声称的位置」。查不到**不等于**是编造 —— 分片器可能只是标错了位置。
 * 所以第二阶段全库搜寻真实归属；只有全库都没有，才判编造。
 *
 * 这个区分是必要的：我自己的项目里，7 条「查不到」的引用中有 3 条其实是
 * 引文真实、章号标错了一章。一律丢弃会白白损失真实素材。
 */
function verifyQuote(quote, claimed, docs) {
	const wanted = String(claimed ?? '').trim();
	if (!wanted) {
		const hit = docs.find((d) => d.text.includes(quote));
		return hit ? { location: hit.name, reattributed: Boolean(hit) } : null;
	}
	// 允许 1 / 01 / 001 三种写法
	const variants = new Set([wanted]);
	if (/^\d+$/.test(wanted)) {
		const n = Number(wanted);
		variants.add(String(n));
		variants.add(String(n).padStart(2, '0'));
		variants.add(String(n).padStart(3, '0'));
	}
	const claimedDoc = docs.find((d) => [...variants].some((v) => d.name.includes(v)));
	if (claimedDoc && claimedDoc.text.includes(quote)) {
		return { location: claimedDoc.name, reattributed: false };
	}
	const other = docs.find((d) => d.text.includes(quote));
	if (other) return { location: other.name, reattributed: true };
	return null;
}

async function loadDigests(dir) {
	const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
	const digests = [];
	for (const file of files) {
		try {
			digests.push({ file, data: JSON.parse(await readFile(join(dir, file), 'utf8')) });
		} catch (error) {
			console.warn(`  跳过无法解析的 digest：${file}（${error.message}）`);
		}
	}
	return digests;
}

function asList(value) {
	if (value === null || value === undefined) return [];
	if (Array.isArray(value)) return value.flatMap(asList);
	if (typeof value === 'object') return Object.values(value).flatMap(asList);
	return [String(value)];
}

/**
 * 取「对象行」数组。
 *
 * ⚠️ 不能用 asList —— 它会把对象**拆成字符串**，导致结构化行全部丢失。
 * 这个坑我在测试里踩到过：digest 明明有 3 条情绪样本，合并结果却是 0 条。
 */
function rows(value) {
	if (!Array.isArray(value)) return [];
	return value.filter((row) => row && typeof row === 'object' && !Array.isArray(row));
}

function clean(value) {
	return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** 从语料里挑 few-shot 候选段（滑窗），优先不含专名。 */
function pickSamples(docs, rules, { count = 3, names = [] } = {}) {
	const SIMILE = ['像', '好像', '仿佛', '似'];
	const candidates = [];

	for (const doc of docs) {
		const list = sentences(doc.text);
		for (const n of [3, 2]) {
			for (let i = 0; i + n <= list.length; i += 1) {
				const text = `${list.slice(i, i + n).join('。')}。`;
				if (text.length < 50 || text.length > 160) continue;
				if (classify(text, rules, { hardOnly: true }).level === 'blocked') continue;
				if (classify(text, rules).level !== 'safe') continue;
				let score = (n === 3 ? 1 : 0) + (text.includes('…') ? 1 : 0);
				if (SIMILE.some((s) => text.includes(s))) score += 2;
				if (names.some((name) => name && text.includes(name))) score -= 3;
				if (text.startsWith('“') || text.startsWith('「')) score -= 1;
				candidates.push({ score, text });
			}
		}
	}

	candidates.sort((a, b) => b.score - a.score);
	const picked = [];
	for (const { text } of candidates) {
		if (picked.length >= count) break;
		// 滑窗会产生大量重叠候选，按内容重叠去重
		if (picked.some((kept) => kept.includes(text.slice(0, 30)) || text.includes(kept.slice(0, 30)))) continue;
		picked.push(text);
	}
	return picked;
}

export async function cmdMerge(args) {
	const digestDir = args.digests;
	const corpusDir = args.corpus;
	if (!digestDir) fail('缺少 --digests <目录>');
	if (!corpusDir) fail('缺少 --corpus <目录>（保真门需要回原文校验）');

	const rulesOverride = args.rules && existsSync(args.rules)
		? JSON.parse(await readFile(args.rules, 'utf8'))
		: {};
	const rules = createRules(rulesOverride.safety ?? {});
	const buckets = rulesOverride.buckets ?? DEFAULT_BUCKETS;
	const names = rulesOverride.names ?? [];

	const docs = await loadCorpus(corpusDir);
	if (!docs.length) fail(`语料目录为空：${corpusDir}`);

	const digests = await loadDigests(digestDir);
	if (!digests.length) fail(`digest 目录里没有 JSON：${digestDir}`);

	const stats = args.stats && existsSync(args.stats)
		? JSON.parse(await readFile(args.stats, 'utf8'))
		: (() => {
				const s = computeStats(docs);
				const pk = s.punctuation.per1k;
				s.punctuation.grade = {
					ellipsis: grade(pk['…'] ?? 0),
					exclamation: grade(pk['！'] ?? 0),
					question: grade(pk['？'] ?? 0),
					dash: grade(pk['—'] ?? 0, { frequent: 1, occasional: 0.3 }),
				};
				return s;
			})();

	/* --- 情绪样本：保真门 + 安全门 --- */
	const samples = [];
	const byEmotion = new Map();
	const unverified = [];
	const reattributed = [];
	const seen = new Set();
	let templateBlocked = 0;
	let templateCaution = 0;
	const templates = [];
	const templateSeen = new Set();
	const lexiconByBucket = {};
	const lexiconByStyle = {};
	const styleFeatures = {};
	const characterVoices = new Map();
	const risks = [];
	const chapterIndex = [];

	for (const { data } of digests) {
		for (const row of rows(data.chapterIndex)) {
			chapterIndex.push(row);
		}
		for (const row of rows(data.emotionSamples)) {
			const quote = clean(row.quote);
			if (!quote || seen.has(quote)) continue;
			seen.add(quote);

			const verified = verifyQuote(quote, row.chapter, docs);
			if (!verified) {
				unverified.push({ quote, claimed: clean(row.chapter) });
				continue;
			}
			if (verified.reattributed) {
				reattributed.push({ quote, claimed: clean(row.chapter), actual: verified.location });
			}
			const emotion = clean(row.emotion) || 'unclassified';
			const record = { emotion, quote, technique: clean(row.technique), location: verified.location };
			samples.push(record);
			if (!byEmotion.has(emotion)) byEmotion.set(emotion, []);
			byEmotion.get(emotion).push(record);
		}

		for (const row of rows(data.templates)) {
			const pattern = clean(row.pattern);
			if (!pattern || templateSeen.has(pattern)) continue;
			templateSeen.add(pattern);
			// 硬拦截只看模板本身：示例只是证据，不进提示词，不该决定模板生死
			const verdict = classify(pattern, rules, { hardOnly: true });
			if (verdict.level === 'blocked') {
				templateBlocked += 1;
				continue;
			}
			const cautious = classify(`${pattern} ${clean(row.example)}`, rules).level === 'caution';
			if (cautious) templateCaution += 1;
			templates.push({ emotion: clean(row.emotion), pattern, example: clean(row.example), risk: cautious ? 'caution' : 'safe' });
		}

		const lex = data.lexicon;
		if (lex && typeof lex === 'object') {
			for (const [key, value] of Object.entries(lex)) {
				if (!lexiconByStyle[key]) lexiconByStyle[key] = [];
				for (const item of asList(value)) {
					const s = clean(item);
					if (s && !lexiconByStyle[key].includes(s)) lexiconByStyle[key].push(s);
				}
			}
		}

		const sf = data.styleFeatures;
		if (sf && typeof sf === 'object') {
			for (const [key, value] of Object.entries(sf)) {
				if (!styleFeatures[key]) styleFeatures[key] = [];
				for (const item of asList(value)) {
					const s = clean(item);
					if (s && !styleFeatures[key].includes(s)) styleFeatures[key].push(s);
				}
			}
		}

		for (const voice of rows(data.characterVoices)) {
			const key = clean(voice.name);
			if (!key) continue;
			if (!characterVoices.has(key)) characterVoices.set(key, { name: key, traits: [], catchphrases: [] });
			const target = characterVoices.get(key);
			for (const trait of asList(voice.traits)) {
				const s = clean(trait);
				if (s && !target.traits.includes(s)) target.traits.push(s);
			}
			for (const tic of asList(voice.catchphrases)) {
				const s = clean(tic);
				if (s && !target.catchphrases.includes(s)) target.catchphrases.push(s);
			}
		}

		for (const risk of asList(data.risks)) {
			const s = clean(risk);
			if (s && !risks.includes(s)) risks.push(s);
		}
	}

	/* --- 词库：从已通过保真门的样本里取短条目 --- */
	for (const [bucket, emotions] of Object.entries(buckets)) {
		const items = [];
		for (const emotion of emotions) {
			for (const record of byEmotion.get(emotion) ?? []) {
				if (isLexiconWorthy(record.quote, rules, { maxLen: 14, names })) {
					if (!items.includes(record.quote)) items.push(record.quote);
				}
			}
		}
		lexiconByBucket[bucket] = items.slice(0, 20);
	}

	const pickedSamples = pickSamples(docs, rules, { count: Number(args.samples ?? 3), names });

	// 风格词表过安全门：去脏话、去专名、限制长度
	const lexiconByStyleFiltered = {};
	for (const [key, items] of Object.entries(lexiconByStyle)) {
		lexiconByStyleFiltered[key] = items
			.filter((s) => isLexiconWorthy(s, rules, { maxLen: 12, names }))
			.slice(0, 40);
	}

	const profile = {
		_comment: '由 tools/distill.mjs 生成。quote / samples 为逐字摘录，已过保真门与安全门。',
		source: args.source ? String(args.source) : basename(corpusDir),
		sourceType: 'user-supplied',
		extractedAt: new Date().toISOString().slice(0, 10),
		schema: 'style-profile/v1',
		provenance: {
			digests: digests.map((d) => d.file),
			corpusFiles: docs.length,
			corpusChars: stats.corpus?.chars ?? 0,
			emotionSamples: samples.length,
			quoteFidelity: samples.length + unverified.length
				? Math.round((samples.length / (samples.length + unverified.length)) * 1000) / 1000
				: 1,
			reattributed: reattributed.length,
			templatesKept: templates.length,
			templatesBlocked: templateBlocked,
			templatesCaution: templateCaution,
		},
		rhythm: stats.rhythm,
		punctuation: stats.punctuation,
		styleDirectives: deriveDirectives(stats, rules),
		lexicon: lexiconByBucket,
		lexiconByStyle: lexiconByStyleFiltered,
		imagery: (styleFeatures.metaphorDomains ?? styleFeatures.imagery ?? []).slice(0, 12),
		verbalTics: (styleFeatures.verbalTics ?? lexiconByStyleFiltered['口语'] ?? []).slice(0, 30),
		addressForms: { user: '你', self: '我' },
		samples: pickedSamples,
		templates,
		characterVoices: [...characterVoices.values()],
		risks,
		chapterIndex,
	};

	const out = args.out ?? 'style-profile.json';
	await writeJson(out, profile);

	console.log(`合并 ${digests.length} 份 digest`);
	console.log(`  章节索引      ：${chapterIndex.length}`);
	console.log(`  情绪样本      ：${samples.length} 条通过保真门，${unverified.length} 条判编造剔除，${reattributed.length} 条改判归属`);
	console.log(`  保真度        ：${(profile.provenance.quoteFidelity * 100).toFixed(1)}%`);
	console.log(`  句式模板      ：保留 ${templates.length}，硬拦截 ${templateBlocked}，标记降级 ${templateCaution}`);
	console.log(`  few-shot 样例 ：${pickedSamples.length} 段`);
	console.log(`  写出          ：${out}`);

	if (unverified.length) {
		console.log('\n被剔除的引用（全库找不到对应，属编造）：');
		for (const item of unverified.slice(0, 10)) console.log(`  [声称 ${item.claimed}] ${item.quote}`);
	}
	if (reattributed.length) {
		console.log('\n归属改判（引文真实，仅位置标错）：');
		for (const item of reattributed.slice(0, 10)) console.log(`  ${item.claimed} → ${item.actual}：${item.quote}`);
	}
}

/** 从统计事实里推导通用的表达指引（不含任何原文）。 */
function deriveDirectives(stats, rules) {
	const directives = [];
	const r = stats.rhythm ?? {};
	if (r.shortSentenceRatio >= 0.3) directives.push('以短句为主，节奏快');
	else if (r.longSentenceRatio >= 0.3) directives.push('以长句铺陈为主，句末收力');
	else directives.push('长短交替：约四分之一短句收力，约四分之一长句铺陈，不堆排比');
	if ((stats.punctuation?.grade?.dash ?? 'rare') === 'rare') directives.push('几乎不用破折号，停顿交给省略号和短句');
	if ((stats.punctuation?.grade?.ellipsis ?? '') !== 'rare') directives.push('省略号承担停顿，不靠感叹号堆情绪');
	directives.push('不直说情绪：用动作、天气、物件侧写');
	directives.push('收尾留一句轻的，把前面重的东西压住；不总结、不升华');
	return directives;
}

/* ------------------------------------------------------------------ 入口 */

// 只有被当作脚本直接运行时才解析 argv；被 import 时保持纯导出，便于测试。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
	const [, , command, ...rest] = process.argv;
	const args = parseArgs(rest);

	switch (command) {
		case 'stats':
			await cmdStats(args);
			break;
		case 'merge':
			await cmdMerge(args);
			break;
		default:
			console.log(`用法：
  node tools/distill.mjs stats  --corpus <dir> [--out stats.json] [--ext .md,.txt]
  node tools/distill.mjs merge  --digests <dir> --corpus <dir> [--stats stats.json]
                                [--rules rules.json] [--out style-profile.json]
                                [--samples 3] [--source "你的文本名"]`);
			process.exit(command ? 2 : 0);
	}
}
