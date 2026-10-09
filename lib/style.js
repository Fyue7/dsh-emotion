/**
 * dsh-emotion · 风格档案加载与渲染
 *
 * 探测顺序：
 *   1. `$DSH_HOME/dsh-emotion/style-profile.json`  （用户可覆盖）
 *   2. 插件自带 `style/style-profile.json`          （随包默认）
 *
 * 缺失时**必须优雅降级**：只注入情绪规则，不注入声线要求，绝不让插件加载失败。
 *
 * ── v0.4 的一处方向修正 ─────────────────────────────────────────────
 * 旧版把两块样例做成二选一，且**助手样例优先**：一旦有助手样例，小说段落根本不渲染。
 * 理由是「小说段落教的是小说怎么抒情，不是助手怎么把技术事说清」。那个取舍是错的：
 * 要的是**作者的文风**常驻，而不是一套中性的助手腔末梢再挂一点情绪。
 *
 * 现在两块都渲染，分工是：
 *   形状（narratorVoice.shapes）→ 主体，可执行的写法
 *   禁用（narratorVoice.banned）→ 那本语料里不能迁移的部分，来自蒸镏报告自己的标注
 *   助手样例 → 「同一套声线落在技术活上是什么样」的示范，只留两条
 *   原文语感样例 → 目标语感本身，放最后（近因），并标注只借语感
 * 情绪不再是文风的开关，只决定这份情绪露多少。
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

/** styleBias → 注入几段原文语感样例。默认只给一段：形状清单才是主体，
 *  而且档案里的原文段落可能带原著专有名词（人名、组织名），少给一段就少一分回声风险。 */
const SAMPLE_COUNT = { restrained: 1, balanced: 1, outgoing: 2 };

/** 技术场合的示范条数：留两条就够，多了会把声线拽回中性助手腔。 */
const ASSISTANT_SAMPLE_COUNT = 2;

/** 原文语感样例的字数上限：够听话感，又不至于让模型顺手抄走一整段。 */
const SOURCE_SAMPLE_CHARS = 120;

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
 * 把风格档案渲染成提示词里的一段「声线」。
 *
 * 这是**常驻**层：进系统提示词的静态段，任何话题、任何情绪档位都不变。
 *
 * @param {object} profile 档案对象
 * @param {'restrained'|'balanced'|'outgoing'} [styleBias] 决定语感样例条数
 * @param {{ plainTechnical?: boolean }} [options] 决定边界那条怎么写
 */
export function renderStyle(profile, styleBias = 'balanced', options = {}) {
	if (!profile) return '';

	const loose = options.plainTechnical === false;
	const voice = profile.narratorVoice ?? {};

	const lines = [];
	lines.push('[声线 · 你的写法，任何话题、任何情绪档位都不变]');
	lines.push('这不是可选的风格建议，是你说话的方式本身。情绪只决定这份情绪露多少，不换写法。');

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

	// 声线的形状：主体。这些是可以照着做的动作，不是感觉描述。
	const shapes = voice.shapes ?? [];
	if (shapes.length) {
		lines.push('');
		lines.push('[写法]');
		for (const shape of shapes.slice(0, 16)) lines.push(`- ${brief(shape, 130)}`);
	}

	const directives = profile.styleDirectives ?? profile.emotionStrategy ?? [];
	const imagery = profile.imagery ?? [];
	if (!shapes.length) {
		// 降级路径：老档案没有 narratorVoice，就还按老样子渲染 directives 与意象域。
		// 反过来，有 shapes 时**不再渲染这两样** —— 它们是同一批内容的另一种说法，
		// 一起渲染会在同一段里出现两次「越低落越要开个玩笑」，白占提示词还显得潦草。
		for (const d of directives.slice(0, 6)) lines.push(`- ${brief(d)}`);
		if (imagery.length) lines.push(`- 常用意象域：${imagery.slice(0, 4).map((x) => brief(x, 30)).join('；')}`);
	}

	const tics = profile.verbalTics ?? [];
	if (tics.length) lines.push(`- 口头禅式短词（可少量取用）：${tics.slice(0, 12).join('、')}`);

	const address = profile.addressForms ?? {};
	if (address.user || address.self) {
		lines.push(`- 称呼：对用户用「${address.user ?? '你'}」，自称「${address.self ?? '我'}」。`);
	}
	if (address.narratorToReader) lines.push(`- ${brief(address.narratorToReader, 130)}`);

	// 禁用清单来自语料自己的标注：那本小说里不能迁移的部分。
	const banned = voice.banned ?? [];
	if (banned.length) {
		lines.push('');
		lines.push('[这套声线里不许出现的东西]');
		for (const item of banned.slice(0, 10)) lines.push(`- ${brief(item, 90)}`);
	}

	// 技术场合的示范：同一套声线落在报错、追问这些场景上是什么样。
	// 条数刻意压到两条 —— 这几段越长越像通用助手腔，会把声线拽回中间。
	const assistantSamples = (profile.assistantSamples ?? []).slice(0, ASSISTANT_SAMPLE_COUNT);
	if (assistantSamples.length) {
		lines.push('');
		lines.push('[同一套声线用在技术活上的样子 · 示范，不是范本腔]');
		assistantSamples.forEach((s, i) => {
			lines.push(`--- 示范 ${i + 1} ---`);
			lines.push(briefMultiline(s, 420));
		});
	}

	// 目标语感本身，放最后（近因）。原文摘句，所以标注写得硬。
	const take = SAMPLE_COUNT[styleBias] ?? 2;
	const samples = (profile.samples ?? []).slice(0, take);
	if (samples.length) {
		lines.push('');
		lines.push('[目标语感 · 只借语感，严禁照抄或改写复用]');
		lines.push('下面几段是这套写法的极限样子，读它们的节奏与收束方式，不要搬句子。');
		lines.push('样例里出现的专有名词（人名、地名、组织名）一个字都不许进你的回复。');
		samples.forEach((s, i) => {
			lines.push(`--- 语感 ${i + 1} ---`);
			lines.push(briefMultiline(s, SOURCE_SAMPLE_CHARS));
		});
	}

	if (!loose) {
		lines.push('');
		lines.push('[边界] 代码、命令、报错原文、参数、数字照抄，不加修饰；声线只落在说明文字上。');
	}

	return lines.join('\n');
}
