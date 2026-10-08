/**
 * 流水线测试：
 *   node tools/test/run.mjs
 *
 * 这里把**两条实战教训**写成了回归测试，它们比功能测试更重要：
 *
 *   1. 安全过滤不能误杀 —— 单字符正则会拦掉「{决定性一击}」（命中「性」）。
 *   2. 「查不到」不等于「是假的」 —— 引文可能只是位置标错了。
 *      一律丢弃会白白损失真实素材；全库找不到才判编造。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { computeStats, loadCorpus, phraseStats } from '../lib/corpus.mjs';
import { buildIndex, findOverlaps } from '../lib/ngram.mjs';
import { classify, createRules, isLexiconWorthy } from '../lib/safety.mjs';
import { cmdMerge, cmdStats } from '../distill.mjs';

let passed = 0;
let failed = 0;

async function test(label, fn) {
	try {
		await fn();
		passed += 1;
		console.log(`  ✓ ${label}`);
	} catch (error) {
		failed += 1;
		console.log(`  ✗ ${label}\n      ${error.message}`);
	}
}

/* ------------------------------------------------------------------ 夹具 */

const ORIGINAL = '外面的雨下得很大，雨点敲着铁皮棚子，一下一下的。他把外套脱下来搭在肩上，想了想，又穿回去了。';
const OTHER = '她说的那句话，他记了很多年，久到自己都快不信了。后来他在别的地方又听见一次，还是没听懂。';
const FABRICATED = '这一段话从来没有在任何地方出现过，完全是我编的。';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-distill-'));
const corpusDir = path.join(root, 'corpus');
const digestDir = path.join(root, 'digests');
fs.mkdirSync(corpusDir, { recursive: true });
fs.mkdirSync(digestDir, { recursive: true });
fs.writeFileSync(path.join(corpusDir, '001-a.md'), `${ORIGINAL}\n`, 'utf8');
fs.writeFileSync(path.join(corpusDir, '002-b.md'), `${OTHER}\n`, 'utf8');

console.log('\ntools/lib/corpus.mjs');

await test('loadCorpus 递归读入并排序', async () => {
	const docs = await loadCorpus(corpusDir);
	assert.equal(docs.length, 2);
	assert.deepEqual(docs.map((d) => d.name), ['001-a.md', '002-b.md']);
});

await test('computeStats 产出节奏与标点', async () => {
	const docs = await loadCorpus(corpusDir);
	const stats = computeStats(docs);
	assert.equal(stats.corpus.files, 2);
	assert.ok(stats.corpus.chars > 0);
	assert.ok(stats.rhythm.avgSentenceLen > 0, '平均句长没算出来');
	assert.ok('shortSentenceRatio' in stats.rhythm);
	assert.ok(Object.keys(stats.punctuation.per1k).length > 0, '标点统计为空');
});

await test('phraseStats 统计高频短语与 n-gram', async () => {
	const docs = await loadCorpus(corpusDir);
	const out = phraseStats(docs, { ngrams: [2] });
	assert.ok(out.segmentCount > 0);
	assert.ok(Array.isArray(out.ngrams[2]));
});

console.log('\ntools/lib/safety.mjs');

const rules = createRules();

await test('硬拦截只用多字词：单字不误杀', () => {
	// 这条是回归测试：第一版把「性」当**硬拦截**词，把正常文本整条拦掉了
	const verdict = classify('{动作}，{再动作}，在{极限}的时候，{决定性一击}！', rules);
	assert.notEqual(verdict.level, 'blocked', '「决定性一击」被硬拦截 —— 单字正则回归了');
	// 单字只应降级标记（这里命中的是「性」），不该判死
	assert.equal(verdict.level, 'caution');
	assert.equal(verdict.hit, '性');
});

await test('「比如{A}，比如{B}」不该被「吻」误杀', () => {
	assert.equal(classify('比如{A}，比如{B}，比如{C}。', rules).level, 'safe');
});

await test('真高危词必须拦下', () => {
	for (const bad of ['像是一场{盛大的献祭}。', '只有{魔鬼}可以帮你', '否则只是…的尸体']) {
		assert.equal(classify(bad, rules).level, 'blocked', `漏拦：${bad}`);
	}
});

await test('单字只作降级标记', () => {
	const verdict = classify('他死了。', rules);
	assert.equal(verdict.level, 'caution');
	assert.equal(verdict.hit, '死');
});

await test('hardOnly 模式忽略降级标记（模板本身判定用）', () => {
	assert.equal(classify('他死了。', rules, { hardOnly: true }).level, 'safe');
	assert.equal(classify('一场{献祭}。', rules, { hardOnly: true }).level, 'blocked');
});

await test('词库过滤：长度、脏话、专名', () => {
	assert.ok(isLexiconWorthy('还行', rules));
	assert.ok(!isLexiconWorthy('这句话实在是太长了根本不可能进词库', rules, { maxLen: 14 }));
	assert.ok(!isLexiconWorthy('他妈的', rules), '脏话没被过滤');
	assert.ok(!isLexiconWorthy('路明非说', rules, { names: ['路明非'] }), '专名没被过滤');
});

console.log('\ntools/lib/ngram.mjs');

await test('护栏抓到逐字复现', async () => {
	const docs = await loadCorpus(corpusDir);
	const index = buildIndex(docs.map((d) => d.text).join('\n'), 12);
	const hits = findOverlaps(ORIGINAL, index, { minLen: 12 });
	assert.ok(hits.length > 0, '逐字原文没被抓到');
	assert.ok(hits[0].length >= 12);
});

await test('护栏**不**误报仿写（负例对照）', async () => {
	const docs = await loadCorpus(corpusDir);
	const index = buildIndex(docs.map((d) => d.text).join('\n'), 12);
	const imitation = '雨点打在铁皮上，一下，又一下。他把外套搭在肩上，想想还是穿上了。其实也没什么好想的。';
	const hits = findOverlaps(imitation, index, { minLen: 12 });
	assert.equal(hits.length, 0, `仿写被误报：${JSON.stringify(hits)}`);
});

await test('短重合不算违规（通用语言放行）', async () => {
	const docs = await loadCorpus(corpusDir);
	const index = buildIndex(docs.map((d) => d.text).join('\n'), 12);
	assert.equal(findOverlaps('雨下得很大', index, { minLen: 12 }).length, 0);
	assert.ok(findOverlaps('外面的雨下得很大，雨点敲着铁皮棚子', index, { minLen: 12 }).length > 0);
});

console.log('\ntools/distill.mjs');

await test('stats 写出可用统计文件', async () => {
	const out = path.join(root, 'stats.json');
	await cmdStats({ corpus: corpusDir, out });
	const stats = JSON.parse(fs.readFileSync(out, 'utf8'));
	assert.ok(stats.rhythm.avgSentenceLen > 0);
	assert.ok(stats.punctuation.grade, '缺少定性档位');
});

await test('保真门：正确定位通过 / 定位错误改判 / 编造剔除', async () => {
	fs.writeFileSync(path.join(digestDir, 'chunk-01.json'), JSON.stringify({
		chapterIndex: [{ no: '001', title: 'a', emotions: ['平静/倦怠'], gist: '测试' }],
		emotionSamples: [
			{ emotion: '平静/倦怠', quote: ORIGINAL, technique: '测试', chapter: '001' },   // 正确定位
			{ emotion: '平静/倦怠', quote: OTHER, technique: '测试', chapter: '001' },      // 错位：实际在 002
			{ emotion: '平静/倦怠', quote: FABRICATED, technique: '测试', chapter: '001' }, // 编造
		],
		templates: [
			{ emotion: '平静/倦怠', pattern: '{动作A}，{动作B}。', example: '他走了。', slots: [] },
			{ emotion: '平静/倦怠', pattern: '像是一场{盛大的献祭}。', example: '献祭', slots: [] },
		],
		lexicon: { 口语: ['还行', '他妈的'] },
		risks: ['测试风险'],
	}, null, 2), 'utf8');

	const out = path.join(root, 'style-profile.json');
	await cmdMerge({ digests: digestDir, corpus: corpusDir, out, samples: 1, source: '测试语料' });
	const profile = JSON.parse(fs.readFileSync(out, 'utf8'));

	assert.equal(profile.provenance.emotionSamples, 2, '保真门结果不对');
	assert.equal(profile.provenance.reattributed, 1, '错位引用没被改判');
	// 编造的引用必须消失
	const allQuotes = JSON.stringify(profile);
	assert.ok(!allQuotes.includes(FABRICATED.slice(0, 20)), '编造的引用泄漏进了产出');
	// 硬拦截的模板必须剔除，正常模板必须保留
	assert.equal(profile.provenance.templatesKept, 1);
	assert.equal(profile.provenance.templatesBlocked, 1);
	assert.ok(profile.templates[0].pattern.includes('{动作A}'));
	// 词库里的脏话必须被过滤
	assert.ok(!(profile.lexiconByStyle['口语'] ?? []).includes('他妈的'), '词库里的脏话没被过滤');
	assert.ok((profile.lexiconByStyle['口语'] ?? []).includes('还行'), '正常词条被误杀');
	assert.ok(profile.rhythm.avgSentenceLen > 0, '产出的档案缺少节奏数据');
	assert.ok(profile.samples.length <= 1);
});

fs.rmSync(root, { recursive: true, force: true });

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
