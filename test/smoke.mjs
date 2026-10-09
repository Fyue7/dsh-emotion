/**
 * dsh-emotion 集成冒烟测试：用桩件模拟宿主，验证注册形状与命令族。
 *   node test/smoke.mjs
 *
 * 不做真实装载（那要在 GUI 里重启验证），但能挡住绝大多数「形状写错」的低级错误。
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// 注意：register 的第二个参数是「父 URL」，传文件 URL 会让相对说明符解析错位。
// 直接把加载钩子解析成绝对 file URL 更稳。
register(new URL('./stub-loader.mjs', import.meta.url).href);

const plugin = await import('../lib/index.js');
const prompt = await import('../lib/prompt.js');
const state = await import('../lib/state.js');

let passed = 0;
let failed = 0;

function check(label, fn) {
	try {
		fn();
		passed += 1;
		console.log(`  ✓ ${label}`);
	} catch (error) {
		failed += 1;
		console.log(`  ✗ ${label}\n      ${error.message}`);
	}
}

/** 造一个足够真实的假宿主 ctx。 */
function makeCtx() {
	const captured = {
		sections: [],
		contexts: [],
		projections: [],
		listeners: [],
		commands: [],
	};

	const fakeSession = { id: 'sess-1', header: { id: 'sess-1' } };
	let currentState = state.initState();

	const commandsCtx = {
		commands: {
			register(definition) {
				captured.commands.push(definition);
				return () => {};
			},
		},
	};

	const ctx = {
		systemPrompt: {
			section(section) {
				captured.sections.push(section);
				return () => {};
			},
			context(entry) {
				captured.contexts.push(entry);
				return () => {};
			},
		},
		sessionProjections: {
			register(definition) {
				captured.projections.push(definition);
				return () => {};
			},
			stateOf(session, key) {
				if (key !== 'emotion') return undefined;
				return session === fakeSession ? currentState : undefined;
			},
		},
		on(type, listener) {
			captured.listeners.push({ type, listener });
		},
		inject(deps, callback) {
			if (deps.includes('commands')) callback(commandsCtx);
		},
		effect(fn) {
			return fn();
		},
		_fake: { captured, fakeSession, setState: (s) => { currentState = s; } },
	};

	return ctx;
}

console.log('\n注册形状');

const ctx = makeCtx();
plugin.apply(ctx, { enabled: true, intensity: 'mid', styleBias: 'balanced', styleProfile: 'auto' });

const captured = ctx._fake.captured;

check('导出 name / inject 正确', () => {
	assert.strictEqual(plugin.name, 'emotion');
	assert.deepEqual(plugin.inject, ['systemPrompt', 'sessionProjections']);
});

check('规则进系统提示词，状态与实况进 runtime-context，位置正确', () => {
	assert.strictEqual(captured.sections.length, 1, '系统提示词里只该有静态规则段');
	assert.strictEqual(captured.contexts.length, 2, '状态段与实况段都该走 runtime-context');
	assert.strictEqual(captured.sections[0].name, prompt.RULES_SECTION);
	assert.strictEqual(captured.sections[0].order, 2);
	assert.strictEqual(typeof captured.sections[0].text, 'function');
	assert.strictEqual(captured.contexts[0].name, prompt.STATE_CONTEXT);
	assert.strictEqual(captured.contexts[0].order, prompt.STATE_CONTEXT_ORDER);
	assert.strictEqual(captured.contexts[1].name, prompt.SCENE_CONTEXT);
	assert.strictEqual(captured.contexts[1].order, prompt.SCENE_CONTEXT_ORDER);
	for (const entry of captured.contexts) {
		assert.ok(entry.order > 120, `${entry.name} 应排在宿主自用 context 位之后`);
		assert.strictEqual(typeof entry.text, 'function');
	}
});

check('注册了情绪投影，definition 完整', () => {
	assert.strictEqual(captured.projections.length, 1);
	const def = captured.projections[0];
	assert.strictEqual(def.key, 'emotion');
	assert.strictEqual(def.stateVersion, state.STATE_VERSION);
	assert.ok(def.stateSchema && typeof def.stateSchema.parse === 'function');
	assert.deepEqual(def.init(), state.initState());
	const s0 = state.initState();
	assert.strictEqual(def.apply(s0, { type: 'user/message', data: {} }), s0, '无关事件未保持同一引用');
	assert.ok(def.wire && typeof def.wire.view === 'function', '缺少 wire 视图（客户端读不到）');
	assert.ok(def.wire.viewSchema && typeof def.wire.viewSchema.parse === 'function');
});

check('wire.view 复用引用（状态未变时不触发发布）', () => {
	const def = captured.projections[0];
	const s0 = state.initState();
	assert.strictEqual(def.wire.view(s0), def.wire.view(s0));
});

check('wire.view 输出客户端需要的字段', () => {
	const def = captured.projections[0];
	const view = def.wire.view({ ...state.initState(), mood: 20, turn: 3 });
	for (const key of ['mood', 'energy', 'turn', 'label', 'cause', 'intensity']) {
		assert.ok(key in view, `视图缺字段 ${key}`);
	}
});

check('注册了 /mood 命令', () => {
	assert.strictEqual(captured.commands.length, 1);
	assert.strictEqual(captured.commands[0].name, 'mood');
	assert.strictEqual(typeof captured.commands[0].handler, 'function');
});

check('监听 session/event 仅用于跨会话亲密度', () => {
	assert.strictEqual(captured.listeners.length, 1);
	assert.strictEqual(captured.listeners[0].type, 'session/event');
});

console.log('\n提示词段行为');

const rulesSection = captured.sections.find((s) => s.name === prompt.RULES_SECTION);
const stateContext = captured.contexts.find((c) => c.name === prompt.STATE_CONTEXT);
const sceneContext = captured.contexts.find((c) => c.name === prompt.SCENE_CONTEXT);

check('规则段有内容，技术约束默认是 loose', () => {
	const text = rulesSection.text();
	assert.ok(text.length > 200, '规则段过短');
	// 默认 loose：朴素约束被禁掉，换成「讲法放开、信息不省」
	assert.match(text, /技术内容不再要求朴素/);
	assert.match(text, /信息不省/);
	assert.ok(!text.includes('留白'), 'loose 模式又混进了「留白」—— 那会砍信息量');
	assert.ok(!text.includes('只约束技术产物本身'), '默认模式下朴素约束仍在');
});

check('规则段吸收了风格档案（笔法块 + 助手样例）', () => {
	const text = rulesSection.text();
	assert.match(text, /笔法参考/, '未注入笔法块 —— 风格档案没被加载');
	assert.match(text, /平均句长约/, '缺少节奏量化');
	assert.match(text, /目标样例/, '缺少助手回复样例 —— few-shot 场景错位等于没给样例');
});

check('规则段无插值组', () => {
	assert.ok(!prompt.hasInterpolationGroup(rulesSection.text()));
});

check('状态段：无会话时返回空串', () => {
	assert.strictEqual(stateContext.text({}), '');
	assert.strictEqual(stateContext.text(undefined), '');
});

check('状态段：有会话时渲染状态', () => {
	ctx._fake.setState({ ...state.initState(), mood: 24, energy: 66, turn: 5, lastKind: 'tool-ok' });
	const text = stateContext.text({ agent: { session: ctx._fake.fakeSession } });
	assert.match(text, /当前情绪状态/);
	assert.match(text, /第 5 轮/);
	assert.match(text, /强度 \d\/3/);
});

check('实况段：无会话 / 无素材时返回空串', () => {
	assert.strictEqual(sceneContext.text({}), '');
	assert.strictEqual(sceneContext.text(undefined), '');
	ctx._fake.setState(state.initState());
	assert.strictEqual(sceneContext.text({ agent: { session: ctx._fake.fakeSession } }), '');
});

check('实况段：有素材时只陈述事实', () => {
	ctx._fake.setState({
		...state.initState(),
		toolCalls: 12,
		files: ['lib/state.js', 'lib/prompt.js'],
		failed: 2,
	});
	const text = sceneContext.text({ agent: { session: ctx._fake.fakeSession } });
	assert.match(text, /本轮实况/);
	assert.match(text, /这一轮调了 12 次工具/);
	assert.match(text, /lib\/state\.js、lib\/prompt\.js/);
	assert.match(text, /2 次没成功/);
	assert.ok(!prompt.hasInterpolationGroup(text));
});

console.log('\n命令族');

const handler = captured.commands[0].handler;
const invocation = (rawInput) => ({ commandId: 'c1', agent: { session: ctx._fake.fakeSession, id: 'sess-1' }, rawInput, attachments: [], signal: new AbortController().signal });

check('/mood 输出状态与配置', () => {
	const result = handler(invocation(''));
	assert.strictEqual(result.kind, 'success');
	assert.match(result.text, /情绪插件：已开启/);
	assert.match(result.text, /风格档案：/);
	assert.match(result.text, /schema 校验/);
	assert.match(result.text, /本轮实况：调了/);
});

check('/mood why 打印实际注入文本', () => {
	const result = handler(invocation('why'));
	assert.strictEqual(result.kind, 'success');
	assert.match(result.text, /emotion:rules/);
	assert.match(result.text, /emotion:state/);
	assert.match(result.text, /emotion:scene/);
});

check('/mood off 后三个段都为空', () => {
	const result = handler(invocation('off'));
	assert.strictEqual(result.kind, 'success');
	assert.strictEqual(rulesSection.text(), '', 'off 之后规则段仍在注入');
	assert.strictEqual(stateContext.text({ agent: { session: ctx._fake.fakeSession } }), '', 'off 之后状态段仍在注入');
	assert.strictEqual(sceneContext.text({ agent: { session: ctx._fake.fakeSession } }), '', 'off 之后实况段仍在注入');
});

check('/mood on 恢复注入', () => {
	handler(invocation('on'));
	assert.ok(rulesSection.text().length > 200, 'on 之后规则段没回来');
});

check('/mood plain=on 切回朴素模式，plain=off 放开', () => {
	const on = handler(invocation('plain=on'));
	assert.strictEqual(on.kind, 'success');
	assert.match(rulesSection.text(), /只约束技术产物本身/);

	const off = handler(invocation('plain=off'));
	assert.strictEqual(off.kind, 'success');
	assert.match(rulesSection.text(), /技术内容不再要求朴素/);

	const bad = handler(invocation('plain=maybe'));
	assert.strictEqual(bad.kind, 'error');
	assert.match(bad.text, /只接受 on\|off/);
});

check('/mood 状态文本报出技术内容模式', () => {
	const result = handler(invocation(''));
	assert.match(result.text, /技术内容=/);
});

check('改配置项合法值与非法值', () => {
	const good = handler(invocation('intensity=high style=outgoing profile=off'));
	assert.strictEqual(good.kind, 'success');
	assert.match(good.text, /intensity=high/);
	assert.match(good.text, /styleBias=outgoing/);

	const bad = handler(invocation('intensity=turbo'));
	assert.strictEqual(bad.kind, 'error');
	assert.match(bad.text, /只接受 low\|mid\|high/);

	handler(invocation('intensity=mid style=balanced profile=auto'));
});

check('未识别的键被拒绝且不抛错', () => {
	const result = handler(invocation('nonsense=1'));
	assert.strictEqual(result.kind, 'error');
	assert.match(result.text, /未识别\/不合法/);
});

check('mood= 写入本会话临时调整量并影响状态段', () => {
	const result = handler(invocation('mood=50'));
	assert.strictEqual(result.kind, 'success');
	ctx._fake.setState({ ...state.initState(), mood: 0, turn: 2 });
	const text = stateContext.text({ agent: { session: ctx._fake.fakeSession } });
	assert.match(text, /心情 \+50/, '手动调整量未生效');
});

check('/mood reset 清掉临时调整量', () => {
	handler(invocation('reset'));
	ctx._fake.setState({ ...state.initState(), mood: 0, turn: 2 });
	const text = stateContext.text({ agent: { session: ctx._fake.fakeSession } });
	assert.match(text, /心情 0/);
});

console.log('\n配置形态容错（普通值 / .get() 引用）');

check('配置为 .get() 引用时同样生效', () => {
	const ctx2 = makeCtx();
	const ref = (v) => ({ get: () => v });
	plugin.apply(ctx2, {
		enabled: ref(false),
		intensity: ref('low'),
		styleBias: ref('restrained'),
		styleProfile: ref('auto'),
	});
	const rules = ctx2._fake.captured.sections.find((s) => s.name === prompt.RULES_SECTION);
	assert.strictEqual(rules.text(), '', '配置引用形态下 enabled=false 未生效');
});

check('配置缺失时回落默认（enabled=true）', () => {
	const ctx3 = makeCtx();
	plugin.apply(ctx3, undefined);
	const rules = ctx3._fake.captured.sections.find((s) => s.name === prompt.RULES_SECTION);
	assert.ok(rules.text().length > 200, '缺配置时没有回落到默认开启');
});

check('配置引用抛错时不崩，回落默认', () => {
	const ctx4 = makeCtx();
	plugin.apply(ctx4, { enabled: { get() { throw new Error('boom'); } } });
	const rules = ctx4._fake.captured.sections.find((s) => s.name === prompt.RULES_SECTION);
	assert.ok(rules.text().length > 200, '配置读取抛错后未回落默认');
});

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
