/**
 * `@deepseek-ai/schemastery` 的测试桩件。
 * 只实现本插件 Config 用到的链式方法，不模拟校验语义。
 */

function chain(kind, extra = {}) {
	const node = { kind, ...extra };
	node.default = (value) => chain(kind, { ...extra, defaultValue: value });
	node.volatile = () => chain(kind, { ...extra, isVolatile: true });
	node.required = () => chain(kind, { ...extra, isRequired: true });
	node.int = () => chain(kind, { ...extra, isInt: true });
	return node;
}

const z = {
	object: (shape) => ({ kind: 'object', shape }),
	boolean: () => chain('boolean'),
	string: () => chain('string'),
	number: () => chain('number'),
	const: (value) => chain('const', { value }),
	union: (list) => chain('union', { list }),
};

export default z;
