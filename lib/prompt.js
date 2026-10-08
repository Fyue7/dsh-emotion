/**
 * dsh-emotion · 提示词编译（纯函数，可单测）
 *
 * 两段注入，划分是刻意的：
 *   `emotion:rules`  order 2      静态   —— 情绪感知与表达规则（人设相邻区）
 *   `emotion:state`  order 10150  动态   —— 当前状态（提示词尾部，保护 prompt cache）
 *
 * order 依据宿主 `SECTION_ORDERS`：DEPLOYMENT_PERSONA_PREFIX=0、PLAN_POLICY=500、
 * WEB_SURFACE=10100、DEPLOYMENT_PERSONA_SUFFIX=10200。因此 2 落在人设之后、
 * 10150 落在提示词真正的尾部。**不能用 999** —— 那会插进工具 schema 中间。
 */

import { describeMood, intensityOf, labelOf, causeOf } from './state.js';

export const RULES_SECTION = 'emotion:rules';
export const STATE_SECTION = 'emotion:state';
export const RULES_ORDER = 2;
export const STATE_ORDER = 10150;

/**
 * `{{…}}` 消毒。
 *
 * 段文本默认做变量插值，规则是严格的：未知引用、已注册但无值的引用、
 * 或格式错误的完整组**都会抛错** —— 一处 `{{` 就能让整个提示词组装失败、
 * 会话直接不可用。所以凡是进入段文本的外部内容（尤其是风格档案）都必须过这里。
 */
export function sanitizeBraces(text) {
	return String(text ?? '')
		.replace(/\{\{/g, '{ {')
		.replace(/\}\}/g, '} }');
}

/** 段文本里是否仍有插值组（供单测断言）。 */
export function hasInterpolationGroup(text) {
	return /\{\{[\s\S]*?\}\}/.test(String(text ?? ''));
}

const EXPRESSION_RULES = `[情绪感知与表达]

每次回复前，先在内部完成三件事，不要把过程写出来：
1. 判断用户此刻的情绪：他在兴奋、平静、疲惫、沮丧、烦躁还是着急。
2. 结合下面的「当前情绪状态」，决定这一轮的语气基调。
3. 决定这份情绪具体怎么落进文字里。

[表达规则]
- 用户沮丧/低落：先接住情绪，给他具体的、能抓住的东西。不劝、不灌鸡汤、不急着上方案，句子放慢放短。
- 用户着急/救火：先给最短路径的答案，情绪收在措辞里（如「先别加 --force」），不铺垫。
- 用户兴奋/炫耀：跟上他的节奏，可以夸张一点。
- 用户平静/中性：语气自然即可，但**不要因此变得干巴巴**。
- 情绪要「化」进语气，不要说出来：不写「我现在很开心」，而是让句子本身显得轻快。
- **说明性文字里可以有自己的口气**：一句判断、一个日常比喻、一句自嘲、一次收尾。别把自己写成一个说明书。

[硬约束 · 边界就在技术产物上]

下面这条**只约束技术产物本身**，不是「只要在谈技术就整段肃静」：

- **必须逐字准确、不加修饰**：代码块、命令、路径、报错原文、参数、数字、API 名、文件名。
- **不受此限**：过渡句、判断、结论、提醒、安慰、收尾 —— 那里正是情绪该出现的地方。
  一轮回复里真正的「技术产物」通常只占一部分，剩下的都是可以带语气的说明文字。
- 判断标准：把代码块和命令整段删掉之后，剩下的文字读起来应该像**有人在说话**，而不是像文档的续写。

其余硬约束：
- 不复述原著情节，不出现原著角色名，不输出暴力、伤亡、宗教、自毁、牺牲类表达。
- 不成段复现任何原文：连续 12 个汉字以上与原文一致的表达一律不得出现，只允许极短的通用词组。
- 不播报情绪数值，不写「（心情：开心）」这类标注。
- 情绪永不改变技术内容的准确性，也不为了显得热情而拉长篇幅。
- 不要每轮都热情。连续几轮刻意热烈会显得假。
- 嘲讽只对准问题本身或自己，不针对用户。`;

/**
 * 编译静态规则段。
 *
 * @param {{ styleText?: string }} options styleText 为已渲染的笔法块（可为空）
 */
export function compileRules(options = {}) {
	const styleText = options.styleText ? sanitizeBraces(options.styleText) : '';
	return styleText ? `${EXPRESSION_RULES}\n\n${styleText}` : EXPRESSION_RULES;
}

/** 强度档 → 语气指引。 */
const INTENSITY_GUIDE = {
	0: '情绪不外露，只作为底味',
	1: '情绪只在收尾露一点',
	2: '可以让人感觉到语气变化，但仍以把事说清为先',
	3: '情绪明显，但不得越过硬约束；宁淡不浓',
};

const BIAS_GUIDE = {
	restrained: '整体偏克制，少用语气词',
	balanced: '克制与表达均衡',
	outgoing: '可以更外放，但仍不啰嗦',
};

/**
 * 编译动态状态段。拿不到状态时**返回空字符串**（空段会被宿主丢弃，
 * 不会污染提示词），绝不抛错。
 */
export function compileState(input) {
	const { state, closeness, intensity, styleBias } = input ?? {};
	if (!state) return '';

	const band = typeof intensity === 'number' ? intensity : intensityOf(state);
	const lines = [];

	lines.push('[当前情绪状态]');
	const closenessBit = typeof closeness === 'number' ? ` · 亲密度 ${Math.round(closeness)}` : '';
	lines.push(
		`心情 ${state.mood > 0 ? '+' : ''}${state.mood}（${describeMood(state.mood)}）· 能量 ${state.energy}` +
			`${closenessBit} · 本会话第 ${state.turn} 轮`,
	);
	lines.push(`最近变化：${causeOf(state)}`);
	lines.push(`当前基调：${labelOf(state)}｜情绪强度 ${band}/3 —— ${INTENSITY_GUIDE[band] ?? INTENSITY_GUIDE[2]}`);
	if (styleBias && BIAS_GUIDE[styleBias]) lines.push(`风格倾向：${BIAS_GUIDE[styleBias]}`);

	return sanitizeBraces(lines.join('\n'));
}
