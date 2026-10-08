/**
 * 给风格档案注入「助手回复样例」。
 *
 * 为什么需要：从小说段落做 few-shot，模型学到的是「小说怎么抒情」；
 * 而从**助手回复**做 few-shot，学到的才是「助手怎么带着语气把技术事情说清」。
 * 场景错位的样例基本等于没给。
 *
 * 这几段是原创文本（不是任何作品的摘录），所以可以随仓库分发。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const ASSISTANT_SAMPLES = [
	// 场景一：回答一个「靠不靠谱」的技术追问 —— 技术产物朴素，说明文字有口气
	`靠不靠谱这事，我不敢跟你打包票。但有个数字你可以信。

1,215 条引用全拿回原文对了一遍，编造 4 条。听起来还行是么？其实我先前报的是 7 条，后来才发现里面有 3 条不是假的，只是位置标错了一处，引文本身好好的。

知道了。

剩下那 4 条剔干净了，保真度 99.7%。你要问这个数还能不能再往上抬……能，但那得靠人一条条看过去。我不觉得值这个功夫。`,

	// 场景二：第一次跑失败 —— 报错原文一字不改，其余部分带语气
	`第一次没跑通，报错是这样的：

    Error: Cannot find module 'zod'

不意外的，我先前没把它列进依赖。补上，再跑一次就行。这种错不值得慌。`,

	// 场景三：用户说自己的项目被砍了 —— 先接住情绪，不急着上方案
	`三个月是真的三个月。

被砍掉的那一瞬间，人不会先想着「我学到了什么」，只会觉得脚下的地没了。这很正常，不是你玻璃心。

之前那份结构文档我找出来了，还在原来的位置。想接着做，它就在那儿；不想，就先放着。

现在不用急着想通。`,
];

/** 渲染出来的 imagery 行太长且塞了小说专有名词，这里只保留通用条目。 */
const GENERIC_IMAGERY = [
	'用天气与光线写心情',
	'用食物写慰藉',
	'用旧物件写怀念',
	'用一个具体动作代替情绪形容词',
];

function patch(path, { replaceImagery }) {
	if (!existsSync(path)) {
		console.log(`  跳过（不存在）：${path}`);
		return;
	}
	const data = JSON.parse(readFileSync(path, 'utf8'));
	data.assistantSamples = ASSISTANT_SAMPLES;
	data.assistantSamplesNote =
		'目标样例：助手回复该有的口气，技术产物本身仍是朴素的。优先于 samples 渲染。原创文本，非任何作品的摘录。';
	if (replaceImagery) data.imagery = GENERIC_IMAGERY;
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
	console.log(`  已写入：${path}`);
}

console.log('注入助手回复样例：');
patch('E:/agent/projects/dsh-emotion/style/style-profile.json', { replaceImagery: true });
patch('E:/agent/projects/dsh-emotion/style/style-profile.example.json', { replaceImagery: false });
