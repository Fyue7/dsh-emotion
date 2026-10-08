/**
 * dsh-emotion · 风格档案加载（设计文档 §9 接口）
 *
 * 探测顺序：
 *   1. `$DSH_HOME/dsh-emotion/style-profile.json`  （用户可覆盖）
 *   2. 插件自带 `style/style-profile.json`          （随包默认）
 *
 * 缺失时**必须优雅降级**：只注入情绪规则，不注入笔法要求，绝不让插件加载失败。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return null;
	}
}

/**
 * @param {{ homePath?: string }} [options]
 * @returns {{ profile: object, path: string } | null}
 */
export function loadStyleProfile(options = {}) {
	const candidates = [];
	if (options.homePath) candidates.push(join(options.homePath, 'style-profile.json'));
	// 真实档案优先；公开仓库里它被 .gitignore 排除，因此全新 clone 会落到格式示例上
	candidates.push(join(HERE, '..', 'style', 'style-profile.json'));
	candidates.push(join(HERE, '..', 'style', 'style-profile.example.json'));

	for (const path of candidates) {
		if (!existsSync(path)) continue;
		const data = readJson(path);
		if (data && typeof data === 'object') return { profile: data, path };
	}
	return null;
}

/** styleBias → 注入多少条语感样例（样例是 few-shot 的主体成本，绑到档位上）。 */
const SAMPLE_COUNT = { restrained: 1, balanced: 2, outgoing: 3 };

/** 取短标签；过长会污染提示词。 */
function brief(text, max = 90) {
	const s = String(text ?? '').replace(/\s+/g, ' ').trim();
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 多行截断：**保留换行**。
 *
 * 段落的断行本身就是笔法的一部分（短句单独成段是主要节奏手段），
 * 压成一行会把样例的节奏信息毁掉。
 */
function briefMultiline(text, max = 420) {
	const s = String(text ?? '')
		.split('\n')
		.map((line) => line.replace(/[ \t]+/g, ' ').trim())
		.filter(Boolean)
		.join('\n');
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 把风格档案渲染成提示词里的一段。
 *
 * 只借**节奏与策略**，不借内容：samples 明确标注「禁止照抄」。
 */
export function renderStyle(profile, styleBias = 'balanced') {
	if (!profile) return '';

	const lines = [];
	lines.push('[笔法参考 · 只借节奏，不借内容]');

	const rhythm = profile.rhythm ?? {};
	const bits = [];
	if (typeof rhythm.avgSentenceLen === 'number') bits.push(`平均句长约 ${rhythm.avgSentenceLen} 字`);
	if (typeof rhythm.medianSentenceLen === 'number') bits.push(`中位 ${rhythm.medianSentenceLen} 字`);
	if (typeof rhythm.shortSentenceRatio === 'number') {
		bits.push(`约 ${Math.round(rhythm.shortSentenceRatio * 100)}% 是 10 字以内的短句`);
	}
	if (typeof rhythm.longSentenceRatio === 'number') {
		bits.push(`约 ${Math.round(rhythm.longSentenceRatio * 100)}% 是 40 字以上的长句`);
	}
	if (bits.length) lines.push(`- 句子节奏：${bits.join('，')}。长短交替，不堆排比。`);

	const punct = profile.punctuation ?? {};
	if (punct.dash === 'rare') lines.push('- 停顿用省略号和短句，几乎不用破折号。');
	if (punct.ellipsis === 'frequent' || punct.ellipsis === 'occasional') {
		lines.push('- 省略号承担停顿，不靠感叹号堆情绪。');
	}

	const directives = profile.styleDirectives ?? profile.emotionStrategy ?? [];
	for (const d of directives.slice(0, 6)) lines.push(`- ${brief(d)}`);

	const imagery = profile.imagery ?? [];
	if (imagery.length) lines.push(`- 常用意象域：${imagery.slice(0, 4).map((x) => brief(x, 30)).join('；')}`);

	const tics = profile.verbalTics ?? [];
	if (tics.length) lines.push(`- 口头禅式短词（可少量取用）：${tics.slice(0, 12).join('、')}`);

	// 助手回复样例优先于小说段落。
	//
	// 为什么：从小说段落里模型学到的是「小说怎么抒情」，而从助手回复里学到的才是
	// 「助手怎么带着语气把技术事情说清楚」—— 后者才是我们要的目标分布。
	// 场景错位的 few-shot 基本等于没给样例。
	const assistantSamples = (profile.assistantSamples ?? []).slice(0, 3);
	if (assistantSamples.length) {
		lines.push('');
		lines.push('[目标样例 · 助手回复该有的口气，注意技术产物本身仍是朴素的]');
		assistantSamples.forEach((s, i) => {
			lines.push(`--- 样例 ${i + 1} ---`);
			lines.push(briefMultiline(s, 420));
		});
	}

	const take = SAMPLE_COUNT[styleBias] ?? 2;
	const samples = assistantSamples.length ? [] : (profile.samples ?? []).slice(0, take);
	if (samples.length) {
		lines.push('');
		lines.push('[语感样例 · 仅供体会节奏，严禁照抄或改写复用]');
		samples.forEach((s, i) => lines.push(`${i + 1}. ${brief(s, 160)}`));
	}

	return lines.join('\n');
}
