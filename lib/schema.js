/**
 * dsh-emotion · schema 容错层
 *
 * 会话投影的 `stateSchema` / `wire.viewSchema` 是 **zod** schema（宿主自带 zod 4.6.5）。
 * 但插件包被 pnpm 以 `file:` **复制**进 profile 的 node_modules，
 * `import 'zod'` 能否解析取决于 profile 的 hoist 结果 —— 不保证。
 *
 * 因此这里做容错：zod 可用就用真 schema；不可用则退化为一个只做浅校验的 shim，
 * **保证插件在 zod 缺失时仍能加载**（宁可少一层校验，也不要整个插件起不来）。
 * 降级会在 `/mood` 里如实报告。
 */

let z = null;
let zodError = null;

try {
	const mod = await import('zod');
	z = mod.z ?? mod.default ?? null;
} catch (error) {
	zodError = error;
}

/** zod 是否可用。 */
export const hasZod = z !== null;

/** 加载失败原因（无则 null），供 /mood 诊断输出。 */
export const zodLoadError = zodError;

/** 降级 shim：浅校验「是对象且含全部必需键」。 */
function shim(expectedKeys) {
	return {
		parse(value) {
			if (value === null || typeof value !== 'object' || Array.isArray(value)) {
				throw new TypeError('emotion: schema 降级校验失败 —— 状态不是对象');
			}
			for (const key of expectedKeys) {
				if (!(key in value)) {
					throw new TypeError(`emotion: schema 降级校验失败 —— 缺少键 ${key}`);
				}
			}
			return value;
		},
		emotionShim: true,
	};
}

/**
 * 构造一个 object schema。
 * @param {string[]} expectedKeys 降级 shim 用的必需键列表
 * @param {(zod: any) => any} build 使用真 zod 时的构造器
 */
export function objectSchema(expectedKeys, build) {
	if (z) {
		try {
			return build(z);
		} catch (error) {
			zodError = error;
		}
	}
	return shim(expectedKeys);
}
