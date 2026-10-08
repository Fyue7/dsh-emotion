/**
 * 测试用 ESM 解析钩子：把宿主提供的包映射到本地桩件。
 *
 * 这样插件源码保持 `import z from '@deepseek-ai/schemastery'` 的原样，
 * 不必为了测试改动生产代码，也不必在插件目录里塞假的 node_modules。
 */

const STUBS = new Map([
	['@deepseek-ai/schemastery', './stubs/schemastery.mjs'],
	['@deepseek-ai/dsh-home-paths', './stubs/dsh-home-paths.mjs'],
]);

export async function resolve(specifier, context, next) {
	const stub = STUBS.get(specifier);
	if (stub) {
		return { url: new URL(stub, import.meta.url).href, shortCircuit: true };
	}
	return next(specifier, context);
}
