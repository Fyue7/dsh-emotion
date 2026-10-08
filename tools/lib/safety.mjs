/**
 * 内容安全过滤。
 *
 * 这里有一条**从实战里学到的**设计原则：
 *
 *   单字符正则会造成大量误杀。
 *
 * 我第一版把「性」「吻」「睡」「腰」这类单字当硬拦截词，结果
 * 「{决定性一击}」命中「性」、「比如{A}，比如{B}」命中「吻」——
 * 17 条被拦的模板里只有 4 条真该拦。
 *
 * 所以本模块分三级，且**硬拦截只用多字、无歧义的词**：
 *
 *   blocked  —— 硬拦截（多字、无歧义词）。只在**模板本身**上判定，
 *               不看示例文本（示例只是证据，不会进提示词）。
 *   caution  —— 降级标记。单字词在这里，允许使用但会被标出来。
 *   safe     —— 其余。
 *
 * 默认词表面向中文。其他语言请通过 --rules 传入自己的词表。
 */

/** 硬拦截：多字、无歧义词。 */
export const DEFAULT_HARD = [
	// 自毁与牺牲
	'自杀', '自尽', '寻死', '去死', '献祭', '牺牲', '灵魂', '契约', '用命换', '以命换',
	// 宗教与仪式
	'魔鬼', '恶魔', '弥撒', '圣餐', '福音', '圣经', '神父', '教堂', '礼拜', '哈利路亚',
	'轮回', '转世', '咒语', '念咒',
	// 身体与性
	'赤身', '裸体', '上床', '配种', '卖淫', '妓女',
	// 具体伤害动作
	'剜', '割喉', '白骨', '吸血', '爆血', '龙化', '屠龙', '轰杀', '爆头', '斩首', '尸体', '血肉', '残肢',
];

/** 降级标记：单字或高歧义词。允许使用，但标出来供人工判断。 */
export const DEFAULT_CAUTION = [
	'死', '杀', '血', '鬼', '魔', '刀', '枪', '战', '尸', '葬', '墓', '坟',
	'痛', '哭', '神', '圣', '睡', '吻', '床', '胸', '腰', '腿', '性', '命',
];

/** 脏话：只用于**词库**过滤（词库要的是助手能用的表达，不是原作品台词）。 */
export const DEFAULT_PROFANITY = [
	'操', '妈的', '你妹', '傻逼', '混账', '浑蛋', '尼玛', '放屁', '狗屎', '滚蛋', '该死', '见鬼',
];

function toRegex(list) {
	if (!list || !list.length) return null;
	const escaped = list.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
	return new RegExp(escaped.join('|'));
}

export function createRules(overrides = {}) {
	const hard = overrides.hard ?? DEFAULT_HARD;
	const caution = overrides.caution ?? DEFAULT_CAUTION;
	const profanity = overrides.profanity ?? DEFAULT_PROFANITY;
	return {
		hard,
		caution,
		profanity,
		hardRe: toRegex(hard),
		cautionRe: toRegex(caution),
		profanityRe: toRegex(profanity),
	};
}

/**
 * 判定一段文本。
 *
 * @param {string} text 要判定的文本
 * @param {object} rules createRules() 的产物
 * @param {{ hardOnly?: boolean }} [options] hardOnly=true 时只判硬拦截
 *        （用于「模板本身」—— 示例不该决定模板生死）
 */
export function classify(text, rules, options = {}) {
	const s = String(text ?? '');
	const hardHit = rules.hardRe?.exec(s);
	if (hardHit) return { level: 'blocked', hit: hardHit[0] };
	if (options.hardOnly) return { level: 'safe', hit: null };
	const cautionHit = rules.cautionRe?.exec(s);
	if (cautionHit) return { level: 'caution', hit: cautionHit[0] };
	return { level: 'safe', hit: null };
}

/** 是否含脏话（词库专用）。 */
export function hasProfanity(text, rules) {
	return Boolean(rules.profanityRe?.test(String(text ?? '')));
}

/**
 * 词库条目过滤：长度上限 + 无脏话 + 不含指定专名。
 *
 * @param {{ maxLen?: number, names?: string[] }} [options]
 */
export function isLexiconWorthy(text, rules, options = {}) {
	const { maxLen = 14, names = [] } = options;
	const s = String(text ?? '').trim();
	if (!s || s.length > maxLen) return false;
	if (classify(s, rules).level === 'blocked') return false;
	if (hasProfanity(s, rules)) return false;
	for (const name of names) if (name && s.includes(name)) return false;
	return true;
}
