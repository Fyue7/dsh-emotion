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

check('注册了恰好两个提示词段，order 正确', () => {
	assert.strictEqual(captured.sections.length, 2);
	const byName = Object.fromEntries(captured.sections.map((s) => [s.name, s]));
	assert.ok(byName[prompt.RULES_SECTION], '缺少 rules 段');
	assert.ok(byName[prompt.STATE_SECTION], '缺少 state 段');
	assert.strictEqual(byName[prompt.RULES_SECTION].order, 2);
	assert.strictEqual(byName[prompt.STATE_SECTION].order, 10150);
	assert.strictEqual(typeof byName[prompt.RULES_SECTION].text, 'function');
	assert.strictEqual(typeof byName[prompt.STATE_SECTION].text, 'function');
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
const stateSection = captured.sections.find((s) => s.name === prompt.STATE_SECTION);

check('规则段有内容且硬约束的边界在技术产物上', () => {
	const text = rulesSection.text();
	assert.ok(text.length > 200, '规则段过短');
	assert.match(text, /只约束技术产物本身/);
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
	assert.strictEqual(stateSection.text({}), '');
	assert.strictEqual(stateSection.text(undefined), '');
});

check('状态段：有会话时渲染状态', () => {
	ctx._fake.setState({ ...state.initState(), mood: 24, energy: 66, turn: 5, lastKind: 'tool-ok' });
	const text = stateSection.text({ agent: { session: ctx._fake.fakeSession } });
	assert.match(text, /当前情绪状态/);
	assert.match(text, /第 5 轮/);
	assert.match(text, /强度 \d\/3/);
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
});

check('/mood why 打印实际注入文本', () => {
	const result = handler(invocation('why'));
	assert.strictEqual(result.kind, 'success');
	assert.match(result.text, /emotion:rules/);
	assert.match(result.text, /emotion:state/);
});

check('/mood off 后两个段都为空', () => {
	const result = handler(invocation('off'));
	assert.strictEqual(result.kind, 'success');
	assert.strictEqual(rulesSection.text(), '', 'off 之后规则段仍在注入');
	assert.strictEqual(stateSection.text({ agent: { session: ctx._fake.fakeSession } }), '', 'off 之后状态段仍在注入');
});

check('/mood on 恢复注入', () => {
	handler(invocation('on'));
	assert.ok(rulesSection.text().length > 200, 'on 之后规则段没回来');
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
	const text = stateSection.text({ agent: { session: ctx._fake.fakeSession } });
	assert.match(text, /心情 \+50/, '手动调整量未生效');
});

check('/mood reset 清掉临时调整量', () => {
	handler(invocation('reset'));
	ctx._fake.setState({ ...state.initState(), mood: 0, turn: 2 });
	const text = stateSection.text({ agent: { session: ctx._fake.fakeSession } });
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
