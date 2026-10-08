#!/usr/bin/env node
/**
 * verdict —— 输出侧护栏：检查一段文本有没有成段复现语料原文。
 *
 * 用法：
 *   node tools/verdict.mjs --corpus <dir> --text "要检查的文本"
 *   node tools/verdict.mjs --corpus <dir> <file...>
 *   node tools/verdict.mjs --corpus <dir> < file        （从 stdin 读）
 *
 * 选项：
 *   --min-len <n>   重合长度阈值（默认 12）
 *   --json          输出 JSON
 *
 * 退出码：0 = 通过，1 = 有违规重合，2 = 参数错误。
 *
 * 为什么默认 12 个字符：短的重合是通用语言（「我靠」「不知道」），不该算违规。
 * 在一个 65 万字的语料上实测，12-gram 有 99.8% 只出现一次 ——
 * **起作用的判据就是长度**，不是相似度。
 */

import { readFile } from 'node:fs/promises';

import { loadCorpus } from './lib/corpus.mjs';
import { buildIndex, findOverlaps } from './lib/ngram.mjs';

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

async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString('utf8');
}

const args = parseArgs(process.argv.slice(2));
const corpusDir = args.corpus;

if (!corpusDir || corpusDir === true) {
	console.error('错误：缺少 --corpus <目录>');
	process.exit(2);
}

const minLen = Number(args['min-len'] ?? 12);
const docs = await loadCorpus(corpusDir);
if (!docs.length) {
	console.error(`错误：语料目录里没有文本文件：${corpusDir}`);
	process.exit(2);
}

const index = buildIndex(docs.map((d) => d.text).join('\n'), Math.min(12, minLen));

/** 待检内容：--text、若干文件，或 stdin。 */
const inputs = [];
if (typeof args.text === 'string') {
	inputs.push({ name: '(命令行文本)', text: args.text });
} else if (args._.length) {
	for (const path of args._) {
		inputs.push({ name: path, text: await readFile(path, 'utf8') });
	}
} else if (!process.stdin.isTTY) {
	inputs.push({ name: '(stdin)', text: await readStdin() });
} else {
	console.error('错误：没有要检查的内容（用 --text、文件参数，或 stdin）');
	process.exit(2);
}

let violations = 0;
const results = [];

for (const input of inputs) {
	const hits = findOverlaps(input.text, index, { minLen });
	if (hits.length) violations += hits.length;
	results.push({ name: input.name, hits });
}

if (args.json) {
	console.log(JSON.stringify({ corpus: corpusDir, corpusChars: index.chars, minLen, results }, null, 2));
} else {
	console.log(`语料：${corpusDir}（${index.chars.toLocaleString()} 字符）· 阈值 ${minLen} 字\n`);
	for (const result of results) {
		if (!result.hits.length) {
			console.log(`✅ ${result.name} —— 无违规重合`);
			continue;
		}
		console.log(`❌ ${result.name} —— ${result.hits.length} 处违规重合：`);
		for (const hit of result.hits.slice(0, 10)) {
			console.log(`   [${hit.length} 字] ${hit.span}`);
		}
		if (result.hits.length > 10) console.log(`   …还有 ${result.hits.length - 10} 处`);
	}
}

process.exit(violations ? 1 : 0);
