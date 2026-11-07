import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import z from "@deepseek-ai/schemastery";
import { randomUUID } from "node:crypto";
import "node:async_hooks";
import "node:util/types";
//#region node_modules/.pnpm/@deepseek-ai+dsh-home-paths@0.2.2-alpha.3_@deepseek-ai+cordis@4.0.6-alpha.2/node_modules/@deepseek-ai/dsh-home-paths/lib/index.js
/**
* Shared filesystem path helpers for DeepSeek Harness user data.
*
* @module @deepseek-ai/dsh-home-paths
*/
/** Directory name for the default DeepSeek Harness home under the OS home. */
const DSH_HOME_DIR_NAME = ".dsh";
/** Environment variable that overrides the default DeepSeek Harness home. */
const DSH_HOME_ENV = "DSH_HOME";
/**
* Resolve the default DeepSeek Harness home using Node's platform path rules.
* @returns the absolute default harness home path.
*/
function defaultDshHome() {
	return join(homedir(), DSH_HOME_DIR_NAME);
}
/**
* Expand supported tilde prefixes against the operating-system home.
* @param path - configured path that may begin with `~`, `~/`, or `~\`.
* @returns the expanded path, or the original value when no supported prefix is present.
*/
function expandHomePath(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return path;
}
/**
* Resolve one user-data root from an explicit path, an environment override, and a default.
* @param configured - explicit path, which has highest precedence.
* @param env - environment mapping to read.
* @param envName - environment variable that overrides the default.
* @param fallback - default root, used when neither the explicit path nor the environment provides one.
* @returns the normalized absolute root.
*/
function resolveRoot(configured, env, envName, fallback) {
	const fromEnv = env[envName];
	return resolve(expandHomePath(configured ?? (fromEnv !== void 0 && fromEnv.trim().length > 0 ? fromEnv : fallback())));
}
/**
* Resolve the single-root DeepSeek Harness home.
*
* Precedence, highest first: an explicit configured path, `$DSH_HOME`, then
* `~/.dsh`. The harness keeps all user data under one root. An empty or
* whitespace-only `$DSH_HOME` is treated as unset, so a blank override never
* resolves the home to the current working directory.
* @param configured - explicit harness-home override, which has highest precedence.
* @param env - environment mapping used to read `DSH_HOME`.
* @returns the normalized absolute harness home path.
*/
function resolveDshHome(configured, env = process.env) {
	return resolveRoot(configured, env, DSH_HOME_ENV, defaultDshHome);
}
/**
* Join path segments onto the resolved DeepSeek Harness home.
* @param segments - path segments appended to the Harness home; an empty list returns the home itself.
* @returns the normalized absolute joined path.
*/
function dshHomePath(...segments) {
	return join(resolveDshHome(), ...segments);
}
//#endregion
//#region src/registry.ts
/**
* dsh-session-bridge 自维护会话登记表：记录 bridge 创建 / 恢复 / 发现过的会话
* （id、标题、cwd、workspace id、模型），落盘 ~/.dsh/session-bridge-registry.json，
* 使按名查找离线会话更可靠（离线会话标题不在 header 中）。
*/
const RECORD_FILE_NAME = "session-bridge-registry.json";
function recordFilePath() {
	return dshHomePath(RECORD_FILE_NAME);
}
/** 解析登记表文件（缺失/损坏 → 空表）。 */
async function readRecords() {
	try {
		const raw = await readFile(recordFilePath(), "utf8");
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((entry) => {
			const record = entry;
			return record !== null && typeof record === "object" && typeof record.sessionId === "string";
		}).map((record) => ({
			sessionId: record.sessionId,
			...typeof record.title === "string" ? { title: record.title } : {},
			...typeof record.cwd === "string" ? { cwd: record.cwd } : {},
			...typeof record.workspaceId === "string" ? { workspaceId: record.workspaceId } : {},
			...typeof record.provider === "string" ? { provider: record.provider } : {},
			...typeof record.model === "string" ? { model: record.model } : {},
			createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
			updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
			...typeof record.lastActivityAt === "number" ? { lastActivityAt: record.lastActivityAt } : {},
			source: record.source === "create" || record.source === "resume" || record.source === "discover" ? record.source : "discover"
		}));
	} catch {
		return [];
	}
}
var BridgeRegistry = class {
	records = /* @__PURE__ */ new Map();
	loaded = false;
	/** 加载登记表（幂等）。 */
	async load() {
		if (this.loaded) return;
		for (const record of await readRecords()) this.records.set(record.sessionId, record);
		this.loaded = true;
	}
	/** 读取快照（自动加载，best-effort）。 */
	async get(sessionId) {
		await this.load().catch(() => void 0);
		return this.records.get(sessionId);
	}
	/** 全部记录（自动加载；返回顺序=登记顺序）。 */
	async all() {
		await this.load().catch(() => void 0);
		return [...this.records.values()];
	}
	/** 新增 / 更新一条记录并落盘（best-effort，不阻塞调用方）。 */
	record(input) {
		const now = Date.now();
		const prior = this.records.get(input.sessionId);
		const next = {
			sessionId: input.sessionId,
			...input.title !== void 0 ? { title: input.title } : {},
			...input.cwd !== void 0 ? { cwd: input.cwd } : {},
			...input.workspaceId !== void 0 ? { workspaceId: input.workspaceId } : {},
			...input.provider !== void 0 ? { provider: input.provider } : {},
			...input.model !== void 0 ? { model: input.model } : {},
			createdAt: prior?.createdAt ?? now,
			updatedAt: now,
			...prior !== void 0 ? { lastActivityAt: prior.lastActivityAt } : {},
			source: input.source
		};
		this.records.set(input.sessionId, next);
		this.persist().catch((error) => {
			console.warn("[dsh-session-bridge] registry write failed:", error instanceof Error ? error.message : String(error));
		});
	}
	/** 上报一次活动（发消息 / 等待 / 读取）。永不覆盖登记的别名 title。 */
	touch(sessionId, fields) {
		const prior = this.records.get(sessionId);
		if (prior === void 0) return;
		this.records.set(sessionId, {
			...prior,
			...fields?.cwd !== void 0 ? { cwd: fields.cwd } : {},
			...fields?.workspaceId !== void 0 ? { workspaceId: fields.workspaceId } : {},
			updatedAt: Date.now(),
			lastActivityAt: Date.now()
		});
		this.persist().catch((error) => {
			console.warn("[dsh-session-bridge] registry write failed:", error instanceof Error ? error.message : String(error));
		});
	}
	/** 落盘（best-effort）。 */
	async persist() {
		const path = recordFilePath();
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify([...this.records.values()], null, 2), "utf8");
	}
};
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+cosmokit@1.8.7-alpha.2/node_modules/@deepseek-ai/cosmokit/lib/index.js
/** Return true when a value is `null` or `undefined`. */
function isNullable(value) {
	return value === null || value === void 0;
}
/** Define a non-enumerable writable property and return the object. */
function defineProperty(object, key, value) {
	return Object.defineProperty(object, key, {
		writable: true,
		value,
		enumerable: false
	});
}
/** Test values using `instanceof` with a `toStringTag` fallback. */
function is(type, value) {
	if (arguments.length === 1) return (value) => is(type, value);
	return type in globalThis && value instanceof globalThis[type] || Object.prototype.toString.call(value).slice(8, -1) === type;
}
function isArrayBufferLike(value) {
	return is("ArrayBuffer", value) || is("SharedArrayBuffer", value);
}
function isArrayBufferSource(value) {
	return isArrayBufferLike(value) || ArrayBuffer.isView(value);
}
/** Binary source detection and base64/hex conversion helpers. */
var Binary;
(function(Binary) {
	Binary.is = isArrayBufferLike;
	Binary.isSource = isArrayBufferSource;
	function fromSource(source) {
		if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
		else return source;
	}
	Binary.fromSource = fromSource;
	function toBase64(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("base64");
		let binary = "";
		const bytes = new Uint8Array(source);
		for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
		return btoa(binary);
	}
	Binary.toBase64 = toBase64;
	function fromBase64(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "base64"));
		return Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
	}
	Binary.fromBase64 = fromBase64;
	function toHex(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("hex");
		return Array.from(new Uint8Array(source), (byte) => byte.toString(16).padStart(2, "0")).join("");
	}
	Binary.toHex = toHex;
	function fromHex(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "hex"));
		const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1);
		const buffer = [];
		for (let i = 0; i < hex.length; i += 2) buffer.push(parseInt(`${hex[i]}${hex[i + 1]}`, 16));
		return Uint8Array.from(buffer).buffer;
	}
	Binary.fromHex = fromHex;
})(Binary || (Binary = {}));
Binary.fromBase64;
Binary.toBase64;
Binary.fromHex;
Binary.toHex;
function tokenize(source, delimiters, delimiter) {
	const output = [];
	let state = 0;
	for (let i = 0; i < source.length; i++) {
		const code = source.charCodeAt(i);
		if (code >= 65 && code <= 90) {
			if (state === 1) {
				const next = source.charCodeAt(i + 1);
				if (next >= 97 && next <= 122) output.push(delimiter);
				output.push(code + 32);
			} else {
				if (state !== 0) output.push(delimiter);
				output.push(code + 32);
			}
			state = 1;
		} else if (code >= 97 && code <= 122) {
			output.push(code);
			state = 2;
		} else if (delimiters.includes(code)) {
			if (state !== 0) output.push(delimiter);
			state = 0;
		} else output.push(code);
	}
	return String.fromCharCode(...output);
}
/** Convert text to dash-delimited parameter case. */
function paramCase(source) {
	return tokenize(source, [45, 95], 45);
}
/** Runtime alias for `paramCase`. */
const hyphenate = paramCase;
/** Time constants plus parsing and formatting helpers. */
var Time;
(function(Time) {
	Time.millisecond = 1;
	Time.second = 1e3;
	Time.minute = Time.second * 60;
	Time.hour = Time.minute * 60;
	Time.day = Time.hour * 24;
	Time.week = Time.day * 7;
	let timezoneOffset = (/* @__PURE__ */ new Date()).getTimezoneOffset();
	function setTimezoneOffset(offset) {
		timezoneOffset = offset;
	}
	Time.setTimezoneOffset = setTimezoneOffset;
	function getTimezoneOffset() {
		return timezoneOffset;
	}
	Time.getTimezoneOffset = getTimezoneOffset;
	function getDateNumber(date = /* @__PURE__ */ new Date(), offset) {
		if (typeof date === "number") date = new Date(date);
		if (offset === void 0) offset = timezoneOffset;
		return Math.floor((date.valueOf() / Time.minute - offset) / 1440);
	}
	Time.getDateNumber = getDateNumber;
	function fromDateNumber(value, offset) {
		const date = new Date(value * Time.day);
		if (offset === void 0) offset = timezoneOffset;
		return new Date(+date + offset * Time.minute);
	}
	Time.fromDateNumber = fromDateNumber;
	const numeric = /\d+(?:\.\d+)?/.source;
	const timeRegExp = new RegExp(`^${[
		"w(?:eek(?:s)?)?",
		"d(?:ay(?:s)?)?",
		"h(?:our(?:s)?)?",
		"m(?:in(?:ute)?(?:s)?)?",
		"s(?:ec(?:ond)?(?:s)?)?"
	].map((unit) => `(${numeric}${unit})?`).join("")}$`);
	function parseTime(source) {
		const capture = timeRegExp.exec(source);
		if (!capture) return 0;
		return (parseFloat(capture[1]) * Time.week || 0) + (parseFloat(capture[2]) * Time.day || 0) + (parseFloat(capture[3]) * Time.hour || 0) + (parseFloat(capture[4]) * Time.minute || 0) + (parseFloat(capture[5]) * Time.second || 0);
	}
	Time.parseTime = parseTime;
	function parseDate(date) {
		const parsed = parseTime(date);
		if (parsed) date = Date.now() + parsed;
		else if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).toLocaleDateString()}-${date}`;
		else if (/^\d{1,2}-\d{1,2}-\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).getFullYear()}-${date}`;
		return date ? new Date(date) : /* @__PURE__ */ new Date();
	}
	Time.parseDate = parseDate;
	function format(ms) {
		const abs = Math.abs(ms);
		if (abs >= Time.day - Time.hour / 2) return Math.round(ms / Time.day) + "d";
		else if (abs >= Time.hour - Time.minute / 2) return Math.round(ms / Time.hour) + "h";
		else if (abs >= Time.minute - Time.second / 2) return Math.round(ms / Time.minute) + "m";
		else if (abs >= Time.second) return Math.round(ms / Time.second) + "s";
		return ms + "ms";
	}
	Time.format = format;
	function toDigits(source, length = 2) {
		return source.toString().padStart(length, "0");
	}
	Time.toDigits = toDigits;
	function template(template, time = /* @__PURE__ */ new Date()) {
		return template.replace("yyyy", time.getFullYear().toString()).replace("yy", time.getFullYear().toString().slice(2)).replace("MM", toDigits(time.getMonth() + 1)).replace("dd", toDigits(time.getDate())).replace("hh", toDigits(time.getHours())).replace("mm", toDigits(time.getMinutes())).replace("ss", toDigits(time.getSeconds())).replace("SSS", toDigits(time.getMilliseconds(), 3));
	}
	Time.template = template;
})(Time || (Time = {}));
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+cordis@4.0.6-alpha.2_@deepseek-ai+cordis-plugin-include@1.0.11-alpha.2_@de_1f177d9e84ef6cb9bf8dc7bf6c8dcd3e/node_modules/@deepseek-ai/cordis/lib/index.js
/** Ordered collection of disposable values with O(1) deletion by value. */
var DisposableList = class {
	sn = 0;
	map = /* @__PURE__ */ new Map();
	weak = /* @__PURE__ */ new WeakMap();
	get length() {
		return this.map.size;
	}
	push(value) {
		const sn = ++this.sn;
		this.map.set(sn, value);
		this.weak.set(value, sn);
		return () => this.map.delete(sn);
	}
	delete(value) {
		const sn = this.weak.get(value);
		if (!sn) return false;
		return this.map.delete(sn);
	}
	clear() {
		const values = [...this.map.values()];
		this.map.clear();
		return values.reverse();
	}
	[Symbol.iterator]() {
		return this.map.values();
	}
	[Symbol.for("nodejs.util.inspect.custom")]() {
		return [...this];
	}
};
/** Shared symbols used to avoid public property-name collisions. */
const symbols = {
	shadow: Symbol.for("cordis.shadow"),
	caller: Symbol.for("cordis.caller"),
	receiver: Symbol.for("cordis.receiver"),
	original: Symbol.for("cordis.original"),
	metadata: Symbol.for("cordis.metadata"),
	initHooks: Symbol.for("cordis.initHooks"),
	checkProto: Symbol.for("cordis.checkProto"),
	effect: Symbol.for("cordis.effect"),
	filter: Symbol.for("cordis.filter"),
	isolate: Symbol.for("cordis.isolate"),
	intercept: Symbol.for("cordis.intercept"),
	init: Symbol.for("cordis.init"),
	check: Symbol.for("cordis.check"),
	config: Symbol.for("cordis.config"),
	invoke: Symbol.for("cordis.invoke"),
	extend: Symbol.for("cordis.extend"),
	tracker: Symbol.for("cordis.tracker"),
	resolveConfig: Symbol.for("cordis.resolveConfig")
};
const GeneratorFunction = function* () {}.constructor;
const AsyncGeneratorFunction = async function* () {}.constructor;
/** Return true when a plugin callback should be constructed with `new`. */
function isConstructor(func) {
	if (!func.prototype) return false;
	if (func instanceof GeneratorFunction) return false;
	if (AsyncGeneratorFunction !== Function && func instanceof AsyncGeneratorFunction) return false;
	return true;
}
/** Merge two prototype chains while preserving descriptors from `proto1`. */
function joinPrototype(proto1, proto2) {
	if (proto1 === Object.prototype) return proto2;
	const result = Object.create(joinPrototype(Object.getPrototypeOf(proto1), proto2));
	for (const key of Reflect.ownKeys(proto1)) Object.defineProperty(result, key, Object.getOwnPropertyDescriptor(proto1, key));
	return result;
}
/** Return true for non-null objects and functions. */
function isObject$1(value) {
	return value && (typeof value === "object" || typeof value === "function");
}
/** Find a property descriptor by walking an object's prototype chain. */
function getPropertyDescriptor(target, prop) {
	let proto = target;
	while (proto) {
		const desc = Reflect.getOwnPropertyDescriptor(proto, prop);
		if (desc) return desc;
		proto = Object.getPrototypeOf(proto);
	}
}
/** Wrap services/functions so method calls see the caller's active context. */
function getTraceable(ctx, value) {
	if (!isObject$1(value)) return value;
	if (Object.hasOwn(value, symbols.shadow)) return Object.getPrototypeOf(value);
	const tracker = value[symbols.tracker];
	if (!tracker) return value;
	return createTraceable(ctx, value, tracker);
}
/** Return a proxy that overlays readonly or writable properties onto a target. */
function withProps(target, props) {
	if (!props) return target;
	return new Proxy(target, {
		get: (target, prop, receiver) => {
			if (prop in props && prop !== "constructor") return Reflect.get(props, prop, receiver);
			return Reflect.get(target, prop, receiver);
		},
		set: (target, prop, value, receiver) => {
			if (prop in props && prop !== "constructor") return Reflect.set(props, prop, value, receiver);
			return Reflect.set(target, prop, value, receiver);
		}
	});
}
function withProp(target, prop, value) {
	return withProps(target, Object.defineProperty(Object.create(null), prop, {
		value,
		writable: false
	}));
}
function createShadow(useSite, target, property, receiver) {
	if (!property) return receiver;
	const value = getPropertyDescriptor(target, property)?.value;
	if (!value) return receiver;
	const defSite = value[symbols.shadow] ?? value;
	return withProp(receiver, property, useSite.extend({ [symbols.shadow]: defSite }));
}
function createShadowMethod(ctx, value, outer, shadow) {
	return new Proxy(value, { apply: (target, thisArg, args) => {
		if (thisArg === outer) thisArg = shadow;
		return getTraceable(ctx, Reflect.apply(target, thisArg, args));
	} });
}
function createTraceable(ctx, value, tracker) {
	const defSite = ctx[symbols.shadow] ?? ctx;
	const useSite = ctx[symbols.shadow] ? Object.getPrototypeOf(ctx) : ctx;
	const proxy = new Proxy(value, {
		get: (target, prop, receiver) => {
			if (prop === symbols.original) return target;
			if (prop === symbols.caller) return defSite;
			if (prop === tracker.property) return useSite;
			if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);
			if (tracker.associate && useSite.reflect.props[`${tracker.associate}.${prop}`]) return Reflect.get(ctx, `${tracker.associate}.${prop}`, withProp(ctx, symbols.receiver, receiver));
			let shadow, innerValue;
			const desc = getPropertyDescriptor(target, prop);
			if (desc && "value" in desc) innerValue = desc.value;
			else {
				shadow = createShadow(useSite, target, tracker.property, receiver);
				innerValue = Reflect.get(target, prop, shadow);
			}
			const innerTracker = innerValue?.[symbols.tracker];
			if (innerTracker) return createTraceable(useSite, innerValue, innerTracker);
			else if (!tracker.noShadow && typeof innerValue === "function") {
				shadow ??= createShadow(useSite, target, tracker.property, receiver);
				return createShadowMethod(useSite, innerValue, receiver, shadow);
			} else return innerValue;
		},
		set: (target, prop, value, receiver) => {
			if (prop === symbols.original) return false;
			if (prop === symbols.caller) return false;
			if (prop === tracker.property) return false;
			if (typeof prop === "symbol") return Reflect.set(target, prop, value, receiver);
			if (tracker.associate && useSite.reflect.props[`${tracker.associate}.${prop}`]) return Reflect.set(ctx, `${tracker.associate}.${prop}`, value, withProp(ctx, symbols.receiver, receiver));
			const shadow = createShadow(useSite, target, tracker.property, receiver);
			return Reflect.set(target, prop, value, shadow);
		},
		apply: (target, thisArg, args) => {
			return applyTraceable(tracker.noShadow ? proxy : createShadow(useSite, target, tracker.property, proxy), target, thisArg, args);
		}
	});
	return proxy;
}
function applyTraceable(proxy, value, thisArg, args) {
	if (!value[symbols.invoke]) return Reflect.apply(value, thisArg, args);
	return value[symbols.invoke].apply(proxy, args);
}
/** Create a callable service object that dispatches through `symbols.invoke`. */
function createCallable(name, proto, tracker) {
	const self = function(...args) {
		const proxy = createTraceable(self["ctx"], self, tracker);
		return Reflect.apply(proxy, this, args);
	};
	defineProperty(self, "name", name);
	return Object.setPrototypeOf(self, proto);
}
function handleError(info, reason, getOuterStack) {
	const innerLines = info.error.stack.split("\n");
	if (typeof reason?.stack !== "string") {
		const outerError = new Error(reason);
		const lines = outerError.stack.split("\n");
		lines.splice(1, Infinity, ...getOuterStack());
		outerError.stack = lines.join("\n");
		throw outerError;
	}
	const lines = reason.stack.split("\n");
	let index = lines.indexOf(innerLines[2]);
	if (index === -1) throw reason;
	index -= info.offset;
	while (index > 0) {
		if (!lines[index - 1].endsWith(" (<anonymous>)")) break;
		index -= 1;
	}
	lines.splice(index, Infinity, ...getOuterStack());
	reason.stack = lines.join("\n");
	throw reason;
}
/** Run a callback and splice outer call-site frames into thrown async errors. */
function composeError(callback, getOuterStack = buildOuterStack()) {
	const info = {
		offset: 1,
		error: /* @__PURE__ */ new Error()
	};
	try {
		const result = callback(info);
		if (isObject$1(result) && "then" in result) return result.then(void 0, (reason) => handleError(info, reason, getOuterStack));
		else return result;
	} catch (reason) {
		handleError(info, reason, getOuterStack);
	}
}
/** Capture a lazy stack-frame supplier for later error composition. */
function buildOuterStack(offset = 0) {
	const outerError = /* @__PURE__ */ new Error();
	return () => outerError.stack.split("\n").slice(3 + offset);
}
const kValidationError = Symbol.for("ValidationError");
/** Error raised when plugin configuration fails standard-schema validation. */
var ValidationError = class extends TypeError {
	name = "ValidationError";
	/**
	* Build the aggregated message from schema issues.
	*
	* @param issues — the standard-schema issues, one message line each.
	*/
	constructor(issues) {
		super(`invalid config:\n` + issues.map((issue) => {
			if (issue.path) return `  - ${issue.message} (at ${issue.path.join(".")})`;
			else return `  - ${issue.message}`;
		}).join("\n"));
	}
};
Object.defineProperty(ValidationError.prototype, kValidationError, { value: true });
/**
* Validate and normalize config for a plugin runtime before it starts.
*
* @param runtime — the plugin runtime whose `Config` schema to apply.
* @param config — the raw user config.
* @returns the validated config, or `config` unchanged if the runtime has no schema.
* @throws {ValidationError} when validation reports issues.
*/
function resolveConfig(runtime, config) {
	if (!runtime.Config) return config;
	const result = runtime.Config["~standard"].validate(config);
	if ("then" in result) throw new TypeError("Async config validation is not supported");
	if (result.issues) throw new ValidationError(result.issues);
	else return result.value;
}
const effectInertia = /* @__PURE__ */ new WeakMap();
function runDisposable(dispose) {
	const result = dispose();
	return effectInertia.get(dispose)?.() ?? result;
}
/** Notify plugin teardown without allowing one observer to break ownership cleanup. */
function emitPluginDisposed(context, fiber) {
	const args = ["internal/plugin", fiber];
	let callbacks;
	try {
		callbacks = context.events.dispatch("emit", args);
	} catch (error) {
		context.logger.error(error);
		return;
	}
	for (const callback of callbacks) try {
		const returned = callback(...args);
		Promise.resolve(returned).catch((error) => context.logger.error(error));
	} catch (error) {
		context.logger.error(error);
	}
}
/** Framework error with a stable machine-readable code. */
var CordisError = class CordisError extends Error {
	code;
	/**
	* @param code — the stable error code; also the default message.
	* @param message — optional human-readable override.
	*/
	constructor(code, message) {
		super(message ?? CordisError.Code[code]);
		this.code = code;
	}
};
/** Cordis error code definitions. */
(function(CordisError) {
	CordisError.Code = { INACTIVE_EFFECT: "cannot create effect on inactive context" };
})(CordisError || (CordisError = {}));
const INACTIVE = "__INACTIVE__";
/**
* Runtime instance of one plugin application.
*
* A fiber tracks dependency state, raw and effective config, lifecycle effects, and
* cleanup for the plugin context returned by `ctx.plugin()`.
*/
var Fiber = class {
	parent;
	inject;
	runtime;
	/** Unique id within the registry; 0 for the root fiber, `null` once disposed. */
	uid;
	/** The context this fiber's plugin runs in (extends the parent context). */
	ctx;
	/** Raw plugin input retained for the next activation. */
	config;
	/** Current lifecycle state; transitions emit `internal/status`. */
	state = 0;
	/** Dispose this fiber: unload the plugin, then settle once cleanup finished. */
	dispose;
	/** Required implementations retained through dependent teardown. */
	committed;
	/** Service implementations owned by this fiber, including isolated provisions. */
	provisions = /* @__PURE__ */ new Set();
	/** The in-flight load/unload transition, if one is currently running. */
	inertia;
	_hooks = Object.create(null);
	_disposables = new DisposableList();
	context;
	_error;
	_revision = 0;
	_configRevision = 0;
	_effectiveConfig;
	_runner;
	_store = Object.create(null);
	_release;
	/**
	* Create a fiber. Plugin authors normally obtain fibers from `ctx.plugin()`
	* rather than constructing them directly.
	*
	* @param parent — the context the plugin was loaded from.
	* @param config — raw config, validated against the runtime's schema.
	* @param inject — resolved dependency map (service name → intercept config).
	* @param runtime — the shared plugin runtime, or `null` for the root fiber.
	* @param getOuterStack — captures the caller stack for effect diagnostics.
	*/
	constructor(parent, config, inject, runtime, getOuterStack) {
		this.parent = parent;
		this.inject = inject;
		this.runtime = runtime;
		this.config = config;
		const collect = (dispose) => {
			this._disposables.push(dispose);
		};
		if (runtime) {
			this.uid = parent.registry.counter;
			this.ctx = this.context = parent.extend({ fiber: this });
			const injectEntries = Object.entries(this.inject);
			if (injectEntries.length) {
				this.ctx[Context.intercept] = Object.create(parent[Context.intercept]);
				for (const [name, config] of injectEntries) {
					if (isNullable(config)) continue;
					this.ctx[Context.intercept][name] = config;
				}
			}
			this._runner = {
				epoch: INACTIVE,
				getOuterStack,
				execute: function() {
					const config = this.resolveConfig(this.config);
					this._effectiveConfig = config;
					if (isConstructor(runtime.callback)) {
						const instance = new runtime.callback(this.ctx, config);
						for (const hook of instance?.[symbols.initHooks] ?? []) hook();
						return instance?.[symbols.init]?.();
					} else return runtime.callback(this.ctx, config);
				},
				collect
			};
			this.dispose = parent.fiber.effect(() => {
				const remove = runtime.fibers.push(this);
				return async () => {
					this.uid = null;
					emitPluginDisposed(this.context, this);
					if (this.ctx.registry.has(runtime.callback)) {
						remove();
						if (!runtime.fibers.length) this.ctx.registry.delete(runtime.callback);
					}
					this._setEpoch(INACTIVE);
					if (!this.inertia) this._updateState(() => {
						this.inertia = this._unload();
						return 5;
					});
					while (this.inertia) await this.inertia;
				};
			}, "ctx.plugin()");
			try {
				this.context.emit("internal/plugin", this);
			} catch (error) {
				Promise.resolve(this.dispose()).catch((reason) => this.ctx.logger.error(reason));
				throw error;
			}
			if (this.uid !== null && parent.fiber.state !== 5) {
				for (const name of Object.keys(this.inject)) this._checkImpl(name);
				this._refresh();
			}
		} else {
			this.uid = 0;
			this.ctx = this.context = parent;
			this.state = 2;
			this.committed = Object.create(null);
			this._runner = {
				epoch: "0",
				getOuterStack,
				execute: () => {},
				collect
			};
			this.dispose = () => this.restart();
		}
	}
	/** The plugin's display name, inherited from the nearest named ancestor, else `'root'`. */
	get name() {
		let fiber = this;
		do {
			if (fiber.runtime?.name) return fiber.runtime.name;
			fiber = fiber.parent.fiber;
		} while (fiber !== fiber.parent.fiber);
		return "root";
	}
	/**
	* Throw if the fiber has already been disposed.
	*
	* @returns nothing when the fiber is still active.
	* @throws {CordisError} `INACTIVE_EFFECT` when the fiber's uid has been cleared.
	*/
	assertActive() {
		if (this.uid !== null) return;
		throw new CordisError("INACTIVE_EFFECT");
	}
	_execute(runner) {
		const oldEpoch = runner.epoch;
		return composeError((info) => {
			const safeCollect = (dispose) => {
				if (typeof dispose === "function") runner.collect(dispose);
				else if (!isNullable(dispose)) throw new TypeError("Invalid effect");
			};
			const effect = runner.execute.call(this);
			if (typeof effect === "function") return runner.collect(effect);
			else if (isNullable(effect)) {} else if (!isObject$1(effect)) throw new TypeError("Invalid effect");
			else if ("then" in effect) return effect.then(safeCollect);
			else if (Symbol.iterator in effect) {
				info.error = /* @__PURE__ */ new Error();
				const iter = effect[Symbol.iterator]();
				while (true) {
					const result = iter.next();
					safeCollect(result.value);
					if (result.done) return;
				}
			} else if (Symbol.asyncIterator in effect) {
				const iter = effect[Symbol.asyncIterator]();
				return (async () => {
					await Promise.resolve();
					info.error = /* @__PURE__ */ new Error();
					while (true) {
						if (runner.epoch !== oldEpoch) return;
						const result = await iter.next();
						safeCollect(result.value);
						if (result.done) return;
					}
				})();
			} else throw new TypeError("Invalid effect");
		}, runner.getOuterStack);
	}
	effect(execute, label = "anonymous") {
		this.assertActive();
		if (this.state === 5) throw new CordisError("INACTIVE_EFFECT");
		const disposables = [];
		let disposing = false;
		let disposalTask;
		const dispose = () => {
			if (disposing) return disposalTask;
			disposing = true;
			let task;
			for (const disposable of disposables.splice(0).reverse()) if (task) task = task.then(() => runDisposable(disposable));
			else {
				const result = runDisposable(disposable);
				if (isObject$1(result) && "then" in result) task = result;
			}
			return disposalTask = task;
		};
		const meta = {
			label,
			children: []
		};
		const runner = {
			execute,
			epoch: true,
			collect: (dispose) => {
				disposables.push(dispose);
				this._disposables.delete(dispose);
				if (dispose[symbols.effect]) meta.children.push(dispose[symbols.effect]);
			},
			getOuterStack: buildOuterStack()
		};
		let task;
		let executing = true;
		let resolveSetup;
		let rejectSetup;
		let setupBarrier;
		let setupFailed = false;
		let inFlight;
		let removeWrapper = () => false;
		const waitForSetup = () => {
			setupBarrier ??= new Promise((resolve, reject) => {
				resolveSetup = resolve;
				rejectSetup = reject;
			});
			return setupBarrier;
		};
		const disposeAfter = (setup) => {
			return Promise.resolve(setup).then(() => dispose(), async (reason) => {
				await dispose();
				throw reason;
			});
		};
		const finalizeDisposal = (callback) => {
			let result;
			try {
				result = callback();
			} catch (error) {
				removeWrapper();
				throw error;
			}
			if (isObject$1(result) && "then" in result) {
				const pending = Promise.resolve(result).finally(() => {
					removeWrapper();
					if (inFlight === pending) inFlight = void 0;
				});
				return inFlight = pending;
			}
			removeWrapper();
			return result;
		};
		const wrapper = defineProperty(() => {
			if (!runner.epoch) return setupFailed ? inFlight : void 0;
			runner.epoch = false;
			return finalizeDisposal(() => {
				if (executing) return disposeAfter(waitForSetup());
				return task ? disposeAfter(task) : dispose();
			});
		}, symbols.effect, meta);
		effectInertia.set(wrapper, () => inFlight);
		removeWrapper = this._disposables.push(wrapper);
		try {
			task = this._execute(runner);
		} catch (reason) {
			executing = false;
			setupFailed = true;
			runner.epoch = false;
			let cleanup;
			try {
				cleanup = finalizeDisposal(dispose);
			} finally {
				rejectSetup?.(reason);
			}
			if (isObject$1(cleanup) && "then" in cleanup) cleanup.catch((error) => this.ctx.logger.error(error));
			throw reason;
		}
		executing = false;
		if (setupBarrier) Promise.resolve(task).then(resolveSetup, rejectSetup);
		task?.catch(() => {
			if (!runner.epoch) return dispose();
			return finalizeDisposal(dispose);
		}).catch((error) => this.ctx.logger.error(error));
		const disposeAsync = () => {
			if (!runner.epoch) return;
			runner.epoch = false;
			return finalizeDisposal(dispose);
		};
		wrapper.then = async (onFulfilled, onRejected) => {
			return Promise.resolve(task).then(() => disposeAsync).then(onFulfilled, onRejected);
		};
		return wrapper;
	}
	/**
	* Return metadata for currently registered effects.
	*
	* @returns one {@link EffectMeta} tree per labeled live effect.
	*/
	getEffects() {
		return [...this._disposables].map((dispose) => dispose[symbols.effect]).filter(Boolean);
	}
	_getState() {
		if (this.uid === null) return 4;
		if (this._error) return 3;
		if (this._runner.epoch !== INACTIVE) return 2;
		return 0;
	}
	_updateState(callback) {
		const oldState = this.state;
		this.state = callback() ?? this._getState();
		if (oldState === this.state) return;
		this.context.emit("internal/status", this, oldState);
		if (oldState !== 2 && this.state !== 2) return;
		for (const key of Reflect.ownKeys(this.ctx.reflect.store)) {
			const impl = this.ctx.reflect.store[key];
			if (impl.ctx.fiber !== this) continue;
			this.ctx.isolate(impl.name, impl.isolate).reflect.notify([impl.name]);
		}
	}
	_checkImpl(name) {
		const impl = this.ctx.reflect._getImpl(name, true);
		if (!impl) return delete this._store[name];
		try {
			if (impl.check && !impl.check.call(getTraceable(this.ctx, impl.value))) return delete this._store[name];
		} catch (error) {
			impl.ctx.logger.error(error);
			return delete this._store[name];
		}
		this._store[name] = impl;
	}
	_refresh() {
		let epoch = `${this._revision}`;
		for (const name of Object.keys(this.inject)) {
			const impl = this._store[name];
			if (!impl) {
				epoch = INACTIVE;
				break;
			}
			epoch += ":" + impl.uid;
		}
		this._setEpoch(epoch);
	}
	_setEpoch(epoch) {
		const oldEpoch = this._runner.epoch;
		if (epoch === oldEpoch) return;
		if (this._error) return;
		this._runner.epoch = epoch;
		if (this.inertia) return;
		this._updateState(() => {
			if (epoch !== INACTIVE && oldEpoch === INACTIVE) {
				this.inertia = this._reload();
				return 1;
			} else {
				this.inertia = this._unload();
				return 5;
			}
		});
	}
	/** Raw input retained for the next activation, without evaluating expressions or validating it. */
	get rawConfig() {
		return this.ctx.fiber.config;
	}
	/** Retain raw input without changing the running config or triggering an update. */
	set rawConfig(config) {
		this.ctx.fiber.config = config;
		this.ctx.fiber._configRevision++;
	}
	/**
	* The object passed to plugin activation or the latest successful update that retained the instance.
	* Candidate resolution does not publish it; volatile updates retain its references.
	* Undefined before activation and readable after unload; callers requiring a live instance check `state`.
	*/
	get effectiveConfig() {
		return this.ctx.fiber._effectiveConfig;
	}
	/**
	* Evaluate and validate a candidate using this fiber's `internal/config` hooks and runtime schema.
	* Does not publish the result, replace raw input, or commit running volatile references.
	* Required injections must be available when a hook uses them.
	* @param config Raw candidate input.
	* @returns The candidate's resolved config, retaining the schema's result identity.
	* @throws {ValidationError} when the runtime schema rejects the candidate; hook errors propagate.
	*/
	resolveConfig(config) {
		const fiber = this.ctx.fiber;
		return fiber.context.waterfall("internal/config", fiber, () => config);
	}
	async _reload() {
		this.committed = { ...this._store };
		for (const impl of Object.values(this.committed)) {
			if (impl.ctx.fiber === this) continue;
			impl.dependents.add(this);
		}
		const oldEpoch = this._runner.epoch;
		try {
			await Promise.resolve();
			if (this._runner.epoch === oldEpoch) await this._execute(this._runner);
		} catch (reason) {
			this.ctx.logger.error(reason);
			if (this._runner.epoch === oldEpoch) {
				this._error = reason;
				this._runner.epoch = INACTIVE;
			}
		}
		this._updateState(() => {
			if (this._runner.epoch === oldEpoch) this.inertia = void 0;
			else {
				this.inertia = this._unload();
				return 5;
			}
		});
	}
	async _unload() {
		while ([...this.provisions].some((impl) => impl.dependents.size)) await new Promise((resolve) => this._release = resolve);
		this._release = void 0;
		await Promise.all(this._disposables.clear().map(async (dispose) => {
			try {
				await composeError(async (info) => {
					await Promise.resolve();
					info.error = /* @__PURE__ */ new Error();
					await runDisposable(dispose);
				}, this._runner.getOuterStack);
			} catch (reason) {
				this.ctx.logger.error(reason);
			}
		}));
		for (const impl of Object.values(this.committed ?? {})) {
			if (!impl.dependents.delete(this) || impl.dependents.size) continue;
			impl.release?.();
			impl.ctx.fiber._release?.();
		}
		this.committed = void 0;
		this._updateState(() => {
			if (this._runner.epoch === INACTIVE) this.inertia = void 0;
			else {
				this.inertia = this._reload();
				return 1;
			}
		});
	}
	/**
	* Wait for current lifecycle work and rethrow startup errors.
	*
	* @returns this fiber, once it has settled into a stable state.
	* @throws the config-validation or plugin-startup error, if any.
	*/
	async await() {
		while (this.inertia) await this.inertia;
		if (this._error) throw this._error;
		return this;
	}
	/**
	* Dispose and immediately reload this plugin with its current config.
	*
	* @returns a promise resolving once the reload settled.
	* @throws {CordisError} `INACTIVE_EFFECT` when the fiber is already disposed.
	*/
	async restart() {
		const fiber = this.ctx.fiber;
		fiber.assertActive();
		fiber._revision++;
		fiber._refresh();
		await fiber.await();
	}
	/**
	* Resolve a candidate, retain its raw config and apply it through the update waterfall.
	* @param config Raw config; pending fibers defer resolution until activation.
	* @param noSave Suppress the persistence notification when true.
	* @returns The awaited update/restart result, or undefined when a synchronous listener handles it.
	* @throws {ValidationError} when an active fiber's candidate is invalid.
	*/
	update(config, noSave = false) {
		const fiber = this.ctx.fiber;
		fiber.assertActive();
		const loaded = fiber._runner.epoch !== INACTIVE;
		const resolved = loaded ? fiber.resolveConfig(config) : void 0;
		if (!noSave) fiber.context.emit("internal/commit", fiber, config);
		fiber.config = config;
		fiber._error = void 0;
		const configRevision = ++fiber._configRevision;
		const epoch = fiber._runner.epoch;
		const committed = fiber.committed;
		let restarted = false;
		const restart = () => {
			restarted = true;
			return fiber.restart();
		};
		const publish = () => {
			if (!restarted && fiber.uid !== null && fiber._configRevision === configRevision && fiber._runner.epoch === epoch && fiber.committed === committed) fiber._effectiveConfig = resolved;
		};
		const result = loaded ? fiber.context.waterfall(fiber, "internal/update", resolved, restart) : restart();
		if (result === void 0) {
			publish();
			return;
		}
		const task = Promise.resolve(result).then(publish);
		task.catch(() => {});
		return task;
	}
};
/**
* Return whether an event result should stop a bail-style dispatch.
*
* @param value — a listener's return value.
* @returns `true` unless `value` is `null`, `false`, or `undefined`.
*/
function isBailed(value) {
	return value !== null && value !== false && value !== void 0;
}
/**
* Event bus installed as `ctx.events` and mixed into every context.
*
* The service supports concurrent, synchronous, serial, bail, and waterfall
* dispatch and automatically disposes listeners with their owning fiber.
*/
var EventsService = class {
	ctx;
	_hooks = Object.create(null);
	constructor(ctx) {
		this.ctx = ctx;
		defineProperty(this, symbols.tracker, {
			property: "ctx",
			noShadow: true
		});
		this.on("internal/listener", function(name, listener, options) {
			if (name === "internal/update" && !options.global) {
				const hooks = this.fiber._hooks["internal/update"] ??= new DisposableList();
				const method = options.prepend ? "unshift" : "push";
				return this.fiber.effect(() => hooks[method](listener), "ctx.on(\"internal/update\")");
			}
		});
		this.on("internal/update", function(config, next) {
			const cbs = [...this._hooks["internal/update"] || []];
			const _next = () => {
				return (cbs.shift() ?? next).call(this, config, _next);
			};
			return _next();
		}, {
			global: true,
			prepend: true
		});
		this.on("internal/config", (fiber, next) => {
			const config = next();
			return fiber.runtime ? resolveConfig(fiber.runtime, config) : config;
		});
	}
	_resolve(type, args) {
		const thisArg = typeof args[0] === "object" || typeof args[0] === "function" ? args.shift() : null;
		const name = args.shift();
		if ((typeof name !== "string" || !name.startsWith("internal/")) && this._hooks["internal/dispatch"]?.length) this.emit("internal/dispatch", type, name, args, thisArg);
		const filter = thisArg?.[Context.filter];
		return [thisArg, (this._hooks[name] || []).filter((hook) => hook.global || !filter || filter.call(thisArg, hook.ctx)).map((hook) => hook.callback)];
	}
	/**
	* Resolve bound callbacks using the event's context filter.
	* @param type Dispatch mode reported to observers.
	* @param args Dispatch arguments, consumed through the event name.
	* @returns Matching callbacks bound to the dispatch receiver.
	* DSH retains callback enumeration for per-listener error containment.
	*/
	dispatch(type, args) {
		const [thisArg, callbacks] = this._resolve(type, args);
		return callbacks.map((callback) => callback.bind(thisArg));
	}
	/**
	* Run listeners concurrently and wait for all of them.
	*
	* @param args — optional `this`, the event name, then listener arguments.
	* @returns a promise resolving once every listener has settled.
	*/
	async parallel(...args) {
		const [thisArg, callbacks] = this._resolve("parallel", args);
		const errors = (await Promise.allSettled(callbacks.map(async (callback) => Reflect.apply(callback, thisArg, args)))).filter((result) => result.status === "rejected");
		if (errors.length) throw new AggregateError(errors.map((error) => error.reason));
	}
	/**
	* Run listeners synchronously without waiting for returned promises.
	*
	* @param args — optional `this`, the event name, then listener arguments.
	*/
	emit(...args) {
		const [thisArg, callbacks] = this._resolve("emit", args);
		for (const callback of callbacks) Reflect.apply(callback, thisArg, args);
	}
	/**
	* Run listeners in order, awaiting each, until one returns a bail value.
	*
	* @param args — optional `this`, the event name, then listener arguments.
	* @returns the first bail value (see {@link isBailed}), if any.
	*/
	async serial(...args) {
		const [thisArg, callbacks] = this._resolve("serial", args);
		for (const callback of callbacks) {
			const result = await Reflect.apply(callback, thisArg, args);
			if (isBailed(result)) return result;
		}
	}
	/**
	* Run listeners synchronously until one returns a bail value.
	*
	* @param args — optional `this`, the event name, then listener arguments.
	* @returns the first bail value (see {@link isBailed}), if any.
	*/
	bail(...args) {
		const [thisArg, callbacks] = this._resolve("bail", args);
		for (const callback of callbacks) {
			const result = Reflect.apply(callback, thisArg, args);
			if (isBailed(result)) return result;
		}
	}
	/**
	* Compose listeners around the final `next` callback.
	*
	* The last dispatch argument is treated as the innermost `next`. Listeners
	* run outermost-first; a listener that does not call `next()` vetoes the
	* rest of the chain, including the built-in behavior.
	*
	* @param args — optional `this`, the event name, listener arguments, then `next`.
	* @returns the outermost listener's return value.
	*/
	waterfall(...args) {
		const [thisArg, callbacks] = this._resolve("waterfall", args);
		const inner = args.pop();
		const dispatch = () => {
			const callback = callbacks.shift();
			if (!callback) return inner();
			let called = false;
			const next = () => {
				if (called) throw new Error("next() called multiple times");
				called = true;
				return dispatch();
			};
			return Reflect.apply(callback, thisArg, [...args, next]);
		};
		return dispatch();
	}
	register(label, name, callback, options) {
		const method = options.prepend ? "unshift" : "push";
		return this.ctx.fiber.effect(() => {
			(this._hooks[name] ??= [])[method]({
				ctx: this.ctx,
				callback,
				...options
			});
			return () => this.unregister(name, callback);
		}, label);
	}
	unregister(name, callback) {
		const hooks = this._hooks[name];
		if (!hooks) return;
		const index = hooks.findIndex((hook) => hook.callback === callback);
		if (index >= 0) {
			hooks.splice(index, 1);
			if (!hooks.length) delete this._hooks[name];
			return true;
		}
	}
	/**
	* Register an event listener owned by the current fiber.
	*
	* The listener is removed automatically when the fiber unloads. Throws
	* `CordisError('INACTIVE_EFFECT')` if the fiber is already disposed.
	*
	* @param name — the event name to listen for.
	* @param listener — called with the dispatch arguments.
	* @param options — listener options; a boolean is shorthand for `prepend`.
	* @returns a disposer removing the listener; `true` if it was still registered.
	*/
	on(name, listener, options) {
		if (typeof options !== "object") options = { prepend: options };
		this.ctx.fiber.assertActive();
		listener = this.ctx.reflect.bind(listener);
		const result = this.bail(this.ctx, "internal/listener", name, listener, options);
		if (result) return result;
		const label = `ctx.on(${typeof name === "string" ? JSON.stringify(name) : name.toString()})`;
		return this.register(label, name, listener, options);
	}
	/**
	* Register an event listener that disposes itself after the first call.
	*
	* @param name — the event name to listen for.
	* @param listener — called at most once with the dispatch arguments.
	* @param options — listener options; a boolean is shorthand for `prepend`.
	* @returns a disposer removing the listener; `true` if it was still registered.
	*/
	once(name, listener, options) {
		const dispose = this.on(name, function(...args) {
			dispose();
			return listener.apply(this, args);
		}, options);
		return dispose;
	}
};
/** Built-in placeholder formatters used by `Logger.format()`. */
const defaultFormatters = {
	s: (value) => String(value),
	d: (value) => Math.trunc(Number(value)),
	i: (value) => Math.trunc(Number(value)),
	f: (value) => Number(value),
	o: (value) => JSON.stringify(value),
	O: (value) => JSON.stringify(value),
	c: () => "",
	C: (value, exporter, message) => {
		return Logger.color(exporter, Logger.code(message.name, exporter.colors), value);
	}
};
function isAggregateError(error) {
	return error instanceof Error && Array.isArray(error["errors"]);
}
/** Logger facade for one named subsystem. */
var Logger = class {
	service;
	static color(exporter, code, value, decoration = "") {
		if (!exporter.colors) return "" + value;
		return `\u001b[3${code < 8 ? code : "8;5;" + code}${exporter.colors >= 2 ? decoration : ""}m${value}\u001b[0m`;
	}
	static code(name, level) {
		let hash = 0;
		for (let i = 0; i < name.length; i++) {
			hash = (hash << 3) - hash + name.charCodeAt(i) + 13;
			hash |= 0;
		}
		const colors = !level ? [] : level >= 2 ? c256 : c16;
		return colors[Math.abs(hash) % colors.length];
	}
	static format(exporter, message) {
		const args = message.args.slice();
		if (args[0] instanceof Error) {
			args[0] = args[0].stack || args[0].message;
			args.unshift("%s");
		} else if (typeof args[0] !== "string") args.unshift("%o");
		let format = args.shift();
		format = format.replace(/%([a-zA-Z%])/g, (match, char) => {
			if (match === "%%") return "%";
			const formatter = exporter.formatters?.[char] ?? defaultFormatters[char];
			if (typeof formatter === "function") return formatter(args.shift(), exporter, message);
			return match;
		});
		const oFormatter = exporter.formatters?.o ?? defaultFormatters.o;
		for (let arg of args) {
			if (typeof arg === "object" && arg) arg = oFormatter(arg, exporter, message);
			format += " " + arg;
		}
		const { maxLength = 10240 } = exporter;
		return format.split(/\r?\n/g).map((line) => {
			return line.slice(0, maxLength) + (line.length > maxLength ? "..." : "");
		}).join("\n");
	}
	constructor(options, service) {
		this.service = service;
		Object.assign(this, options);
		this.error = this._method("error", 0);
		this.info = this._method("info", 2);
		this.warn = this._method("warn", 1);
		this.debug = this._method("debug", 3);
	}
	_method(type, level) {
		return (...args) => {
			if (args.length === 1 && args[0] instanceof Error) {
				if (args[0].cause) this[type](args[0].cause);
				else if (isAggregateError(args[0])) {
					args[0].errors.forEach((error) => this[type](error));
					return;
				}
			}
			const sn = ++this.service._snMessage;
			const ts = Date.now();
			for (const exporter of this.service.exporters.values()) {
				if ((exporter.levels?.[this.name] ?? exporter.levels?.default ?? this.level ?? 2) < level) continue;
				const message = {
					sn,
					ts,
					type,
					level,
					name: this.name,
					...this.meta,
					args
				};
				exporter.export(message);
			}
		};
	}
};
/** ANSI 16-color palette indexes used for logger name coloring. */
const c16 = [
	6,
	2,
	3,
	4,
	5,
	1
];
/** ANSI 256-color palette indexes used for logger name coloring. */
const c256 = [
	20,
	21,
	26,
	27,
	32,
	33,
	38,
	39,
	40,
	41,
	42,
	43,
	44,
	45,
	56,
	57,
	62,
	63,
	68,
	69,
	74,
	75,
	76,
	77,
	78,
	79,
	80,
	81,
	92,
	93,
	98,
	99,
	112,
	113,
	129,
	134,
	135,
	148,
	149,
	160,
	161,
	162,
	163,
	164,
	165,
	166,
	167,
	168,
	169,
	170,
	171,
	172,
	173,
	178,
	179,
	184,
	185,
	196,
	197,
	198,
	199,
	200,
	201,
	202,
	203,
	204,
	205,
	206,
	207,
	208,
	209,
	214,
	215,
	220,
	221
];
/**
* Built-in logging service.
*
* Call `ctx.logger()` to create a named logger, or call `ctx.logger.info()`
* directly to log with the current fiber-derived name.
*/
var LoggerService = class LoggerService {
	bufferSize = 1e3;
	buffer = [];
	ctx;
	_snMessage = 0;
	_snExporter = 0;
	exporters = /* @__PURE__ */ new Map();
	constructor(ctx) {
		const tracker = {
			property: "ctx",
			noShadow: true
		};
		const self = createCallable("logger", joinPrototype(Object.getPrototypeOf(this), Function.prototype), tracker);
		Object.assign(self, this);
		self.ctx = ctx;
		defineProperty(self, symbols.tracker, tracker);
		self.exporter({
			colors: 3,
			export: (message) => {
				self.buffer.push(message);
				const overflow = self.buffer.length - self.bufferSize;
				if (overflow === 1) self.buffer.shift();
				else if (overflow > 1) self.buffer.splice(0, overflow);
			}
		});
		return self;
	}
	/**
	* Register an exporter and dispose it with the current fiber.
	*
	* @param exporter — the sink that receives structured log messages.
	* @returns a disposer that removes the exporter.
	*/
	exporter(exporter) {
		return this.ctx.effect(() => {
			const id = ++this._snExporter;
			this.exporters.set(id, exporter);
			return () => this.exporters.delete(id);
		}, "ctx.logger.exporter()");
	}
	_resolveConfig() {
		let intercept = this.ctx[symbols.intercept];
		const configs = [];
		while ("logger" in intercept) {
			if (Object.hasOwn(intercept, "logger")) configs.unshift(intercept["logger"]);
			intercept = Object.getPrototypeOf(intercept);
		}
		return Object.assign({}, ...configs);
	}
	[symbols.invoke](name) {
		const config = this._resolveConfig();
		const fiber = (this[symbols.caller] ?? this.ctx).fiber;
		name ??= config.name;
		name ??= hyphenate(fiber.name);
		return new Logger({
			name,
			level: config.level,
			meta: { fiber: new WeakRef(fiber) }
		}, this);
	}
	static {
		for (const type of [
			"error",
			"info",
			"warn",
			"debug"
		]) LoggerService.prototype[type] = function(...args) {
			return this()[type](...args);
		};
	}
};
function enhanceError(error) {
	const lines = error.stack.split("\n");
	lines.splice(0, 2, `Error: ${error.message}`);
	error.stack = lines.join("\n");
	return error;
}
const RESERVED_WORDS = ["prototype", "then"];
function isSpecialProperty(prop) {
	return typeof prop === "symbol" || RESERVED_WORDS.includes(prop) || parseInt(prop).toString() === prop || prop.startsWith("_");
}
/**
* Reflection and service-resolution layer installed as `ctx.reflect`.
*
* This service powers the context proxy, service registration, accessors, and
* the mixins that expose core service methods directly on `ctx`.
*/
var ReflectService = class {
	ctx;
	/** Proxy traps implementing service resolution for every context object. */
	static handler = {
		get: (target, prop, ctx) => {
			if (isSpecialProperty(prop)) return Reflect.get(target, prop, ctx);
			if (Reflect.has(target, prop)) return getTraceable(ctx, Reflect.get(target, prop, ctx));
			const error = /* @__PURE__ */ new Error(`cannot get property "${prop}" without inject`);
			try {
				const def = target.reflect.props[prop];
				if (def?.type === "accessor") return def.get.call(ctx, ctx[symbols.receiver], error);
				const defSite = ctx[symbols.shadow] ?? ctx;
				if (!defSite.fiber.runtime) return ctx.reflect.get(prop, false);
				return ctx.events.waterfall("internal/get", ctx, prop, error, () => {
					const key = defSite[symbols.isolate][prop];
					let fiber = defSite.fiber;
					while (true) {
						let impl = fiber.committed?.[prop];
						for (const provision of fiber.provisions) if (provision.name === prop && provision.ctx[symbols.isolate][prop] === key) impl = provision;
						if (impl) return getTraceable(ctx, impl.value);
						if (prop in fiber.inject) {
							error.message = `cannot get required service "${prop}" in inactive context`;
							throw error;
						}
						if (!fiber.runtime) throw error;
						if (fiber.parent[symbols.isolate][prop] !== key) throw error;
						fiber = fiber.parent.fiber;
					}
				});
			} catch (e) {
				throw e === error ? enhanceError(e) : e;
			}
		},
		set: (target, prop, value, ctx) => {
			if (isSpecialProperty(prop)) return Reflect.set(target, prop, value, ctx);
			const error = /* @__PURE__ */ new Error(`cannot set property "${prop}" without provide`);
			const def = target.reflect.props[prop];
			if (!def) {
				if (!ctx.fiber.runtime) return Reflect.set(target, prop, value, ctx);
				throw enhanceError(error);
			}
			try {
				if (def.type === "accessor") {
					if (!def.set) return false;
					return def.set.call(ctx, value, ctx[symbols.receiver], error);
				}
				return ctx.events.waterfall("internal/set", ctx, prop, value, error, () => {
					return ctx.reflect.set(prop, value, error);
				});
			} catch (e) {
				throw e === error ? enhanceError(e) : e;
			}
		},
		has: (target, prop) => {
			if (isSpecialProperty(prop)) return Reflect.has(target, prop);
			if (Reflect.has(target, prop)) return true;
			return !!target.reflect.props[prop];
		}
	};
	/** Service implementations, keyed by isolation label. */
	store = Object.create(null);
	/** Declared context properties (services and accessors), by name. */
	props = Object.create(null);
	_implCounter = 0;
	constructor(ctx) {
		this.ctx = ctx;
		defineProperty(this, symbols.tracker, {
			property: "ctx",
			noShadow: true
		});
		this.mixin("reflect", [
			"get",
			"set",
			"provide",
			"accessor",
			"mixin"
		]);
		this.mixin("fiber", ["runtime", "effect"]);
		this.mixin("registry", ["inject", "plugin"]);
		this.mixin("events", [
			"on",
			"once",
			"parallel",
			"emit",
			"serial",
			"bail",
			"waterfall"
		]);
	}
	/**
	* Read a service from the store without the inject requirement.
	*
	* @param name — the service name.
	* @param strict — when `true`, only return implementations whose providing
	* fiber is currently active.
	* @returns the service value, or `undefined` when not (yet) provided.
	*/
	get(name, strict = true) {
		return getTraceable(this.ctx, this._getImpl(name, strict)?.value);
	}
	_getImpl(name, strict = true) {
		const key = this.ctx[symbols.isolate][name];
		const impl = key && this.store[key];
		if (!impl) return;
		if (strict && impl.ctx.fiber.state !== 2) return;
		return impl;
	}
	/**
	* Overwrite a provided service's value.
	*
	* @param name — the service name.
	* @param value — the new service value.
	* @param error — carrier for the caller stack in diagnostics.
	* @returns `true` on success.
	* @throws when `name` was never provided, or was provided by another fiber.
	*/
	set(name, value, error) {
		const key = this.ctx[symbols.isolate][name];
		const impl = this.store[key];
		if (!impl) throw new Error(`cannot set property "${name}" without provide`);
		if (impl.ctx.fiber !== this.ctx.fiber) throw new Error(`cannot set property "${name}" in multiple fibers`);
		impl.value = value;
		return true;
	}
	/**
	* Register a service implementation owned by the current fiber.
	*
	* See the `ctx.provide()` overload above for the full contract.
	*
	* @param name — the service name.
	* @param value — the service value.
	* @param check — optional availability predicate for dependents.
	* @returns a disposer that unregisters the service.
	*/
	provide(name, value, check) {
		return this.ctx.fiber.effect(() => {
			if (!this.props[name]) this.props[name] ??= { type: "service" };
			else if (this.props[name].type !== "service") throw new Error(`property "${name}" is already declared as ${this.props[name].type}`);
			this.props[name] = { type: "service" };
			this.ctx.root[symbols.isolate][name] ??= Symbol(name);
			const key = this.ctx[symbols.isolate][name];
			const impl = {
				uid: ++this._implCounter,
				name,
				value,
				ctx: this.ctx,
				check,
				isolate: key,
				dependents: /* @__PURE__ */ new Set()
			};
			if (this.store[key]) throw new Error(`service "${name}" has been registered at <${this.store[key].ctx.fiber.name}>`);
			this.store[key] = impl;
			this.ctx.fiber.provisions.add(impl);
			if (this.ctx.fiber.state === 2) this.notify([name]);
			return async () => {
				if (this.store[impl.isolate] === impl) delete this.store[impl.isolate];
				this.ctx.isolate(name, impl.isolate).reflect.notify([name]);
				await new Promise((resolve) => {
					impl.release = resolve;
					if (!impl.dependents.size) resolve();
				});
				impl.release = void 0;
				this.ctx.fiber.provisions.delete(impl);
			};
		}, `ctx.provide(${JSON.stringify(name)})`);
	}
	/**
	* Re-evaluate every fiber that requires one of the given services.
	*
	* @param names — the service names that changed.
	* @param filter — restricts notification to matching isolation scopes.
	*/
	notify(names, filter = (ctx, name) => ctx[symbols.isolate][name] === this.ctx[symbols.isolate][name]) {
		for (const runtime of this.ctx.registry.values()) for (const fiber of runtime.fibers) {
			let hasUpdate = false;
			for (const name of names) {
				if (!(name in fiber.inject)) continue;
				if (!filter(fiber.ctx, name)) continue;
				hasUpdate = true;
				fiber._checkImpl(name);
			}
			if (!hasUpdate) continue;
			fiber._refresh();
		}
		for (const name of names) {
			const self = Object.create(this.ctx);
			self[symbols.filter] = (target) => filter(target, name);
			this.ctx.events.emit(self, "internal/service", name, this._getImpl(name, false)?.value);
		}
	}
	/**
	* Define a computed context property backed by get/set hooks.
	*
	* @param name — the context property name.
	* @param options — the `get` hook and optional `set` hook.
	* @returns a disposer that removes the accessor.
	*/
	accessor(name, options) {
		return this.ctx.fiber.effect(() => {
			if (name in this.props) throw new Error(`property "${name}" is already declared as ${this.props[name].type}`);
			this.props[name] = {
				type: "accessor",
				...options
			};
			return () => delete this.props[name];
		}, `ctx.accessor(${JSON.stringify(name)})`);
	}
	/**
	* Expose selected members of a service directly on `ctx`.
	*
	* See the `ctx.mixin()` overload above for the full contract.
	*
	* @param source — a context property name or a source object.
	* @param mixins — keys to forward, or a source-key → ctx-key map.
	* @returns a disposer that removes all created accessors.
	*/
	mixin(source, mixins) {
		const self = this;
		return this.ctx.fiber.effect(function* () {
			const entries = Array.isArray(mixins) ? mixins.map((key) => [key, key]) : Object.entries(mixins);
			const getTarget = (ctx, error) => {
				return ctx[source];
			};
			for (const [key, value] of entries) yield self.accessor(value, {
				get(receiver, error) {
					const service = getTarget(this, error);
					if (isNullable(service)) return service;
					const mixin = receiver ? withProps(receiver, service) : service;
					const value = Reflect.get(service, key, mixin);
					if (typeof value !== "function") return value;
					return value.bind(mixin ?? service);
				},
				set(value, receiver, error) {
					const service = getTarget(this, error);
					const mixin = receiver ? withProps(receiver, service) : service;
					return Reflect.set(service, key, value, mixin);
				}
			});
		}, `ctx.mixin(${JSON.stringify(source)})`);
	}
	/**
	* Attach this context's tracing wrapper to a value.
	*
	* @param value — the value to wrap.
	* @returns the traceable wrapper (or the value itself when not applicable).
	*/
	trace(value) {
		return getTraceable(this.ctx, value);
	}
	/**
	* Wrap a callback so calls trace `this` and arguments to this context.
	*
	* @param callback — the function to wrap.
	* @returns a proxy delegating to `callback` with traced values.
	*/
	bind(callback) {
		return new Proxy(callback, {
			apply: (target, thisArg, args) => {
				return Reflect.apply(target, this.trace(thisArg), args.map((arg) => this.trace(arg)));
			},
			construct: (target, args, newTarget) => {
				return Reflect.construct(target, args.map((arg) => this.trace(arg)), newTarget);
			}
		});
	}
};
function isApplicable(object) {
	return object && typeof object === "object" && typeof object.apply === "function";
}
/**
* Decorator for declaring service dependencies on classes or class methods.
*
* On classes it contributes to the plugin's static `inject` map. On methods it
* delays the method call until the declared services are available.
*/
/**
* @param name — the required service name.
* @param config — optional intercept config applied for that service.
* @returns the class or method decorator.
*/
function Inject(name, config) {
	return function(value, decorator) {
		if (decorator.kind === "class") {
			if (!Object.hasOwn(value, "inject")) {
				defineProperty(value, "inject", Object.create(Object.getPrototypeOf(value).inject ?? null));
				defineProperty(value.inject, symbols.checkProto, true);
			}
			value.inject[name] = config;
		} else if (decorator.kind === "method") {
			const inject = (value[symbols.metadata] ??= {}).inject ??= Object.create(null);
			inject[name] = config;
			decorator.addInitializer(function() {
				const property = this[symbols.tracker]?.property;
				(this[symbols.initHooks] ??= []).push(() => {
					this.ctx.inject(inject, (ctx) => {
						return value.call(property ? withProps(this, { [property]: ctx }) : this);
					});
				});
			});
		} else throw new Error("@Inject() can only be used on class or class methods");
	};
}
/** Utilities for normalizing plugin dependency declarations. */
(function(Inject) {
	/**
	* Convert array/object/class-inherited inject metadata into a plain map.
	*
	* @param inject — the declaration to normalize; `null`/`undefined` add nothing.
	* @param result — the map to fill (service name → intercept config or `null`).
	* @returns `result`.
	*/
	function resolve(inject, result = Object.create(null)) {
		if (!inject) return result;
		if (Array.isArray(inject)) for (const name of inject) result[name] = null;
		else if (Reflect.has(inject, symbols.checkProto)) {
			Object.assign(result, resolve(Object.getPrototypeOf(inject)));
			for (const name of Object.keys(inject)) result[name] = inject[name] ?? null;
		} else for (const name of Object.keys(inject)) result[name] = inject[name] ?? null;
		return result;
	}
	Inject.resolve = resolve;
})(Inject || (Inject = {}));
/**
* Plugin registry installed as `ctx.registry` and mixed into every context.
*
* It normalizes plugin shapes, tracks plugin runtimes, starts fibers, and
* exposes map-like inspection over active plugin callbacks.
*/
var RegistryService = class {
	ctx;
	_counter = 0;
	_internal = /* @__PURE__ */ new Map();
	constructor(ctx) {
		this.ctx = ctx;
		defineProperty(this, symbols.tracker, {
			property: "ctx",
			noShadow: true
		});
	}
	/** Allocate the next fiber uid (increments on every read). */
	get counter() {
		return ++this._counter;
	}
	/** Number of registered plugin runtimes. */
	get size() {
		return this._internal.size;
	}
	/**
	* Resolve a supported plugin shape to its executable callback.
	*
	* @param plugin — a function, class, or `{ apply }` object plugin.
	* @returns the callback identifying the plugin, or `undefined` if invalid.
	*/
	resolve(plugin) {
		try {
			if (typeof plugin === "function") return plugin;
			if (isApplicable(plugin)) return plugin.apply;
		} catch {}
	}
	/**
	* Look up the runtime record for a plugin.
	*
	* @param plugin — any supported plugin shape.
	* @returns the runtime, or `undefined` when the plugin is not registered.
	*/
	get(plugin) {
		const key = this.resolve(plugin);
		return key && this._internal.get(key);
	}
	/**
	* Check whether a plugin has a registered runtime.
	*
	* @param plugin — any supported plugin shape.
	* @returns `true` when at least one fiber of the plugin exists.
	*/
	has(plugin) {
		const key = this.resolve(plugin);
		return !!key && this._internal.has(key);
	}
	/**
	* Dispose every running fiber for a plugin and remove its runtime record.
	*
	* @param plugin — any supported plugin shape.
	* @returns the removed runtime, or `undefined` when none was registered.
	*/
	delete(plugin) {
		const key = this.resolve(plugin);
		const runtime = key && this._internal.get(key);
		if (!runtime) return;
		this._internal.delete(key);
		for (const fiber of runtime.fibers) fiber.dispose();
		return runtime;
	}
	/** Iterate the registered plugin callbacks. */
	keys() {
		return this._internal.keys();
	}
	/** Iterate the registered plugin runtimes. */
	values() {
		return this._internal.values();
	}
	/** Iterate `[callback, runtime]` pairs. */
	entries() {
		return this._internal.entries();
	}
	/**
	* Visit every registered runtime.
	*
	* @param callback — receives each runtime and its identifying callback.
	*/
	forEach(callback) {
		return this._internal.forEach(callback);
	}
	/**
	* Start a callback once the requested dependencies are available.
	*
	* @param inject — required services, as an array or a name → config map.
	* @param callback — plugin body called with `(ctx, config)`.
	* @returns the fiber; awaiting it settles once loading finished.
	*/
	inject(inject, callback) {
		return this.plugin({
			inject,
			apply: callback,
			name: callback.name
		});
	}
	/**
	* Start a plugin in the current context and return its fiber.
	*
	* Creates (or reuses) the plugin's runtime record, then starts a new fiber
	* under the current context. Throws if `plugin` is not a supported shape or
	* if the current fiber is already disposed.
	*
	* @param plugin — a function, class, or `{ apply }` object plugin.
	* @param config — the plugin config, validated against its `Config` schema.
	* @param getOuterStack — captures the caller stack for effect diagnostics.
	* @returns the fiber; awaiting it settles once loading finished.
	*/
	plugin(plugin, config, getOuterStack = buildOuterStack()) {
		const callback = this.resolve(plugin);
		if (!callback) throw new Error("invalid plugin, expect function or object with an \"apply\" method, received " + typeof plugin);
		this.ctx.fiber.assertActive();
		let runtime = this._internal.get(callback);
		if (!runtime) {
			let name = plugin.name;
			if (name === "apply") name = void 0;
			runtime = {
				name,
				callback,
				fibers: new DisposableList(),
				Config: plugin.Config
			};
			this._internal.set(callback, runtime);
		}
		const fiber = new Fiber(this.ctx, config, Inject.resolve(plugin.inject), runtime, getOuterStack);
		const wrapped = Object.create(fiber);
		wrapped.then = (onFulfilled, onRejected) => {
			return fiber.await().then(onFulfilled, onRejected);
		};
		return wrapped;
	}
};
/**
* Root and child dependency containers for Cordis plugins.
*
* A context is a proxy: normal property reads go through the service resolver,
* while `extend()`, `isolate()`, and `intercept()` create scoped child
* contexts without mutating their parent.
*/
var Context = class Context {
	/** Symbol key under which a disposer exposes its {@link EffectMeta} diagnostics tree. */
	static effect = symbols.effect;
	/** Symbol key for a context's listener filter, consulted on every event dispatch. */
	static filter = symbols.filter;
	/** Symbol key of the isolation map (see the `Context[symbols.isolate]` property). */
	static isolate = symbols.isolate;
	/** Symbol key of the intercept map (see the `Context[symbols.intercept]` property). */
	static intercept = symbols.intercept;
	/**
	* Returns true for Cordis context proxies and context prototypes.
	*
	* Works across realms and across multiple copies of cordis, because the
	* brand is keyed by a global symbol rather than by `instanceof`.
	*
	* @param value — the value to test.
	* @returns `true` if `value` is a Cordis context, narrowing its type.
	*/
	static is(value) {
		return !!value?.[Context.is];
	}
	static {
		Context.is[Symbol.toPrimitive] = () => Symbol.for("cordis.is");
		Context.prototype[Context.is] = true;
	}
	/** Create the root context and install the built-in services. */
	constructor() {
		this[symbols.isolate] = Object.create(null);
		this[symbols.intercept] = Object.create(null);
		const self = new Proxy(this, ReflectService.handler);
		this.root = self;
		this.baseUrl = void 0;
		this.fiber = new Fiber(self, {}, Object.create(null), null, () => []);
		this.reflect = new ReflectService(self);
		this.registry = new RegistryService(self);
		this.events = new EventsService(self);
		this.logger = new LoggerService(self);
		this.fiber._disposables.clear();
		return self;
	}
	[Symbol.for("nodejs.util.inspect.custom")]() {
		return `Context <${this.fiber.name}>`;
	}
	/**
	* Create a child context with extra metadata on top of the current scope.
	*
	* The child prototypally inherits every property of this context; own
	* properties of `meta` shadow the inherited ones. The parent is not mutated.
	*
	* @param meta — own properties (including symbol keys) to define on the child.
	* @returns a child context inheriting from this one.
	*/
	extend(meta = {}) {
		const shadow = Reflect.getOwnPropertyDescriptor(this, symbols.shadow)?.value;
		const self = Object.create(getTraceable(this, this));
		for (const prop of Reflect.ownKeys(meta)) Object.defineProperty(self, prop, Reflect.getOwnPropertyDescriptor(meta, prop));
		if (!shadow) return self;
		return Object.assign(Object.create(self), { [symbols.shadow]: shadow });
	}
	/**
	* Create a child context with an independent service scope for `name`.
	*
	* Below the returned context, reads and writes of the service `name`
	* resolve against the new label instead of the parent's, so a different
	* implementation can be provided without affecting the parent scope.
	* Passing the same `label` to two `isolate()` calls joins their scopes.
	*
	* @param name — the service name to isolate.
	* @param label — scope label to join; defaults to a fresh unique symbol.
	* @returns a child context whose `name` service resolves in the new scope.
	*/
	isolate(name, label) {
		const shadow = Object.create(this[symbols.isolate]);
		shadow[name] = label ?? Symbol(name);
		return this.extend({ [symbols.isolate]: shadow });
	}
	intercept(name, config) {
		const intercept = Object.create(this[symbols.intercept]);
		intercept[name] = config;
		return this.extend({ [symbols.intercept]: intercept });
	}
};
/**
* Base class for services that expose a named API on `ctx`.
*
* Subclasses call `super(ctx, name)` from their constructor. The service is
* registered immediately and is automatically removed with the owning fiber.
*/
var Service = class Service {
	ctx;
	/** Symbol key of an instance method run after construction (class plugins). */
	static init = symbols.init;
	/** Symbol key of the availability predicate passed to `ctx.provide()`. */
	static check = symbols.check;
	/** Symbol key of the phantom intercept-config type parameter. */
	static config = symbols.config;
	/** Symbol key of the call body making a service callable (e.g. `ctx.logger()`). */
	static invoke = symbols.invoke;
	/** Symbol key of the helper deriving an extended service instance. */
	static extend = symbols.extend;
	/** Symbol key of the tracker metadata used for context tracing. */
	static tracker = symbols.tracker;
	/** Symbol key of the intercept-config resolution helper below. */
	static resolveConfig = symbols.resolveConfig;
	/** The service name this instance is registered under. */
	name;
	/**
	* Register this instance as `name` in the current context.
	*
	* Calls `ctx.reflect.provide(name, this, this[Service.check])`, so the
	* service is unregistered automatically when the owning fiber unloads.
	* Services with a `[Service.invoke]` body return a callable instance.
	*
	* @param ctx — the context to register in (stored as `this.ctx`).
	* @param name — the service name; defaults to the static `provide` field.
	*/
	constructor(ctx, name) {
		this.ctx = ctx;
		name ??= this.constructor["provide"];
		let self = this;
		const tracker = {
			associate: name,
			property: "ctx"
		};
		if (self[symbols.invoke]) self = createCallable(name, joinPrototype(Object.getPrototypeOf(this), Function.prototype), tracker);
		self.ctx = ctx;
		self.name = name;
		defineProperty(self, symbols.tracker, tracker);
		self.ctx.reflect.provide(name, self, this[symbols.check]);
		return self;
	}
	[symbols.filter](ctx) {
		return ctx[symbols.isolate][this.name] === this.ctx[symbols.isolate][this.name];
	}
	[symbols.extend](props) {
		let self;
		if (this[Service.invoke]) self = createCallable(this.name, this, this[symbols.tracker]);
		else self = Object.create(this);
		return Object.assign(self, props);
	}
	/**
	* Merge intercept config from ancestors with optional base and head values.
	*
	* Entries added closer to the root apply first; `base` is prepended and
	* `head` appended. Uses `Config.merge` when the service declares one,
	* otherwise a shallow `Object.assign`.
	*
	* @param base — lowest-precedence config merged before all intercepts.
	* @param head — highest-precedence config merged after all intercepts.
	* @returns the merged config.
	*/
	[symbols.resolveConfig](base, head) {
		let intercept = this.ctx[Context.intercept];
		const configs = [];
		while (this.name in intercept) {
			if (Object.hasOwn(intercept, this.name)) configs.unshift(intercept[this.name]);
			intercept = Object.getPrototypeOf(intercept);
		}
		if (base) configs.unshift(base);
		if (head) configs.push(head);
		if (this["Config"]?.merge) return this["Config"].merge(...configs);
		else return Object.assign({}, ...configs);
	}
	static [Symbol.hasInstance](instance) {
		if (!instance) return false;
		let constructor = instance.constructor;
		while (constructor) {
			constructor = constructor.prototype?.constructor;
			if (constructor === this) return true;
			constructor &&= Object.getPrototypeOf(constructor);
		}
		return false;
	}
};
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-typert-protocol@0.2.2-alpha.3_@deepseek-ai+cordis@4.0.6-alpha.2/node_modules/@deepseek-ai/dsh-typert-protocol/lib/index.js
/** The one Remote failure class shared by owners, the Gateway, and consumers. */
/**
* One Remote call failure: a real Error carrying its stable code and typed
* details. Owners throw it at the failure point; the Host Gateway encodes it
* onto the wire unchanged; the Client face rebuilds an instance for the
* `RemoteResult` error branch, so `throw result.error` keeps throw semantics.
* Discrimination is always by `code`, never by instanceof.
*/
var RemoteError = class extends Error {
	code;
	details;
	/** Structural marker: cross-realm/bundle identification never uses instanceof. */
	isDSHRemoteError = true;
	/**
	* @param code - stable failure code declared in {@link RemoteErrorDetailsMap}.
	* @param message - human diagnostic carried across the wire.
	* @param details - structured payload typed by the code.
	* @param options - standard Error options (`cause` survives in-process only).
	*/
	constructor(code, message, details, options) {
		super(message, options);
		this.code = code;
		this.details = details;
		this.name = "RemoteError";
	}
};
/**
* Remote decorators and explicit Gateway bindings backed by versioned
* descriptors carried on decorated class prototypes. Strict reflection
* remains a Typert compiler responsibility.
* @module @deepseek-ai/dsh-typert-protocol
*/
const TYPERT_REMOTE_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;
/**
* Test one generated Remote name against the Connection endpoint grammar.
* @param value - namespace, method, lookup, or Context segment.
* @returns whether the value can cross the shared RPC carrier unchanged.
*/
function isTypertRemoteSegment(value) {
	return value !== "." && value !== ".." && TYPERT_REMOTE_SEGMENT_PATTERN.test(value);
}
const REMOTE_METHOD_DESCRIPTOR = "@deepseek-ai/dsh-typert-protocol/remote-methods";
/**
* Bind one visible Service field to a Cordis key and Remote namespace. A
* service that owns a Cordis Context also gives its tree `ctx.invocation`,
* `undefined` outside a Remote call, so no `TypertRemoteService` is needed for
* a Host composition to read it.
* @param service - owning Service instance, normally `this`.
* @param serviceKey - exact Cordis service key.
* @param options - optional wire namespace.
* @returns a frozen, inspectable binding with no compiler-injected metadata.
*/
function bindTypertRemote(service, serviceKey, options = {}) {
	validateName("service key", serviceKey);
	const namespace = options.namespace ?? serviceKey;
	validateName("namespace", namespace);
	const ctx = Reflect.get(service, "ctx");
	if (Context.is(ctx)) provideInvocationAccessor(ctx);
	return Object.freeze({
		service,
		serviceKey,
		namespace
	});
}
/** Cordis Service base that exposes its registered name through Typert Gateway. */
var TypertRemoteService = class extends Service {
	/** Visible binding consumed by the Gateway's source-mode discovery. */
	typertRemote;
	/**
	* Register the Service and bind the same key to Typert Gateway.
	* @param ctx - owning Cordis Context.
	* @param serviceKey - exact Cordis service key and default wire namespace.
	* @param options - optional wire namespace.
	*/
	constructor(ctx, serviceKey, options = {}) {
		super(ctx, serviceKey);
		this.typertRemote = bindTypertRemote(this, this.name, options);
	}
};
/**
* Make `ctx.invocation` read as `undefined` outside a Remote call instead of the
* reflect service's "cannot get property" error; a call-derived Context shadows
* the accessor with its own property. The first Remote Service constructed in a
* tree registers it on the root, where it outlives any one Service.
*/
function provideInvocationAccessor(ctx) {
	if (Object.hasOwn(ctx.root.reflect.props, "invocation")) return;
	ctx.root.accessor("invocation", { get: () => void 0 });
}
function Remote(methodExportOrOptions, context) {
	if (typeof methodExportOrOptions === "string") {
		validateName("Remote export name", methodExportOrOptions);
		return remoteDecorator({ kind: "direct" }, { exportName: methodExportOrOptions });
	}
	if (typeof methodExportOrOptions === "object") return remoteDecorator({ kind: "direct" }, markerOptions(methodExportOrOptions, REMOTE_OPTION_KEYS, "Remote options require name, mode: \"stream\", or resources"));
	if (context === void 0) throw new TypeError("typert-protocol: Remote decorator context is missing");
	addMarkerInitializer(context, { kind: "direct" });
}
const REMOTE_OPTION_KEYS = /* @__PURE__ */ new Set([
	"name",
	"mode",
	"resources"
]);
/** Validate one decorator options object against its accepted keys and select the marker fields. */
function markerOptions(options, accepted, requirement) {
	const keys = Reflect.ownKeys(options);
	if (keys.length === 0 || keys.some((key) => typeof key !== "string" || !accepted.has(key)) || Object.hasOwn(options, "mode") && options.mode !== "stream") throw new TypeError(`typert-protocol: ${requirement}`);
	const { mode, name, resources } = options;
	if (name !== void 0) validateName("Remote export name", name);
	return {
		...mode === void 0 ? {} : { mode },
		...name === void 0 ? {} : { exportName: name },
		...resources === void 0 ? {} : { resources: resourceReaders(resources) }
	};
}
/** Freeze declared readers into the marker record; a misdeclared reader fails at decoration. */
function resourceReaders(resources) {
	const readers = {};
	for (const [kind, reader] of Object.entries(resources)) {
		if (typeof reader !== "function") throw new TypeError(`typert-protocol: Remote resource reader "${kind}" must be a function`);
		readers[kind] = reader;
	}
	if (Object.keys(readers).length === 0) throw new TypeError("typert-protocol: Remote resources require at least one reader");
	return Object.freeze(readers);
}
function remoteDecorator(invocation, options = {}) {
	return function(_method, context) {
		addMarkerInitializer(context, invocation, options);
	};
}
function readRemoteMethodDescriptor(prototype) {
	const property = Object.getOwnPropertyDescriptor(prototype, REMOTE_METHOD_DESCRIPTOR);
	if (property === void 0) return void 0;
	const descriptor = property.value;
	if (descriptor === null || typeof descriptor !== "object") throw new TypeError("typert-protocol: Remote method descriptor must be an object");
	const version = Reflect.get(descriptor, "version");
	if (version !== 1) throw new TypeError(`typert-protocol: unsupported Remote method descriptor version ${String(version)}`);
	const methods = Reflect.get(descriptor, "methods");
	if (!Array.isArray(methods)) throw new TypeError("typert-protocol: Remote method descriptor methods must be an array");
	return descriptor;
}
function addMarkerInitializer(context, invocation, options = {}) {
	if (context.private || context.static || typeof context.name !== "string") throw new TypeError("typert-protocol: Remote decorators require a public instance method with a string name");
	const method = context.name;
	context.addInitializer(function() {
		const prototype = Object.getPrototypeOf(this);
		if (prototype === null) throw new TypeError(`typert-protocol: cannot mark Remote method "${method}" on an object without a prototype`);
		mark(prototype, method, invocation, options);
	});
}
function mark(prototype, method, invocation, { mode, exportName, resources }) {
	const descriptor = readRemoteMethodDescriptor(prototype);
	const marker = Object.freeze({
		method,
		...exportName === void 0 || exportName === method ? {} : { exportName },
		...mode === void 0 ? {} : { mode },
		invocation: Object.freeze(invocation),
		...resources === void 0 ? {} : { resources }
	});
	const current = descriptor?.methods.find((candidate) => candidate.method === method);
	if (current !== void 0) {
		if (current.exportName === marker.exportName && current.mode === marker.mode && current.resources === marker.resources && sameInvocation(current.invocation, invocation)) return;
		throw new Error(`typert-protocol: Remote method "${method}" has conflicting invocation markers`);
	}
	Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
		configurable: true,
		value: Object.freeze({
			version: 1,
			methods: Object.freeze([...descriptor?.methods ?? [], marker])
		})
	});
}
function sameInvocation(left, right) {
	if (left.kind === "direct") return right.kind === "direct";
	if (right.kind === "direct") return false;
	return left.context === right.context;
}
function validateName(subject, value) {
	if (!isTypertRemoteSegment(value)) throw new TypeError(`typert-protocol: ${subject} must contain only RPC endpoint segment characters`);
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-util-values@0.2.2-alpha.3_@deepseek-ai+cordis@4.0.6-alpha.2/node_modules/@deepseek-ai/dsh-util-values/lib/index.js
/**
* Lazily scanned view of one JSON object's top-level fields, built from text
* that may still be streaming or from an already parsed object. Nothing is
* scanned until a reader asks; the view remembers every question it answered
* and reports changed answers when the owner refreshes for publication.
* Used for model tool-call arguments: a row reads the fields it
* cares about at whatever granularity it displays, at every stage of the call.
* @module @deepseek-ai/dsh-util-values/src/partial-json
*/
const SIMPLE_ESCAPES = {
	"\"": "\"",
	"\\": "\\",
	"/": "/",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "	"
};
const CONTENT_ESCAPE = /[\\\u0000-\u001f]/u;
function isWhitespace(c) {
	return c === " " || c === "\n" || c === "\r" || c === "	";
}
function isHex(c) {
	return c >= "0" && c <= "9" || c >= "a" && c <= "f" || c >= "A" && c <= "F";
}
(class PartialArguments {
	/** The view of a call with no arguments available. */
	static EMPTY = PartialArguments.fromObject({});
	/**
	* View finished argument text without scanning it until a reader asks.
	* @param text - the complete argument JSON text.
	* @returns a sealed view.
	*/
	static fromText(text) {
		const view = new PartialArguments();
		view.append(text);
		view.sealed = true;
		return view;
	}
	/**
	* View an already parsed argument payload, such as a PTC dispatch object.
	* @param value - the parsed argument value.
	* @returns a sealed view; a non-object payload has no fields.
	*/
	static fromObject(value) {
		const view = new PartialArguments();
		view.object = typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
		view.sealed = true;
		return view;
	}
	/**
	* The source: text so far or a parsed object, plus whether it can still grow.
	* These are the only enumerable fields, so two views over the same source
	* compare equal structurally however far each has been read.
	*/
	chunks = [];
	object;
	sealed = false;
	#ends = [];
	#size = 0;
	#consumed = 0;
	#mode = "root";
	#escape = false;
	#keyStart = 0;
	#keyEscaped = false;
	#key = "";
	#current = null;
	#nestedEnds = [];
	#nestedInString = false;
	#invalidAt;
	#invalidValue = false;
	#entries = /* @__PURE__ */ new Map();
	#order = [];
	#reads = /* @__PURE__ */ new Map();
	/** Whether this view rejects further appends; does not scan text or register reads. */
	get isSealed() {
		return this.sealed;
	}
	/** Whether indexing or a content read found invalid JSON; unread value contents are not validated. */
	get invalid() {
		this.scan();
		return this.#mode === "invalid" || this.#invalidValue;
	}
	/**
	* Retain streamed argument text without scanning or comparing observed answers.
	* @param fragment - the text following every fragment appended before.
	*/
	append(fragment) {
		if (this.sealed) throw new Error("PartialArguments: cannot append to a sealed view");
		if (fragment.length === 0) return;
		this.chunks.push(fragment);
		this.#size += fragment.length;
		this.#ends.push(this.#size);
	}
	/**
	* Reconcile a streamed prefix with authoritative complete text without joining the fragments.
	* @param text - the final argument text, which replaces missing or conflicting deltas.
	* @returns this view sealed with its caches retained when every character matches; otherwise a new sealed view.
	*/
	settle(text) {
		if (this.object !== void 0 || text.length !== this.#size) return PartialArguments.fromText(text);
		let offset = 0;
		for (const chunk of this.chunks) {
			if (!text.startsWith(chunk, offset)) return PartialArguments.fromText(text);
			offset += chunk.length;
		}
		this.chunks = text.length === 0 ? [] : [text];
		this.#ends = text.length === 0 ? [] : [text.length];
		this.sealed = true;
		return this;
	}
	/**
	* Compare observed answers and advance their publication baseline. Unread views remain unscanned.
	* @returns whether any observed answer changed since its first read or the preceding refresh.
	*/
	refresh() {
		if (this.#reads.size === 0) return false;
		this.scan();
		let changed = false;
		let completions = false;
		for (const read of this.#reads.values()) {
			if (read.completion) {
				completions = true;
				continue;
			}
			changed = this.refreshRead(read) || changed;
		}
		if (completions) {
			for (const read of this.#reads.values()) if (read.completion) changed = this.refreshRead(read) || changed;
		}
		if (this.sealed) this.#reads.clear();
		return changed;
	}
	refreshRead(read) {
		const now = read.answer();
		if (Object.is(now, read.last)) return false;
		read.last = now;
		return true;
	}
	/**
	* Check whether no further fields can arrive.
	* @returns whether the outer object closed, indexing failed, or the view is sealed; unread values are not validated.
	*/
	closed() {
		return this.remember("closed", "", () => this.closedNow());
	}
	/**
	* List discovered fields in first-appearance order.
	* @returns top-level keys seen so far, in first-appearance order.
	*/
	keys() {
		return this.remember("keys", "", () => this.keysNow(), (keys) => keys.length);
	}
	/**
	* Check whether a top-level field has appeared.
	* @param key - argument name.
	* @returns whether the field has appeared (a string opened or another value began).
	*/
	has(key) {
		return this.remember("has", key, () => this.hasNow(key));
	}
	/**
	* Check whether a field's closing delimiter has arrived, without validating its contents.
	* @param key - argument name.
	* @returns whether its delimiter arrived and no content reader has reported an error for this value.
	*/
	complete(key) {
		return this.remember("complete", key, () => this.completeNow(key));
	}
	/**
	* Read string length without materializing its text.
	* @param key - argument name.
	* @param options - change granularity for a streaming string.
	* @returns decoded UTF-16 length of the string field so far; undefined when absent or not a string.
	*/
	stringLength(key, options) {
		const step = Math.max(1, Math.floor(options?.step ?? 1));
		const offset = options?.offset ?? 0;
		return this.remember(`length:${step}:${offset}`, key, () => this.lengthNow(key), (length) => length === void 0 ? void 0 : Math.ceil((length + offset) / step));
	}
	/**
	* Check a string against a decoded UTF-16 length limit without materializing it.
	* @param key - argument name.
	* @param maxLength - decoded UTF-16 limit, floored to at least zero.
	* @returns whether the string is longer than the limit; false when absent or not a string.
	*/
	stringExceeds(key, maxLength) {
		const limit = Math.max(0, Math.floor(maxLength));
		return this.remember(`exceeds:${limit}`, key, () => (this.lengthNow(key, limit + 1) ?? 0) > limit);
	}
	/**
	* Read a decoded string, including a streaming prefix.
	* @param key - argument name.
	* @returns the string field's decoded text so far; undefined when absent or not a string.
	*/
	text(key) {
		return this.remember("text", key, () => this.textNow(key));
	}
	/**
	* Read at most the first decoded UTF-16 units of a string.
	* @param key - argument name.
	* @param maxLength - maximum decoded UTF-16 length, floored to at least one.
	* @returns the bounded string prefix; undefined when absent or not a string.
	*/
	textPrefix(key, maxLength) {
		const limit = Math.max(1, Math.floor(maxLength));
		return this.remember(`prefix:${limit}`, key, () => this.textPrefixNow(key, limit));
	}
	/**
	* Read a completed non-string argument.
	* @param key - argument name.
	* @returns the parsed non-string value once it closed; undefined while open, absent, or a string.
	*/
	value(key) {
		return this.remember("value", key, () => this.valueNow(key));
	}
	/** Answer a question and, on a streaming view, remember it for change detection. */
	remember(kind, key, read, comparison) {
		this.scan();
		const result = read();
		if (!this.sealed) {
			const id = `${kind}/${key}`;
			if (!this.#reads.has(id)) this.#reads.set(id, {
				completion: kind === "complete",
				answer: comparison === void 0 ? read : () => comparison(read()),
				last: comparison === void 0 ? result : comparison(result)
			});
		}
		return result;
	}
	closedNow() {
		return this.sealed || this.#mode === "closed" || this.#mode === "invalid";
	}
	keysNow() {
		return this.object === void 0 ? this.#order : Object.keys(this.object);
	}
	hasNow(key) {
		return this.object === void 0 ? this.#entries.has(key) : Object.hasOwn(this.object, key);
	}
	completeNow(key) {
		if (this.object !== void 0) return Object.hasOwn(this.object, key);
		const entry = this.#entries.get(key);
		return entry !== void 0 && entry.end >= 0 && (entry.kind === "string" ? entry.invalidAt === void 0 : !entry.invalid);
	}
	lengthNow(key, limit = Number.POSITIVE_INFINITY) {
		if (this.object !== void 0) {
			const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
			return typeof field === "string" ? field.length : void 0;
		}
		const entry = this.#entries.get(key);
		if (entry?.kind !== "string") return void 0;
		if (entry.text !== void 0 && entry.text.at === entry.end) return entry.text.length;
		const read = entry.length ??= {
			at: entry.start,
			length: 0,
			text: ""
		};
		this.readString(entry, read, limit, false);
		return read.length;
	}
	textNow(key) {
		if (this.object !== void 0) {
			const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
			return typeof field === "string" ? field : void 0;
		}
		const entry = this.#entries.get(key);
		if (entry?.kind !== "string") return void 0;
		if (entry.text === void 0 && entry.end >= 0 && entry.needsDecoding && entry.invalidAt === void 0) {
			let text;
			try {
				text = JSON.parse(`"${this.slice(entry.start, entry.end)}"`);
			} catch (_error) {}
			if (text !== void 0) entry.text = {
				at: entry.end,
				length: text.length,
				text
			};
		}
		const read = entry.text ??= {
			at: entry.start,
			length: 0,
			text: ""
		};
		this.readString(entry, read, Number.POSITIVE_INFINITY, true);
		return read.text;
	}
	textPrefixNow(key, maxLength) {
		if (this.object !== void 0) {
			const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
			return typeof field === "string" ? field.slice(0, maxLength) : void 0;
		}
		const entry = this.#entries.get(key);
		if (entry?.kind !== "string") return void 0;
		const prefixes = entry.prefixes ??= /* @__PURE__ */ new Map();
		let read = prefixes.get(maxLength);
		if (read === void 0) {
			read = {
				at: entry.start,
				length: 0,
				text: ""
			};
			prefixes.set(maxLength, read);
		}
		this.readString(entry, read, maxLength, true);
		return read.text;
	}
	valueNow(key) {
		if (this.object !== void 0) {
			if (!Object.hasOwn(this.object, key)) return void 0;
			const field = this.object[key];
			return typeof field === "string" ? void 0 : field;
		}
		const entry = this.#entries.get(key);
		if (entry?.kind !== "value" || entry.end < 0 || entry.invalid) return void 0;
		if (entry.parsed === void 0) try {
			entry.parsed = JSON.parse(this.slice(entry.start, entry.end));
		} catch (_error) {
			entry.invalid = true;
			this.#invalidValue = true;
		}
		return entry.parsed;
	}
	chunkAt(at) {
		let low = 0;
		let high = this.#ends.length;
		while (low < high) {
			const mid = low + high >>> 1;
			if (this.#ends[mid] <= at) low = mid + 1;
			else high = mid;
		}
		return low;
	}
	/** Materialize only a requested range, never the cumulative source. */
	slice(start, end) {
		if (start >= end) return "";
		const first = this.chunkAt(start);
		const last = this.chunkAt(end - 1);
		const base = first === 0 ? 0 : this.#ends[first - 1];
		if (first === last) return this.chunks[first].slice(start - base, end - base);
		const parts = [this.chunks[first].slice(start - base)];
		for (let i = first + 1; i < last; i++) parts.push(this.chunks[i]);
		parts.push(this.chunks[last].slice(0, end - this.#ends[last - 1]));
		return parts.join("");
	}
	readString(entry, read, limit, materialize) {
		const end = Math.min(entry.end < 0 ? this.#consumed : entry.end, entry.invalidAt ?? Number.POSITIVE_INFINITY, this.#invalidAt ?? Number.POSITIVE_INFINITY);
		if (!entry.needsDecoding) {
			const length = Math.min(end - read.at, limit - read.length);
			if (length <= 0) return;
			if (materialize) read.text += this.slice(read.at, read.at + length);
			read.at += length;
			read.length += length;
			return;
		}
		let chunkIndex = this.chunkAt(read.at);
		while (read.at < end && read.length < limit) {
			const base = chunkIndex === 0 ? 0 : this.#ends[chunkIndex - 1];
			const chunk = this.chunks[chunkIndex];
			const remaining = chunk.slice(read.at - base, Math.min(chunk.length, end - base));
			const boundary = remaining.search(CONTENT_ESCAPE);
			const length = Math.min(boundary < 0 ? remaining.length : boundary, limit - read.length);
			if (length > 0) {
				if (materialize) read.text += remaining.slice(0, length);
				read.at += length;
				read.length += length;
				if (read.at === base + chunk.length) chunkIndex++;
				continue;
			}
			const type = remaining.length > 1 ? remaining[1] : read.at + 1 < end ? this.chunks[chunkIndex + 1][0] : void 0;
			let decoded;
			let width = 2;
			if (remaining[0] === "\\" && type === void 0 && entry.end < 0) return;
			if (remaining[0] === "\\" && type === "u") {
				const hex = this.slice(read.at + 2, Math.min(end, read.at + 6));
				let valid = true;
				for (let i = 0; i < hex.length; i++) if (!isHex(hex[i])) valid = false;
				if (valid) {
					if (hex.length < 4 && entry.end < 0) return;
					if (hex.length === 4) decoded = String.fromCharCode(Number.parseInt(hex, 16));
				}
				width = 6;
			} else if (remaining[0] === "\\" && type !== void 0) decoded = SIMPLE_ESCAPES[type];
			if (decoded === void 0) {
				entry.invalidAt = read.at;
				this.#invalidValue = true;
				return;
			}
			if (materialize) read.text += decoded;
			read.length++;
			read.at += width;
			while (chunkIndex < this.chunks.length && read.at >= this.#ends[chunkIndex]) chunkIndex++;
		}
	}
	/** Locate new field ranges without decoding or parsing their contents. */
	scan() {
		if (this.object !== void 0 || this.#consumed === this.#size) return;
		for (let i = this.chunkAt(this.#consumed); i < this.chunks.length && this.#invalidAt === void 0; i++) {
			const pending = this.chunks[i];
			const base = i === 0 ? 0 : this.#ends[i - 1];
			for (let index = this.#consumed - base; index < pending.length && this.#mode !== "invalid"; index++) {
				if (this.#mode === "string" || this.#mode === "nested" && this.#nestedInString) {
					const end = this.stringBoundary(pending, index);
					this.#consumed += end - index;
					index = end;
					if (index === pending.length) break;
				}
				this.step(pending[index], this.#consumed);
				this.#consumed++;
			}
		}
	}
	/** Only raw quotes and their preceding backslash runs can terminate a string. */
	stringBoundary(fragment, start) {
		let at = start;
		while (true) {
			const quote = fragment.indexOf("\"", at);
			const end = quote < 0 ? fragment.length : quote;
			if (this.#mode === "string") {
				const entry = this.#current;
				if (!entry.needsDecoding && CONTENT_ESCAPE.test(fragment.slice(at, end))) entry.needsDecoding = true;
			}
			let slashStart = end;
			while (slashStart > at && fragment[slashStart - 1] === "\\") slashStart--;
			const escaped = (end - slashStart) % 2 === 1 !== (slashStart === at && this.#escape);
			this.#escape = quote < 0 && escaped;
			if (quote < 0 || !escaped) return end;
			at = quote + 1;
		}
	}
	step(c, at) {
		switch (this.#mode) {
			case "root":
				if (isWhitespace(c)) return;
				if (c === "{") {
					this.#mode = "key-or-end";
					return;
				}
				this.fail();
				return;
			case "key-or-end":
				if (isWhitespace(c)) return;
				if (c === "}") {
					this.#mode = "closed";
					return;
				}
				if (c === "\"") {
					this.beginKey(at);
					return;
				}
				this.fail();
				return;
			case "key-only":
				if (isWhitespace(c)) return;
				if (c === "\"") {
					this.beginKey(at);
					return;
				}
				this.fail();
				return;
			case "key":
				this.stepKey(c, at);
				return;
			case "colon":
				if (isWhitespace(c)) return;
				if (c === ":") {
					this.#mode = "value";
					return;
				}
				this.fail();
				return;
			case "value":
				this.beginValue(c, at);
				return;
			case "string": {
				const entry = this.#current;
				entry.end = at;
				this.#current = null;
				this.#mode = "comma-or-end";
				return;
			}
			case "scalar":
				this.stepScalar(c, at);
				return;
			case "nested":
				this.stepNested(c, at);
				return;
			case "comma-or-end":
				if (isWhitespace(c)) return;
				if (c === ",") {
					this.#mode = "key-only";
					return;
				}
				if (c === "}") {
					this.#mode = "closed";
					return;
				}
				this.fail();
				return;
			case "closed":
				if (isWhitespace(c)) return;
				this.fail();
				return;
			/* v8 ignore next 2 -- scan() stops stepping once the view is invalid. */
			case "invalid": return;
			/* v8 ignore next 2 -- Every scanner mode has a handler above. */
			default: assertNever(this.#mode);
		}
	}
	fail() {
		this.#invalidAt = this.#consumed;
		this.#mode = "invalid";
		this.#current = null;
	}
	beginKey(at) {
		this.#mode = "key";
		this.#keyStart = at + 1;
		this.#keyEscaped = false;
		this.#escape = false;
	}
	stepKey(c, at) {
		if (c < " ") {
			this.fail();
			return;
		}
		if (this.#escape) {
			this.#escape = false;
			return;
		}
		if (c === "\\") {
			this.#escape = true;
			this.#keyEscaped = true;
			return;
		}
		if (c !== "\"") return;
		const raw = this.slice(this.#keyStart, at);
		if (this.#keyEscaped) try {
			this.#key = JSON.parse(`"${raw}"`);
		} catch (_error) {
			this.fail();
			return;
		}
		else this.#key = raw;
		this.#mode = "colon";
	}
	open(entry) {
		if (!this.#entries.has(this.#key)) this.#order.push(this.#key);
		this.#entries.set(this.#key, entry);
		this.#current = entry;
	}
	beginValue(c, at) {
		if (isWhitespace(c)) return;
		if (c === "\"") {
			this.open({
				kind: "string",
				start: at + 1,
				end: -1,
				needsDecoding: false,
				invalidAt: void 0,
				length: void 0,
				text: void 0,
				prefixes: void 0
			});
			this.#escape = false;
			this.#mode = "string";
			return;
		}
		if (c === "}" || c === "," || c === ":" || c === "]") {
			this.fail();
			return;
		}
		this.open({
			kind: "value",
			start: at,
			end: -1,
			parsed: void 0,
			invalid: false
		});
		if (c === "{" || c === "[") {
			this.#mode = "nested";
			this.#nestedEnds = [c === "{" ? "}" : "]"];
			this.#nestedInString = false;
			this.#escape = false;
			return;
		}
		this.#mode = "scalar";
	}
	stepScalar(c, at) {
		if (c !== "," && c !== "}" && !isWhitespace(c)) return;
		this.closeValue(at);
		this.#mode = c === "," ? "key-only" : c === "}" ? "closed" : "comma-or-end";
	}
	stepNested(c, at) {
		if (this.#nestedInString) {
			this.#nestedInString = false;
			return;
		}
		if (c === "\"") {
			this.#nestedInString = true;
			return;
		}
		if (c === "{" || c === "[") {
			this.#nestedEnds.push(c === "{" ? "}" : "]");
			return;
		}
		if (c === "}" || c === "]") {
			if (this.#nestedEnds.pop() !== c) {
				this.fail();
				return;
			}
			if (this.#nestedEnds.length === 0) {
				this.closeValue(at + 1);
				this.#mode = "comma-or-end";
			}
		}
	}
	closeValue(end) {
		const entry = this.#current;
		entry.end = end;
		this.#current = null;
	}
});
/** Duplicate-install-safe JSON and immutable-value helpers. @module @deepseek-ai/dsh-util-values */
/**
* Mark an unreachable closed-union branch.
* @param value - impossible value; an unhandled typed variant fails at the call site.
* @param context - optional switch-site label included in the failure message.
* @returns never; a runtime value that escaped its type always throws.
*/
function assertNever(value, context) {
	const rendered = JSON.stringify(value) ?? String(value);
	throw new Error(`unreachable variant${context ? ` in ${context}` : ""}: ${rendered}`);
}
/** Whether a realm-owned intrinsic prototype has a native constructor matching this engine's representation. */
function hasIntrinsicConstructor$1(prototype, name) {
	const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
	if (typeof constructor !== "function") return false;
	try {
		return constructor.name === name && constructor.prototype === prototype && Function.prototype.toString.call(constructor) === Function.prototype.toString.call(name === "Array" ? Array : Object);
	} catch {
		return false;
	}
}
/** Whether a candidate is one realm's intrinsic `Object.prototype`. */
function isIntrinsicObjectPrototype$1(value) {
	return Object.getPrototypeOf(value) === null && hasIntrinsicConstructor$1(value, "Object");
}
/** Whether an array uses one realm's intrinsic `Array.prototype`, not a subclass or forged prototype. */
function hasPlainArrayPrototype$1(value) {
	const prototype = Object.getPrototypeOf(value);
	if (!Array.isArray(prototype) || !hasIntrinsicConstructor$1(prototype, "Array")) return false;
	const objectPrototype = Object.getPrototypeOf(prototype);
	return typeof objectPrototype === "object" && objectPrototype !== null && isIntrinsicObjectPrototype$1(objectPrototype);
}
/** Whether an object is a plain or null-prototype record from any JavaScript realm. */
function hasPlainObjectPrototype(value) {
	const prototype = Object.getPrototypeOf(value);
	return prototype === null || typeof prototype === "object" && isIntrinsicObjectPrototype$1(prototype);
}
/** Return every JSON-visible object key, or reject own data JSON would discard. */
function enumerableStringKeys(value) {
	const keys = Reflect.ownKeys(value);
	if (keys.some((key) => typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(value, key))) return void 0;
	return keys;
}
/** Validate lossless JSON iteratively, optionally materializing a detached snapshot. */
function walkJsonValue(value, detach) {
	const ancestors = /* @__PURE__ */ new Set();
	let root;
	let parent;
	const assign = (item) => {
		if (parent === void 0) {
			if (detach) root = item;
		} else if (parent.kind === "array") {
			if (parent.target !== void 0) parent.target[parent.key] = item;
		} else if (parent.target !== void 0) Object.defineProperty(parent.target, parent.key, {
			value: item,
			enumerable: true,
			configurable: true,
			writable: true
		});
	};
	const frames = [];
	let current = value;
	for (;;) {
		if (current === null) assign(null);
		else if (typeof current === "boolean" || typeof current === "string") assign(current);
		else if (typeof current === "number") {
			if (!Number.isFinite(current) || Object.is(current, -0)) return void 0;
			assign(current);
		} else {
			if (typeof current !== "object") return void 0;
			if (ancestors.has(current)) return void 0;
			if (Array.isArray(current)) {
				if (!hasPlainArrayPrototype$1(current)) return void 0;
				const length = current.length;
				if (Reflect.ownKeys(current).length !== length + 1) return void 0;
				const target = detach ? [] : void 0;
				if (target !== void 0) assign(target);
				let indices;
				if (!Number.isInteger(length)) {
					indices = [];
					for (let index = length - 1; index >= 0; index--) indices.push(index);
				}
				frames.push({
					kind: "array",
					source: current,
					length: indices?.length ?? length,
					index: 0,
					key: 0,
					indices,
					target
				});
			} else {
				if (!hasPlainObjectPrototype(current)) return void 0;
				const keys = enumerableStringKeys(current);
				if (keys === void 0) return void 0;
				const target = detach ? {} : void 0;
				if (target !== void 0) assign(target);
				frames.push({
					kind: "object",
					source: current,
					keys,
					index: 0,
					key: "",
					target
				});
			}
			ancestors.add(current);
		}
		for (;;) {
			const frame = frames.at(-1);
			if (frame === void 0) return detach ? root : true;
			const length = frame.kind === "array" ? frame.length : frame.keys.length;
			if (frame.index >= length) {
				ancestors.delete(frame.source);
				frames.pop();
				continue;
			}
			const index = frame.index++;
			parent = frame;
			if (frame.kind === "array") {
				const key = frame.indices === void 0 ? index : frame.indices[frame.indices.length - index - 1];
				/* v8 ignore next -- the loop is bounded by the captured index count. */
				if (key === void 0) return void 0;
				if (!Object.prototype.hasOwnProperty.call(frame.source, key)) return void 0;
				frame.key = key;
				current = frame.source[key];
			} else {
				const key = frame.keys[index];
				/* v8 ignore next -- the loop is bounded by the captured key count. */
				if (key === void 0) return void 0;
				frame.key = key;
				current = frame.source[key];
			}
			break;
		}
	}
}
/**
* Validate and detach lossless JSON in one read per property.
* @param value - candidate value to validate and detach.
* @returns the detached snapshot, or `undefined` when the value is not losslessly JSON-serializable.
*/
function snapshotJsonValue(value) {
	return walkJsonValue(value, true);
}
/**
* Test the same lossless JSON rules as {@link snapshotJsonValue} without detaching the value.
* @param value - candidate value to test.
* @returns whether the value survives a JSON round trip without loss.
*/
function isJsonValue(value) {
	return walkJsonValue(value, false) === true;
}
/**
* Deep-freeze an object graph in place while leaving live AbortSignal objects mutable.
* @param value - value to freeze.
* @returns the same value after every reachable enumerable child is frozen.
*/
function deepFreeze(value) {
	const seen = /* @__PURE__ */ new WeakSet();
	const pending = [{
		kind: "visit",
		node: value
	}];
	while (pending.length > 0) {
		const task = pending.pop();
		/* v8 ignore next -- the loop condition guarantees one pending task. */
		if (task === void 0) continue;
		if (task.kind === "property") {
			pending.push({
				kind: "visit",
				node: task.source[task.key]
			});
			continue;
		}
		const node = task.node;
		if (node === null || typeof node !== "object") continue;
		if (node instanceof AbortSignal) continue;
		if (seen.has(node)) continue;
		seen.add(node);
		Object.freeze(node);
		const keys = Object.keys(node);
		for (let index = keys.length - 1; index >= 0; index--) {
			const key = keys[index];
			/* v8 ignore next -- the loop is bounded by the captured key count. */
			if (key === void 0) continue;
			pending.push({
				kind: "property",
				source: node,
				key
			});
		}
	}
	return value;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-util-crypto@0.2.2-alpha.3_@deepseek-ai+cordis@4.0.6-alpha.2/node_modules/@deepseek-ai/dsh-util-crypto/lib/index.js
/**
* Random v4 UUID, minted from `crypto.getRandomValues`.
* @returns the UUID string.
*/
function randomUUID$1() {
	const bytes = globalThis.crypto.getRandomValues(/* @__PURE__ */ new Uint8Array(16));
	const hex = Array.from(bytes, (byte, index) => {
		return (index === 6 ? byte & 15 | 64 : index === 8 ? byte & 63 | 128 : byte).toString(16).padStart(2, "0");
	}).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-brand@0.2.2-alpha.3_@deepseek-ai+cordis@4.0.6-alpha.2/node_modules/@deepseek-ai/dsh-brand/lib/index.js
/**
* Duplicate-install-safe nominal primitive helpers.
*
* A brand makes structurally identical strings or numbers non-interchangeable
* at the type level: a `SessionId` cannot be passed where a `ToolCallId` is
* expected, and an event sequence cannot be passed as a log offset. Comparison,
* logging, and serialization retain the underlying primitive behavior.
*
* This package owns no concrete domain value and keeps no runtime identity or mutable
* state, so independently installed copies produce interchangeable values.
*
* @module @deepseek-ai/dsh-brand
*/
/**
* Apply a compile-time string brand without changing the value.
* @param value - string admitted by the domain that owns the target brand.
* @returns the same string with the requested compile-time brand.
*/
function brandString(value) {
	return value;
}
/**
* Apply a compile-time number brand without changing the value.
* @param value - number admitted by the domain that owns the target brand.
* @returns the same number with the requested compile-time brand.
*/
function brandNumber(value) {
	return value;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-timeout@0.2.2-alpha.3_@deepseek-ai+cordis@4.0.6-alpha.2/node_modules/@deepseek-ai/dsh-timeout/lib/index.js
/** Largest delay Node schedules without clamping it to one millisecond. */
const MAX_TIMER_DELAY_MS = 2147483647;
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-llm@0.2.2-alpha.3_@deepseek-ai+cordis@4.0.6-alpha.2/node_modules/@deepseek-ai/dsh-llm/lib/index.js
/**
* Bound one `notice` summary to {@link CONTEXT_SUMMARY_MAX_CHARS}.
* @param summary - the producer's one-line account, of any length.
* @returns the account, ellipsized when it exceeds the bound.
*/
function boundContextSummary(summary) {
	return summary.length <= 120 ? summary : `${summary.slice(0, 119)}…`;
}
/**
* Detach and deep-freeze a message whose identity already exists.
* @param message - complete message, including its stable identity.
* @returns an immutable snapshot that preserves the identity.
*/
function freezeMessage(message) {
	return deepFreeze(structuredClone(message));
}
/**
* Create one identified message and freeze it before publication.
* @param input - complete role, content, and source for a new message.
* @returns an immutable message with a fresh stable identity.
*/
function createMessage(input) {
	return deepFreeze(structuredClone({
		...input,
		id: brandString(randomUUID$1())
	}));
}
/**
* Create one identified user-role message and freeze it before publication.
* @param input - complete content and source for a new user message.
* @returns an immutable user message with a fresh stable identity.
*/
function createUserMessage(input) {
	return createMessage({
		...input,
		role: "user"
	});
}
/**
* Harness error base with a stable machine-routable code and chained cause.
* Package errors extend it so tool results and replay can retain failure class.
* @module @deepseek-ai/dsh-llm/error
*/
/**
* Base class for all harness errors. Carries a `code` (stable, programmatic —
* e.g. `NO_ADAPTER`, `INVALID_ARGS`) distinct from the
* human-readable `message`, and supports `cause` chaining via the standard
* `ErrorOptions`. `name` defaults to the subclass constructor name.
*/
var HarnessError = class extends Error {
	/** Stable machine-routable failure class (e.g. `RATE_LIMIT`); route on this, never by parsing `message`. */
	code;
	constructor(message, code, options) {
		super(message, options);
		this.code = code;
		this.name = new.target.name;
	}
};
/**
* Canonical provider-neutral code for a response that completed normally but
* carried no content blocks at all. Providers occasionally emit a degenerate
* completion (a terminal stop with zero output); adapters classify it as this
* failure instead of yielding an empty assistant message, because an empty
* message silently ends the turn with nothing for the user or the loop to act
* on. The attempt produced nothing durable, so retry policy treats it as safe
* to repeat.
*/
const EMPTY_RESPONSE_CODE = "EMPTY_RESPONSE";
new RegExp(String.raw`(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-]` + String.raw`(?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])`, "i");
new RegExp(String.raw`\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?` + String.raw`too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?` + String.raw`(?:model(?:'s)?\s+)?context(?:\s+window)?\b`, "i");
new RegExp(String.raw`\b(?:input|prompt|request|messages?)\b.{0,40}` + String.raw`\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}` + String.raw`\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b`, "i");
/**
* Provider-owned request-retry policy configuration and resolution.
*
* Adapters expose one resolved policy per registered provider route; the
* optional dsh-llm-retry plugin executes it on the agent's failed-step extension point.
*
* @module @deepseek-ai/dsh-llm/retry-policy
*/
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_INITIAL_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 1e4;
const DEFAULT_JITTER_RATIO = .1;
const DEFAULT_RETRYABLE_CODES = Object.freeze([
	EMPTY_RESPONSE_CODE,
	"RATE_LIMIT",
	"SERVER",
	"TIMEOUT",
	"TRANSPORT"
]);
const backoffSchema = z.object({
	initialDelayMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_INITIAL_DELAY_MS),
	maxDelayMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_MAX_DELAY_MS),
	jitterRatio: z.number().min(0).max(1).default(DEFAULT_JITTER_RATIO)
});
const normalPolicySchema = z.object({
	mode: z.const("normal").required(),
	maxRetries: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_RETRIES),
	retryableCodes: z.array(z.string()).default([...DEFAULT_RETRYABLE_CODES]),
	backoff: backoffSchema
});
const alwaysPolicySchema = z.object({
	mode: z.const("always").required(),
	backoff: backoffSchema
});
z.union([normalPolicySchema, alwaysPolicySchema]);
const NORMAL_POLICY_KEYS = /* @__PURE__ */ new Set([
	"mode",
	"maxRetries",
	"retryableCodes",
	"backoff"
]);
const ALWAYS_POLICY_KEYS = /* @__PURE__ */ new Set([
	"mode",
	"maxRetries",
	"retryableCodes",
	"backoff"
]);
const BACKOFF_KEYS = /* @__PURE__ */ new Set([
	"initialDelayMs",
	"maxDelayMs",
	"jitterRatio"
]);
function validateKeys(value, allowed, path) {
	for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${path}: unknown key "${key}"`);
}
function resolveBackoff(config, path) {
	if (config !== void 0) validateKeys(config, BACKOFF_KEYS, path);
	const initialDelayMs = config?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
	const maxDelayMs = config?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
	const jitterRatio = config?.jitterRatio ?? DEFAULT_JITTER_RATIO;
	if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0 || initialDelayMs > 2147483647) throw new Error(`${path}.initialDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0 || maxDelayMs > 2147483647) throw new Error(`${path}.maxDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	if (initialDelayMs > maxDelayMs) throw new Error(`${path}.initialDelayMs must be less than or equal to maxDelayMs`);
	if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) throw new Error(`${path}.jitterRatio must be between 0 and 1`);
	return Object.freeze({
		initialDelayMs,
		maxDelayMs,
		jitterRatio
	});
}
/**
* Validate, default, and detach one provider-owned retry policy.
* @param config - optional provider configuration; omission selects normal defaults.
* @param path - diagnostic path naming the provider config that owns the value.
* @returns an immutable policy safe to capture in provider registration state.
*/
function resolveRetryPolicy(config, path) {
	if (config === void 0) return Object.freeze({
		mode: "normal",
		maxRetries: DEFAULT_MAX_RETRIES,
		retryableCodes: DEFAULT_RETRYABLE_CODES,
		...resolveBackoff(void 0, `${path}.backoff`)
	});
	switch (config.mode) {
		case "normal": {
			validateKeys(config, NORMAL_POLICY_KEYS, path);
			const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
			const retryableCodes = config.retryableCodes ?? [...DEFAULT_RETRYABLE_CODES];
			if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) throw new Error(`${path}.maxRetries must be a non-negative safe integer`);
			if (retryableCodes.length === 0) throw new Error(`${path}.retryableCodes must not be empty`);
			if (retryableCodes.some((code) => typeof code !== "string" || code.length === 0)) throw new Error(`${path}.retryableCodes must contain only non-empty strings`);
			if (new Set(retryableCodes).size !== retryableCodes.length) throw new Error(`${path}.retryableCodes must not contain duplicates`);
			return Object.freeze({
				mode: "normal",
				maxRetries,
				retryableCodes: Object.freeze([...retryableCodes]),
				...resolveBackoff(config.backoff, `${path}.backoff`)
			});
		}
		case "always":
			validateKeys(config, ALWAYS_POLICY_KEYS, path);
			return Object.freeze({
				mode: "always",
				...resolveBackoff(config.backoff, `${path}.backoff`)
			});
		default: throw new Error(`${path}.mode must be "normal" or "always"`);
	}
}
/**
* Field-wise equality over {@link LlmCallConfig} — the comparison a caller
* runs to decide whether a proposed configuration is a real change (worth a
* logged header snapshot) or the held one restated.
* @param a - one configuration.
* @param b - the other.
* @returns whether every field (including the `stop` list, element-wise) matches.
*/
function callConfigEquals(a, b) {
	if (a.provider !== b.provider || a.model !== b.model || a.reasoningEffort !== b.reasoningEffort || a.temperature !== b.temperature || a.maxTokens !== b.maxTokens) return false;
	if (a.stop === void 0 || b.stop === void 0) return a.stop === b.stop;
	return a.stop.length === b.stop.length && a.stop.every((s, i) => s === b.stop?.[i]);
}
/**
* Normalization for values thrown by a final LLM adapter boundary.
*
* @module @deepseek-ai/dsh-llm/adapter-failure
*/
/**
* Detach serializable provider facts from a value thrown by an adapter.
* @param value - arbitrary value thrown during adapter dispatch or iteration.
* @returns immutable provider-neutral facts suitable for a terminal finish chunk.
* @internal
*/
function normalizeLlmFailure(value) {
	const error = value instanceof Error ? value : new HarnessError(thrownMessage(value), "UNKNOWN", { cause: value });
	const carried = ownFailureSnapshot(error);
	if (carried !== void 0 && carried.code === ownErrorCode(error)) return carried;
	return Object.freeze({
		message: errorMessage(error),
		code: harnessErrorCode(error)
	});
}
/** Render a non-Error throw without letting hostile coercion escape normalization. */
function thrownMessage(value) {
	try {
		const message = String(value);
		return message.length > 0 ? message : "LLM adapter failed";
	} catch (_hostileThrownValue) {
		return "LLM adapter failed";
	}
}
/** Read a foreign error's own data-backed `code` without invoking accessors. */
function ownErrorCode(error) {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(error, "code");
		return descriptor !== void 0 && "value" in descriptor ? descriptor.value : void 0;
	} catch (_sdkPropertyTrap) {
		return;
	}
}
/** Snapshot an own data property without invoking an SDK-defined accessor. */
function ownFailureSnapshot(error) {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(error, "failure");
		return descriptor !== void 0 && "value" in descriptor ? failureSnapshot(descriptor.value) : void 0;
	} catch (_sdkPropertyTrap) {
		return;
	}
}
/** Validate and detach an arbitrary serializable failure payload. */
function failureSnapshot(value) {
	if (typeof value !== "object" || value === null) return void 0;
	try {
		const candidate = value;
		const message = candidate.message;
		const code = candidate.code;
		const status = candidate.status;
		const providerRetryAfterMs = candidate.providerRetryAfterMs;
		const requestId = candidate.requestId;
		const offloadImages = candidate.offloadImages;
		if (typeof message !== "string" || message.length === 0 || typeof code !== "string" || code.length === 0 || status !== void 0 && (!Number.isInteger(status) || status < 100 || status > 599) || providerRetryAfterMs !== void 0 && (!Number.isFinite(providerRetryAfterMs) || providerRetryAfterMs <= 0) || requestId !== void 0 && (typeof requestId !== "string" || requestId.length === 0) || offloadImages !== void 0 && (!Number.isSafeInteger(offloadImages) || offloadImages <= 0)) return void 0;
		return Object.freeze({
			message,
			code,
			...status === void 0 ? {} : { status },
			...providerRetryAfterMs === void 0 ? {} : { providerRetryAfterMs },
			...requestId === void 0 ? {} : { requestId },
			...offloadImages === void 0 ? {} : { offloadImages }
		});
	} catch (_sdkFailureGetter) {
		return;
	}
}
/** Read an SDK error message without letting an accessor replace the primary failure. */
function errorMessage(error) {
	try {
		const message = error.message;
		if (typeof message === "string" && message.length > 0) return message;
	} catch (_sdkMessageGetter) {}
	return "LLM adapter failed";
}
/** Trust only Harness-owned codes; third-party SDK codes are not our taxonomy. */
function harnessErrorCode(error) {
	return error instanceof HarnessError ? error.code : "UNKNOWN";
}
function quoted(value) {
	return JSON.stringify(value);
}
/**
* Stable text shown to a model that cannot accept one durable image reference.
* @param ref - durable normalized attachment omitted from the request.
* @returns deterministic text-only placeholder.
*/
function textOnlyImageText(ref) {
	return `[image omitted because this model accepts text only; attachment sha256:${String(ref.attachmentId).slice(7, 15)}]`;
}
/**
* True when typed model content contains an image block. This is the one image
* walk shared by every image policy (capability gating, text-only
* serialization, compaction survey), so a consumer cannot silently diverge.
* @param content - typed model content blocks.
* @returns whether any block is an image.
*/
function contentHasImage(content) {
	return content.some((block) => block.type === "image");
}
/**
* True when typed model content contains a file block.
* Reads current content on every call without retaining scan results.
* @param content - typed model content blocks.
* @returns whether any block is a file.
*/
function contentHasFile(content) {
	for (const block of content) if (block.type === "file") return true;
	return false;
}
/**
* Stable model-facing handle for one durable file reference: the address of
* the verbatim stored copy and the instruction to read it on demand. This is
* the only representation a provider ever receives for a file.
* @param ref - durable verbatim file reference.
* @param readonlyPath - execution-world path of the stored copy, when resolvable.
* @returns deterministic handle text naming the file, its size, and its address.
*/
function fileHandleText(ref, readonlyPath) {
	const digest = String(ref.attachmentId).slice(7, 15);
	const identity = `File ${quoted(ref.name)} (${ref.bytes} bytes, sha256:${digest})`;
	if (readonlyPath === void 0) return `[${identity} was uploaded, but the current execution environment cannot access a readable path. Report that limitation if its contents are needed; do not claim to have read it.]`;
	return `[${identity}: verbatim read-only copy saved at ${quoted(readonlyPath)}. Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it. When delegating file work, include this saved path in the delegation prompt; only subagents sharing this execution environment can read it.]`;
}
/** Replace every file occurrence with handle text. */
function replaceFilesWithHandles(blocks, resolvePath) {
	let next;
	for (const [index, block] of blocks.entries()) {
		if (block.type === "file") {
			next ??= blocks.slice(0, index);
			next.push({
				type: "text",
				text: fileHandleText(block.attachment, resolvePath(block.attachment))
			});
			continue;
		}
		next?.push(block);
	}
	return next ?? blocks;
}
function projectFilesToText(messages, resolvePath) {
	if (!messages.some((message) => contentHasFile(message.content))) return messages;
	return messages.map((message) => {
		const content = replaceFilesWithHandles(message.content, resolvePath);
		return content === message.content ? message : {
			...message,
			content
		};
	});
}
/** Replace every image occurrence for a text-only model. */
function replaceImagesForTextModel(blocks) {
	let next;
	for (const [index, block] of blocks.entries()) {
		if (block.type === "image") {
			next ??= blocks.slice(0, index);
			next.push({
				type: "text",
				text: textOnlyImageText(block.attachment)
			});
			continue;
		}
		next?.push(block);
	}
	return next ?? blocks;
}
function projectImagesForTextModel(messages) {
	if (!messages.some((message) => contentHasImage(message.content))) return messages;
	return messages.map((message) => {
		const content = replaceImagesForTextModel(message.content);
		return content === message.content ? message : {
			...message,
			content
		};
	});
}
function withoutDeveloperMessages(messages) {
	const retained = messages.filter((message) => message.role !== "developer");
	return retained.length === messages.length ? messages : retained;
}
function toolDeclarations(tools, mode, history) {
	const declarations = new Map(history.tools.map((tool) => [tool.name, tool]));
	for (const update of history.updates) for (const tool of update.additions) if (!declarations.has(tool.name)) declarations.set(tool.name, {
		...tool,
		deferLoading: true
	});
	switch (mode) {
		case "in-history": return declarations;
		case "addition-only": {
			const activeNames = new Set(tools?.map((tool) => tool.name));
			for (const name of declarations.keys()) if (!activeNames.has(name)) declarations.delete(name);
			return declarations;
		}
		/* v8 ignore next 2 -- closed-union exhaustiveness guard */
		default: return assertNever(mode);
	}
}
/**
* Construct provider declarations from session-folded history without changing logged active tools.
* Unsupported routes and incomplete history use current declarations without developer updates.
* Explicitly deferred baseline tools become available only after their first retained addition.
* @param messages - complete request inputs, or the prefix selected for an auxiliary call.
* @param tools - currently active tool schemas.
* @param toolUpdate - the resolved route's update mode.
* @param history - immutable state folded from committed headers and developer messages.
* @returns provider declarations and the corresponding filtered history.
*/
function projectToolUpdates(messages, tools, toolUpdate, history) {
	if (toolUpdate === void 0) {
		let immediateTools = tools;
		if (tools?.some((tool) => tool.deferLoading === true)) immediateTools = tools.map(({ deferLoading: _loading, ...tool }) => tool);
		return {
			messages: withoutDeveloperMessages(messages),
			tools: immediateTools
		};
	}
	if (history === void 0) return {
		messages: withoutDeveloperMessages(messages),
		tools
	};
	const messageIds = new Set(messages.flatMap((message) => message.role === "developer" ? [message.id] : []));
	if (history.updates.some((update) => !messageIds.has(update.messageId))) return {
		messages: withoutDeveloperMessages(messages),
		tools
	};
	const declarations = toolDeclarations(tools, toolUpdate, history);
	const updateIds = new Set(history.updates.map((update) => update.messageId));
	const offered = new Set(history.tools.filter((tool) => !tool.deferLoading).map((tool) => tool.name));
	const projectedMessages = [];
	for (const message of messages) {
		if (message.role !== "developer") {
			projectedMessages.push(message);
			continue;
		}
		if (!updateIds.has(message.id)) continue;
		const content = message.content.filter((block) => {
			switch (block.type) {
				case "tool-addition":
					if (!declarations.has(block.toolName) || offered.has(block.toolName)) return false;
					offered.add(block.toolName);
					return true;
				case "tool-removal":
					if (toolUpdate !== "in-history") return false;
					return offered.delete(block.toolName);
				default: return true;
			}
		});
		if (content.length === 0) continue;
		if (content.length === message.content.length) projectedMessages.push(message);
		else projectedMessages.push({
			...message,
			content
		});
	}
	return {
		messages: projectedMessages.length === messages.length && projectedMessages.every((message, index) => message === messages[index]) ? messages : projectedMessages,
		tools: [...declarations.values()]
	};
}
/**
* Centralize the non-secret product identity every provider request sends as `User-Agent`, keeping
* adapters from drifting. See
* `docs/subsystems/llm-streaming.md#appidentity--app-attribution`.
*
* App-attribution vocabulary for provider requests.
* @module @deepseek-ai/dsh-llm/attribution
*/
const { version: version$1 } = createRequire(import.meta.url)("../package.json");
/**
* Brand an adapter-owned reasoning-effort identifier.
* @param id - the opaque identifier exposed by one model capability.
* @returns the same string, branded; no validation is performed.
*/
function ReasoningEffortId$1(id) {
	return brandString(id);
}
/**
* LLM service: adapter registry with a waterfall-interceptable streaming call
* API. Exports the `LlmRuntime` default, the abstract `LlmAdapter` for
* provider backends, and `BlockAssembler` for chunk assembly.
*
* @module @deepseek-ai/dsh-llm
*/
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
/**
* Typed error for LLM-related failures. Extends {@link HarnessError}, so the
* `code` string (e.g. `AUTH`, `RATE_LIMIT`, `NO_ADAPTER`) is shared taxonomy.
*/
var LlmError = class extends HarnessError {
	/** Serializable facts retained beside this live Error. */
	failure;
	/**
	* @param message - non-empty human-readable failure summary.
	* @param code - non-empty stable provider-neutral machine code.
	* @param options - optional cause and validated serializable provider facts.
	*/
	constructor(message, code, options) {
		if (typeof message !== "string" || message.length === 0) throw new Error("LlmError message must be a non-empty string");
		if (typeof code !== "string" || code.length === 0) throw new Error("LlmError code must be a non-empty string");
		if (options?.status !== void 0 && (!Number.isInteger(options.status) || options.status < 100 || options.status > 599)) throw new Error("LlmError status must be an integer from 100 through 599");
		if (options?.providerRetryAfterMs !== void 0 && (!Number.isFinite(options.providerRetryAfterMs) || options.providerRetryAfterMs <= 0)) throw new Error("LlmError providerRetryAfterMs must be a positive finite number");
		if (options?.requestId !== void 0 && (typeof options.requestId !== "string" || options.requestId.length === 0)) throw new Error("LlmError requestId must be a non-empty string");
		super(message, code, options);
		this.name = "LlmError";
		this.failure = Object.freeze({
			message,
			code,
			...options?.status === void 0 ? {} : { status: options.status },
			...options?.providerRetryAfterMs === void 0 ? {} : { providerRetryAfterMs: options.providerRetryAfterMs },
			...options?.requestId === void 0 ? {} : { requestId: options.requestId },
			...options?.offloadImages === void 0 ? {} : { offloadImages: options.offloadImages }
		});
	}
};
(() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _listProviders_decorators;
	let _listConfigurableProviders_decorators;
	let _remoteDiscoverModels_decorators;
	return class LlmRuntime extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_listProviders_decorators = [Remote];
			_listConfigurableProviders_decorators = [Remote];
			_remoteDiscoverModels_decorators = [Remote("discoverModels")];
			__esDecorate(this, null, _listProviders_decorators, {
				kind: "method",
				name: "listProviders",
				static: false,
				private: false,
				access: {
					has: (obj) => "listProviders" in obj,
					get: (obj) => obj.listProviders
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _listConfigurableProviders_decorators, {
				kind: "method",
				name: "listConfigurableProviders",
				static: false,
				private: false,
				access: {
					has: (obj) => "listConfigurableProviders" in obj,
					get: (obj) => obj.listConfigurableProviders
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _remoteDiscoverModels_decorators, {
				kind: "method",
				name: "remoteDiscoverModels",
				static: false,
				private: false,
				access: {
					has: (obj) => "remoteDiscoverModels" in obj,
					get: (obj) => obj.remoteDiscoverModels
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		adapters = (__runInitializers(this, _instanceExtraInitializers), /* @__PURE__ */ new Map());
		directory = /* @__PURE__ */ new Map();
		discoveries = /* @__PURE__ */ new Map();
		constructor(ctx) {
			super(ctx, "llm");
		}
		/** Notify topology observers without letting one broken listener veto the commit. */
		emitAdaptersUpdated() {
			for (const listener of this.ctx.events.dispatch("emit", ["llm/adapters-updated"])) try {
				const returned = listener();
				if (returned != null && typeof returned.then === "function") Promise.resolve(returned).then(void 0, (error) => {
					this.warnAdaptersListenerFailure(error);
				});
			} catch (error) {
				this.warnAdaptersListenerFailure(error);
			}
		}
		/** Contained-listener diagnostic shared by the sync and async failure paths. */
		warnAdaptersListenerFailure(error) {
			this.ctx.logger.warn("llm: an llm/adapters-updated listener failed");
			this.ctx.logger.warn(error);
		}
		/**
		* Register an adapter for the given provider routes. Throws `LlmError` with code
		* `DUPLICATE_ADAPTER` if any provider already has an adapter (all-or-nothing).
		* Disposed with the fiber.
		* @param providers - every provider route this adapter should serve.
		* @param adapter - the adapter that streams calls for those providers.
		* @returns the disposer, carrying {@link AdapterRegistrationHandle.replace}.
		*/
		registerAdapter(providers, adapter) {
			const owned = /* @__PURE__ */ new Set();
			let released = false;
			const dispose = this.ctx.effect(function* () {
				if (providers.length === 0) throw new LlmError("an adapter must register at least one provider", "INVALID_ADAPTER");
				this.commitRoutes(owned, this.prepareRoutes(providers, adapter, owned));
				yield () => {
					released = true;
					for (const provider of owned) this.adapters.delete(provider);
					owned.clear();
					this.emitAdaptersUpdated();
				};
			}.bind(this), "llm.registerAdapter()");
			const handle = (() => void dispose());
			handle.replace = (next) => {
				if (released) throw new LlmError("a disposed adapter registration cannot replace its routes", "REGISTRATION_DISPOSED");
				this.commitRoutes(owned, this.prepareRoutes(next, adapter, owned));
			};
			return handle;
		}
		/**
		* Validate one candidate route set for `adapter`, treating routes this
		* registration already holds as available. Nothing is mutated: a rejected
		* candidate leaves the registry exactly as it was.
		*/
		prepareRoutes(providers, adapter, owned) {
			const unique = /* @__PURE__ */ new Set();
			const registrations = [];
			for (const provider of providers) {
				if (provider.length === 0) throw new LlmError("adapter provider names must be non-empty", "INVALID_ADAPTER");
				if (unique.has(provider) || this.adapters.has(provider) && !owned.has(provider)) throw new LlmError(`an adapter for provider "${provider}" is already registered`, "DUPLICATE_ADAPTER");
				const info = adapter.providerInfo(provider);
				if (typeof info.id !== "string" || info.id !== provider || typeof info.name !== "string" || info.name.length === 0) throw new LlmError(`adapter metadata for provider "${provider}" must preserve its id and have a non-empty name`, "INVALID_ADAPTER");
				unique.add(provider);
				const retryPolicy = adapter.providerRetryPolicy(provider) ?? resolveRetryPolicy(void 0, `llm: provider "${provider}" retryPolicy`);
				registrations.push({
					adapter,
					provider: {
						id: info.id,
						name: info.name
					},
					retryPolicy
				});
			}
			return registrations;
		}
		/**
		* Swap this registration's routes for the prepared ones in one synchronous
		* section, so no observer can see the registry between the release and the
		* re-registration. The route set's one mutation point is also where
		* `llm/adapters-updated` is published, so a `replace` announces itself
		* exactly like a first registration.
		*/
		commitRoutes(owned, registrations) {
			for (const provider of owned) this.adapters.delete(provider);
			owned.clear();
			for (const registration of registrations) {
				this.adapters.set(registration.provider.id, registration);
				owned.add(registration.provider.id);
			}
			this.emitAdaptersUpdated();
		}
		/**
		* Describe provider routes with a registered adapter.
		* @returns detached provider metadata in registration order.
		*/
		listProviders() {
			return [...this.adapters.values()].map(({ provider }) => ({ ...provider }));
		}
		/**
		* Declare provider routes an adapter plugin can activate through
		* configuration. Registration is all-or-nothing: an empty list, invalid
		* entry, or a provider already declared by any registration throws
		* `LlmError` without registering the rest. Disposed with the fiber.
		* @param entries - every configurable provider this plugin owns.
		* @returns a handle that withdraws all of them, and can atomically replace them.
		*/
		registerConfigurableProviders(entries) {
			let held = [];
			let disposed = false;
			/**
			* Validate a candidate set in full against everything this registration
			* does not already hold, then publish it. Nothing is written until the
			* whole set passes, so a refused candidate leaves the current entries in
			* place — the property that makes `replace` a swap rather than a
			* delete-then-add that can strand the directory empty.
			*/
			const commit = (candidates) => {
				const detached = [];
				const own = new Set(held.map((entry) => entry.provider));
				for (const entry of candidates) {
					if (entry.provider.length === 0 || entry.displayName.length === 0 || entry.settingsNs.length === 0) throw new LlmError("configurable providers need a non-empty provider, displayName, and settingsNs", "INVALID_DIRECTORY");
					if (entry.settingsPath.some((segment) => segment.length === 0)) throw new LlmError(`configurable provider "${entry.provider}" has an empty settingsPath segment`, "INVALID_DIRECTORY");
					if (this.directory.has(entry.provider) && !own.has(entry.provider) || detached.some((seen) => seen.provider === entry.provider)) throw new LlmError(`configurable provider "${entry.provider}" is already declared`, "DUPLICATE_DIRECTORY");
					detached.push(detachDirectoryEntry(entry));
				}
				for (const entry of held) this.directory.delete(entry.provider);
				for (const entry of detached) this.directory.set(entry.provider, entry);
				held = detached;
				this.emitAdaptersUpdated();
			};
			const dispose = this.ctx.effect(function* () {
				if (entries.length === 0) throw new LlmError("a configurable-provider registration must declare at least one provider", "INVALID_DIRECTORY");
				commit(entries);
				yield () => {
					disposed = true;
					for (const entry of held) this.directory.delete(entry.provider);
					held = [];
					this.emitAdaptersUpdated();
				};
			}.bind(this), "llm.registerConfigurableProviders()");
			const handle = (() => void dispose());
			handle.replace = (next) => {
				if (disposed) throw new LlmError("this configurable-provider registration was disposed", "REGISTRATION_DISPOSED");
				commit(next);
			};
			return handle;
		}
		/**
		* List every declared configurable provider, registered or dormant.
		* @returns detached directory entries in declaration order.
		*/
		listConfigurableProviders() {
			return [...this.directory.values()].map(detachDirectoryEntry);
		}
		/**
		* Offer to interrogate provider endpoints on behalf of the settings
		* namespace this plugin owns. The namespace is the key because that is what
		* a configuration surface already holds from the configurable-provider
		* directory, and because a provider being *added* has no route to name yet.
		* Disposed with the fiber.
		* @param settingsNs - the namespace whose profiles this discovery serves.
		* @param discover - interrogates one endpoint and must honor the supplied signal.
		* @returns the disposer that withdraws the offer.
		*/
		registerModelDiscovery(settingsNs, discover) {
			const dispose = this.ctx.effect(function* () {
				if (settingsNs.length === 0) throw new LlmError("model discovery needs a non-empty settings namespace", "INVALID_DISCOVERY");
				if (this.discoveries.has(settingsNs)) throw new LlmError(`model discovery for "${settingsNs}" is already registered`, "DUPLICATE_DISCOVERY");
				this.discoveries.set(settingsNs, discover);
				yield () => {
					this.discoveries.delete(settingsNs);
				};
			}.bind(this), "llm.registerModelDiscovery()");
			return () => void dispose();
		}
		/**
		* Interrogate one provider endpoint for the models it advertises. The
		* request describes a draft, not a stored route, so nothing here reads or
		* writes settings or credentials — the caller owns both, and the reply is
		* candidate metadata a surface may offer for adoption.
		* @param settingsNs - namespace whose registered discovery serves this draft.
		* @param request - the endpoint, protocol, and one-shot credential to use.
		* @param signal - caller cancellation.
		* @returns the advertised models, deduplicated in endpoint order.
		*/
		async discoverModels(settingsNs, request, signal) {
			const discover = this.discoveries.get(settingsNs);
			if (discover === void 0) throw new LlmError(`no model discovery is registered for "${settingsNs}"`, "NO_DISCOVERY");
			if ((request.provider ?? "").length === 0 && (request.baseURL ?? "").length === 0) throw new LlmError("model discovery needs a provider route or a baseURL", "INVALID_DISCOVERY");
			const discovered = signal === void 0 ? await discover(request) : await discover(request, signal);
			const seen = /* @__PURE__ */ new Set();
			const models = [];
			for (const model of discovered) {
				if (typeof model.id !== "string" || model.id.length === 0 || seen.has(model.id)) continue;
				seen.add(model.id);
				models.push({
					id: model.id,
					...model.name === void 0 ? {} : { name: model.name },
					...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
					...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },
					...model.inputModalities === void 0 ? {} : { inputModalities: [...model.inputModalities] }
				});
			}
			return models;
		}
		/**
		* Remote adapter for one draft provider interrogation.
		* @param settingsNs - namespace whose registered discovery serves this draft.
		* @param request - endpoint, protocol, and one-shot credential to use.
		* @param signal - caller cancellation supplied by the Remote carrier.
		* @returns advertised models in endpoint order.
		* @throws RemoteError with `llm/model-discovery-rejected` when discovery refuses or fails.
		*/
		async remoteDiscoverModels(settingsNs, request, signal) {
			try {
				return await this.discoverModels(settingsNs, request, signal);
			} catch (error) {
				throw new RemoteError("llm/model-discovery-rejected", error instanceof Error ? error.message : String(error), {
					settingsNs,
					...request.baseURL === void 0 ? {} : { baseURL: request.baseURL }
				}, { cause: error });
			}
		}
		/**
		* Resolve the retry policy captured when one provider route was registered.
		* @param provider - registered provider route to inspect.
		* @returns the provider-owned policy, with normal defaults already resolved.
		*/
		providerRetryPolicy(provider) {
			return this.registration(provider).retryPolicy;
		}
		/**
		* Resolve provider-side request-image pricing for one exact route, or
		* `undefined` when the provider is unregistered or declares none. Unknown
		* providers degrade to `undefined` rather than throwing because callers
		* price durable history whose route may no longer be mounted.
		* @param provider - provider route named by a request header.
		* @param model - exact model id named by the same header.
		* @returns the owning adapter's image pricing for the route, when declared.
		*/
		imageRequestPricing(provider, model) {
			return this.adapters.get(provider)?.adapter.imageRequestPricing(provider, model);
		}
		/**
		* Resolve the image projection for an exact registered model route.
		* @param provider - registered provider route.
		* @param model - exact model id.
		* @param image - normalized image reference.
		* @returns dimensions and byte target used by the adapter's request serializer.
		*/
		imageRequestTarget(provider, model, image) {
			return this.registration(provider).adapter.imageRequestTarget(provider, model, image);
		}
		/**
		* Resolve the exact text one durable file occurrence contributes to every
		* provider request in the current execution environment.
		* @param ref - durable verbatim file reference from model history.
		* @returns the same deterministic handle text used at adapter dispatch.
		*/
		fileRequestText(ref) {
			return fileHandleText(ref, this.fileReadPath(ref));
		}
		/** Detach typed adapter-owned modality metadata. */
		detachedModalities(modalities) {
			return modalities === void 0 ? void 0 : [...modalities];
		}
		/**
		* Discover models advertised by one registered provider. Catalog membership
		* does not constrain core routing. Catalog-driven entry points may restrict
		* selection and submission to the advertised models.
		* @param provider - registered provider route to inspect.
		* @returns detached model metadata in adapter-preferred order.
		*/
		async listModels(provider) {
			const models = await this.registration(provider).adapter.listModels(provider);
			const seen = /* @__PURE__ */ new Set();
			return models.map((model) => {
				if (typeof model.provider !== "string" || model.provider !== provider || typeof model.id !== "string" || model.id.length === 0 || typeof model.name !== "string" || model.name.length === 0 || model.description !== void 0 && typeof model.description !== "string" || seen.has(model.id)) throw new LlmError(`adapter returned invalid or duplicate model metadata for provider "${provider}"`, "INVALID_CATALOG");
				seen.add(model.id);
				const inputModalities = this.detachedModalities(model.inputModalities);
				const badge = model.badge;
				return {
					provider: model.provider,
					id: model.id,
					name: model.name,
					...model.description === void 0 ? {} : { description: model.description },
					...inputModalities === void 0 ? {} : { inputModalities },
					...badge === void 0 ? {} : { badge: {
						text: typeof badge.text === "string" ? badge.text : { ...badge.text },
						tone: badge.tone
					} }
				};
			});
		}
		/**
		* Resolve and validate all metadata from the adapter that owns one exact
		* route. The result is detached from adapter-owned objects; catalog
		* membership remains advisory and does not control request routing.
		* @param provider - registered provider route to inspect.
		* @param model - exact model id passed to the adapter.
		* @param signal - optional cancellation for adapter-owned asynchronous lookup.
		* @returns exact model identity plus available context and reasoning metadata.
		*/
		async resolveModelInfo(provider, model, signal) {
			return this.resolveModelInfoFor(this.registration(provider), model, signal);
		}
		async resolveModelInfoFor(registration, model, signal) {
			const resolved = await registration.adapter.resolveModel(registration.provider.id, model, signal);
			return this.normalizeModelInfo(registration, model, resolved);
		}
		/** Validate and detach one adapter-returned exact model result. */
		normalizeModelInfo(registration, model, resolved) {
			const provider = registration.provider.id;
			if (typeof resolved.provider !== "string" || resolved.provider !== provider || typeof resolved.id !== "string" || resolved.id !== model || typeof resolved.name !== "string" || resolved.name.length === 0 || resolved.description !== void 0 && typeof resolved.description !== "string") throw new LlmError(`adapter returned invalid exact model metadata for provider "${provider}" model "${model}"`, "INVALID_MODEL_INFO");
			const context = resolved.context;
			if (context !== void 0 && (!Number.isInteger(context.contextWindow) || context.contextWindow <= 0)) throw new LlmError(`adapter returned invalid context metadata for provider "${provider}" model "${model}"`, "INVALID_MODEL_CONTEXT");
			const inputModalities = this.detachedModalities(resolved.inputModalities);
			const systemPromptUpdate = resolved.systemPromptUpdate;
			if (systemPromptUpdate !== void 0 && systemPromptUpdate !== "in-history") throw new LlmError(`adapter returned invalid system prompt update mode for provider "${provider}" model "${model}"`, "INVALID_MODEL_INFO");
			const toolUpdate = resolved.toolUpdate;
			if (toolUpdate !== void 0 && toolUpdate !== "in-history" && toolUpdate !== "addition-only") throw new LlmError(`adapter returned invalid tool update mode for provider "${provider}" model "${model}"`, "INVALID_MODEL_INFO");
			const defaultMaxTokens = resolved.defaultMaxTokens;
			if (defaultMaxTokens !== void 0 && (!Number.isSafeInteger(defaultMaxTokens) || defaultMaxTokens <= 0)) throw new LlmError(`adapter returned invalid default maxTokens for provider "${provider}" model "${model}"`, "INVALID_MODEL_MAX_TOKENS");
			const info = {
				provider,
				id: model,
				name: resolved.name,
				...resolved.description === void 0 ? {} : { description: resolved.description },
				...inputModalities === void 0 ? {} : { inputModalities },
				...context === void 0 ? {} : { context: { contextWindow: context.contextWindow } },
				...defaultMaxTokens === void 0 ? {} : { defaultMaxTokens },
				...resolved.systemPromptUpdate === void 0 ? {} : { systemPromptUpdate: resolved.systemPromptUpdate },
				...resolved.toolUpdate === void 0 ? {} : { toolUpdate: resolved.toolUpdate }
			};
			const reasoning = resolved.reasoning;
			if (reasoning === void 0) return info;
			if (reasoning.efforts.length === 0) throw new LlmError(`adapter returned invalid reasoning metadata for provider "${provider}" model "${model}"`, "INVALID_MODEL_REASONING");
			const seen = /* @__PURE__ */ new Set();
			const efforts = reasoning.efforts.map((effort) => {
				if (typeof effort.id !== "string" || effort.id.length === 0 || typeof effort.name !== "string" || effort.name.length === 0 || effort.description !== void 0 && typeof effort.description !== "string" || seen.has(effort.id)) throw new LlmError(`adapter returned invalid or duplicate reasoning effort metadata for provider "${provider}" model "${model}"`, "INVALID_MODEL_REASONING");
				seen.add(effort.id);
				return {
					id: effort.id,
					name: effort.name,
					...effort.description === void 0 ? {} : { description: effort.description }
				};
			});
			if (reasoning.defaultEffort !== void 0 && !seen.has(reasoning.defaultEffort)) throw new LlmError(`adapter returned an unknown default reasoning effort for provider "${provider}" model "${model}"`, "INVALID_MODEL_REASONING");
			return {
				...info,
				reasoning: {
					efforts,
					...reasoning.defaultEffort === void 0 ? {} : { defaultEffort: reasoning.defaultEffort }
				}
			};
		}
		/**
		* Validate a conversation call config against its exact model capability and
		* materialize adapter-configured defaults. Unsupported explicit efforts
		* reject before provider I/O; no clamping or aliasing is performed. This
		* standalone query does not bind a later dispatch; use {@link prepareCall}
		* when logging and streaming must share one adapter registration.
		* @param config - provider/model route and optional request controls.
		* @param signal - optional cancellation for adapter-owned capability lookup.
		* @returns a detached config only when a default must be materialized.
		*/
		async resolveCallConfig(config, signal) {
			return (await this.resolveCallFor(this.registration(config.provider), config, signal)).config;
		}
		async resolveCallFor(registration, config, signal) {
			const info = await this.resolveModelInfoFor(registration, config.model, signal);
			return this.resolveCallWithInfo(config, info);
		}
		/** Validate request controls against one already-bound exact model result. */
		resolveCallWithInfo(config, info) {
			const defaulted = config.maxTokens === void 0 && info.defaultMaxTokens !== void 0 ? {
				...config,
				maxTokens: info.defaultMaxTokens
			} : config;
			const reasoning = info.reasoning;
			const requested = defaulted.reasoningEffort;
			let resolvedConfig = defaulted;
			if (reasoning === void 0) {
				if (requested !== void 0) throw new LlmError(`provider "${config.provider}" model "${config.model}" does not support reasoning effort "${requested}"`, "UNSUPPORTED_REASONING_EFFORT");
			} else {
				const effective = requested ?? reasoning.defaultEffort;
				if (effective !== void 0) {
					if (!reasoning.efforts.some((effort) => effort.id === effective)) throw new LlmError(`provider "${config.provider}" model "${config.model}" does not support reasoning effort "${effective}"`, "UNSUPPORTED_REASONING_EFFORT");
					if (requested !== effective) resolvedConfig = {
						...defaulted,
						reasoningEffort: effective
					};
				}
			}
			return {
				config: resolvedConfig,
				...info.context === void 0 ? {} : { context: info.context },
				modelInfo: info
			};
		}
		/**
		* Resolve one call under its current adapter registration. The returned
		* one-shot handle keeps that registration across header logging and dispatch,
		* so HMR cannot combine one adapter's capability result with another adapter.
		* An optional synchronous callback selects concrete controls using captured
		* model metadata. Defaults and validation apply to its result. Callback
		* failures and cancellation reject preparation before dispatch.
		* @param config - provider/model route and optional concrete request controls.
		* @param signal - optional cancellation for adapter-owned capability lookup.
		* @param configure - pure control selection, called once before defaults and validation.
		* @returns a prepared config and its registration-bound stream entry point.
		*/
		async prepareCall(config, signal, configure) {
			signal?.throwIfAborted();
			const { provider, model, ...controls } = config;
			const registration = this.registration(provider);
			const adapterCall = await registration.adapter.prepareCall(provider, model, signal);
			signal?.throwIfAborted();
			const modelInfo = this.normalizeModelInfo(registration, model, adapterCall.model);
			const proposed = configure === void 0 ? config : {
				...configure(deepFreeze(structuredClone(controls)), deepFreeze(modelInfo)),
				provider,
				model
			};
			signal?.throwIfAborted();
			const resolved = this.resolveCallWithInfo(proposed, modelInfo);
			const resolvedConfig = deepFreeze(structuredClone(resolved.config));
			const context = resolved.context === void 0 ? void 0 : deepFreeze(structuredClone(resolved.context));
			const adapterDefaults = deepFreeze({
				...proposed.reasoningEffort === void 0 && resolvedConfig.reasoningEffort !== void 0 ? { reasoningEffort: true } : {},
				...proposed.maxTokens === void 0 && resolvedConfig.maxTokens !== void 0 ? { maxTokens: true } : {}
			});
			let dispatched = false;
			return Object.freeze({
				config: resolvedConfig,
				retryPolicy: registration.retryPolicy,
				adapterDefaults,
				...context === void 0 ? {} : { context },
				...modelInfo.inputModalities === void 0 ? {} : { inputModalities: Object.freeze([...modelInfo.inputModalities]) },
				...modelInfo.systemPromptUpdate === void 0 ? {} : { systemPromptUpdate: modelInfo.systemPromptUpdate },
				...modelInfo.toolUpdate === void 0 ? {} : { toolUpdate: modelInfo.toolUpdate },
				stream: (options) => {
					if (dispatched) throw new LlmError("a prepared LLM call can only be dispatched once", "INVALID_PREPARED_CALL");
					if (!callConfigEquals(options, resolvedConfig)) throw new LlmError("prepared LLM call config changed before adapter dispatch", "INVALID_PREPARED_CALL");
					dispatched = true;
					return this.streamWithRegistration(options, {
						registration,
						config: resolvedConfig,
						modelInfo,
						dispatch: (options) => adapterCall.stream(options)
					});
				}
			});
		}
		registration(provider) {
			const registration = this.adapters.get(provider);
			if (!registration) throw new LlmError(`no adapter registered for provider "${provider}"`, "NO_ADAPTER");
			return registration;
		}
		/** Remove replay state whose historical route is owned by another adapter. */
		forAdapter(options, adapter) {
			const messages = options.messages.map((message) => {
				if (message.role !== "assistant") return message;
				const source = message.source;
				if (source.replayState === void 0) return message;
				if (this.adapters.get(source.provider)?.adapter === adapter) return message;
				return freezeMessage({
					...message,
					source: {
						kind: "model",
						provider: source.provider,
						model: source.model
					}
				});
			});
			if (messages.every((message, index) => message === options.messages[index])) return options;
			const filtered = {
				...options,
				messages
			};
			return Object.isFrozen(options) ? deepFreeze(filtered) : filtered;
		}
		/**
		* Resolve the current execution-world read path of one durable file
		* reference through the mounted attachment and filesystem providers.
		*/
		fileReadPath(ref) {
			let hostPath;
			try {
				hostPath = this.ctx.get("attachments")?.fileHostPath(ref);
			} catch {
				return;
			}
			if (hostPath === void 0) return void 0;
			return this.ctx.get("fs")?.processPathFromHostPath(hostPath);
		}
		/**
		* Final adapter boundary. Adapter selection, dispatch, iterator construction,
		* and iteration failures become one terminal failure chunk. Middleware and
		* downstream consumer failures remain thrown plugin or consumer errors.
		*/
		async *adapterStream(options, prepared) {
			let iterator;
			try {
				const registration = prepared?.registration ?? this.registration(options.provider);
				const adapter = registration.adapter;
				let modelInfo;
				let resolvedConfig;
				let dispatch;
				if (prepared === void 0) {
					const adapterCall = await adapter.prepareCall(options.provider, options.model, options.signal);
					modelInfo = this.normalizeModelInfo(registration, options.model, adapterCall.model);
					resolvedConfig = this.resolveCallWithInfo(options, modelInfo).config;
					dispatch = (options) => adapterCall.stream(options);
				} else {
					modelInfo = prepared.modelInfo;
					resolvedConfig = prepared.config;
					dispatch = prepared.dispatch;
				}
				if (prepared !== void 0 && !callConfigEquals(options, resolvedConfig)) throw new LlmError("prepared LLM call config changed before adapter dispatch", "INVALID_PREPARED_CALL");
				const resolvedOptions = callConfigEquals(options, resolvedConfig) ? options : Object.isFrozen(options) ? deepFreeze({
					...options,
					...resolvedConfig
				}) : {
					...options,
					...resolvedConfig
				};
				let projectedMessages = resolvedOptions.messages;
				if (projectedMessages.some((message) => contentHasFile(message.content))) projectedMessages = projectFilesToText(projectedMessages, (ref) => this.fileReadPath(ref));
				if (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image") && projectedMessages.some((message) => contentHasImage(message.content))) projectedMessages = projectImagesForTextModel(projectedMessages);
				const projectedTools = projectToolUpdates(projectedMessages, resolvedOptions.tools, modelInfo.toolUpdate, resolvedOptions.toolHistory);
				projectedMessages = projectedTools.messages;
				let projectedOptions = resolvedOptions;
				if (projectedMessages !== resolvedOptions.messages || projectedTools.tools !== resolvedOptions.tools) {
					projectedOptions = {
						...resolvedOptions,
						messages: projectedMessages,
						...projectedTools.tools === void 0 ? {} : { tools: projectedTools.tools }
					};
					if (Object.isFrozen(resolvedOptions)) deepFreeze(projectedOptions);
				}
				iterator = dispatch(this.forAdapter(projectedOptions, adapter))[Symbol.asyncIterator]();
			} catch (error) {
				yield adapterFailureChunk(error, options.signal);
				return;
			}
			let completed = false;
			try {
				while (true) {
					let item;
					try {
						const next = await iterator.next();
						item = next.done ? { done: true } : {
							done: false,
							value: next.value
						};
					} catch (error) {
						completed = true;
						yield adapterFailureChunk(error, options.signal);
						return;
					}
					if (item.done) {
						completed = true;
						return;
					}
					yield item.value;
				}
			} finally {
				if (!completed) {
					const close = iterator.return?.bind(iterator);
					if (close) await close();
				}
			}
		}
		/**
		* Stream one model call as raw chunks (token-level deltas). Replay state is
		* retained only when the same adapter instance owns its historical provider
		* and the target provider. Final adapter selection remains fixed through
		* asynchronous exact-model resolution and dispatch. Adapter selection,
		* dispatch, and iteration failures become terminal `error` or `aborted`
		* finish chunks; middleware, nested-call, cleanup, and consumer failures
		* remain thrown.
		* @param options - the full request; `options.provider` selects the adapter.
		* @returns the chunk stream, possibly wrapped by `llm/stream` listeners.
		*/
		stream(options) {
			return this.streamWithRegistration(options);
		}
		streamWithRegistration(options, prepared) {
			return this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared));
		}
	};
})();
/** Convert one adapter throw into the stream protocol's terminal outcome. */
function adapterFailureChunk(error, signal) {
	const failure = normalizeLlmFailure(error);
	return {
		type: "finish",
		reason: signal?.aborted || failure.code === "ABORTED" ? {
			kind: "aborted",
			failure
		} : {
			kind: "error",
			failure
		}
	};
}
/** Copy a directory entry, including its arrays, so neither side can mutate the other's copy. */
function detachDirectoryEntry(entry) {
	const { nativeAuth } = entry;
	return {
		...entry,
		settingsPath: [...entry.settingsPath],
		...entry.baseURLEnv === void 0 ? {} : { baseURLEnv: [...entry.baseURLEnv] },
		...nativeAuth === void 0 ? {} : { nativeAuth: {
			...nativeAuth,
			env: [...nativeAuth.env]
		} }
	};
}
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/core.js
var _a$1;
function $constructor(name, initializer, params) {
	function init(inst, def) {
		if (!inst._zod) Object.defineProperty(inst, "_zod", {
			value: {
				def,
				constr: _,
				traits: /* @__PURE__ */ new Set()
			},
			enumerable: false
		});
		if (inst._zod.traits.has(name)) return;
		inst._zod.traits.add(name);
		initializer(inst, def);
		const proto = _.prototype;
		const keys = Object.keys(proto);
		for (let i = 0; i < keys.length; i++) {
			const k = keys[i];
			if (!(k in inst)) inst[k] = proto[k].bind(inst);
		}
	}
	const Parent = params?.Parent ?? Object;
	class Definition extends Parent {}
	Object.defineProperty(Definition, "name", { value: name });
	function _(def) {
		var _a;
		const inst = params?.Parent ? new Definition() : this;
		init(inst, def);
		(_a = inst._zod).deferred ?? (_a.deferred = []);
		for (const fn of inst._zod.deferred) fn();
		return inst;
	}
	Object.defineProperty(_, "init", { value: init });
	Object.defineProperty(_, Symbol.hasInstance, { value: (inst) => {
		if (params?.Parent && inst instanceof params.Parent) return true;
		return inst?._zod?.traits?.has(name);
	} });
	Object.defineProperty(_, "name", { value: name });
	return _;
}
var $ZodAsyncError = class extends Error {
	constructor() {
		super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
	}
};
var $ZodEncodeError = class extends Error {
	constructor(name) {
		super(`Encountered unidirectional transform during encode: ${name}`);
		this.name = "ZodEncodeError";
	}
};
(_a$1 = globalThis).__zod_globalConfig ?? (_a$1.__zod_globalConfig = {});
const globalConfig = globalThis.__zod_globalConfig;
function config(newConfig) {
	if (newConfig) Object.assign(globalConfig, newConfig);
	return globalConfig;
}
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/util.js
function getEnumValues(entries) {
	const numericValues = Object.values(entries).filter((v) => typeof v === "number");
	return Object.entries(entries).filter(([k, _]) => numericValues.indexOf(+k) === -1).map(([_, v]) => v);
}
function jsonStringifyReplacer(_, value) {
	if (typeof value === "bigint") return value.toString();
	return value;
}
function cached(getter) {
	return { get value() {
		{
			const value = getter();
			Object.defineProperty(this, "value", { value });
			return value;
		}
	} };
}
function nullish(input) {
	return input === null || input === void 0;
}
function cleanRegex(source) {
	const start = source.startsWith("^") ? 1 : 0;
	const end = source.endsWith("$") ? source.length - 1 : source.length;
	return source.slice(start, end);
}
function floatSafeRemainder(val, step) {
	const ratio = val / step;
	const roundedRatio = Math.round(ratio);
	const tolerance = Number.EPSILON * Math.max(Math.abs(ratio), 1);
	if (Math.abs(ratio - roundedRatio) < tolerance) return 0;
	return ratio - roundedRatio;
}
const EVALUATING = /* @__PURE__*/ Symbol("evaluating");
function defineLazy(object, key, getter) {
	let value = void 0;
	Object.defineProperty(object, key, {
		get() {
			if (value === EVALUATING) return;
			if (value === void 0) {
				value = EVALUATING;
				value = getter();
			}
			return value;
		},
		set(v) {
			Object.defineProperty(object, key, { value: v });
		},
		configurable: true
	});
}
function assignProp(target, prop, value) {
	Object.defineProperty(target, prop, {
		value,
		writable: true,
		enumerable: true,
		configurable: true
	});
}
function mergeDefs(...defs) {
	const mergedDescriptors = {};
	for (const def of defs) {
		const descriptors = Object.getOwnPropertyDescriptors(def);
		Object.assign(mergedDescriptors, descriptors);
	}
	return Object.defineProperties({}, mergedDescriptors);
}
function esc(str) {
	return JSON.stringify(str);
}
function slugify(input) {
	return input.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
}
const captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {};
function isObject(data) {
	return typeof data === "object" && data !== null && !Array.isArray(data);
}
const allowsEval = /* @__PURE__*/ cached(() => {
	if (globalConfig.jitless) return false;
	if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare")) return false;
	try {
		new Function("");
		return true;
	} catch (_) {
		return false;
	}
});
function isPlainObject(o) {
	if (isObject(o) === false) return false;
	const ctor = o.constructor;
	if (ctor === void 0) return true;
	if (typeof ctor !== "function") return true;
	const prot = ctor.prototype;
	if (isObject(prot) === false) return false;
	if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) return false;
	return true;
}
function shallowClone(o) {
	if (isPlainObject(o)) return { ...o };
	if (Array.isArray(o)) return [...o];
	if (o instanceof Map) return new Map(o);
	if (o instanceof Set) return new Set(o);
	return o;
}
const propertyKeyTypes = /* @__PURE__*/ new Set([
	"string",
	"number",
	"symbol"
]);
function escapeRegex(str) {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function clone(inst, def, params) {
	const cl = new inst._zod.constr(def ?? inst._zod.def);
	if (!def || params?.parent) cl._zod.parent = inst;
	return cl;
}
function normalizeParams(_params) {
	const params = _params;
	if (!params) return {};
	if (typeof params === "string") return { error: () => params };
	if (params?.message !== void 0) {
		if (params?.error !== void 0) throw new Error("Cannot specify both `message` and `error` params");
		params.error = params.message;
	}
	delete params.message;
	if (typeof params.error === "string") return {
		...params,
		error: () => params.error
	};
	return params;
}
function optionalKeys(shape) {
	return Object.keys(shape).filter((k) => {
		return shape[k]._zod.optin === "optional" && shape[k]._zod.optout === "optional";
	});
}
const NUMBER_FORMAT_RANGES = {
	safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
	int32: [-2147483648, 2147483647],
	uint32: [0, 4294967295],
	float32: [-34028234663852886e22, 34028234663852886e22],
	float64: [-Number.MAX_VALUE, Number.MAX_VALUE]
};
function pick(schema, mask) {
	const currDef = schema._zod.def;
	const checks = currDef.checks;
	if (checks && checks.length > 0) throw new Error(".pick() cannot be used on object schemas containing refinements");
	return clone(schema, mergeDefs(schema._zod.def, {
		get shape() {
			const newShape = {};
			for (const key in mask) {
				if (!(key in currDef.shape)) throw new Error(`Unrecognized key: "${key}"`);
				if (!mask[key]) continue;
				newShape[key] = currDef.shape[key];
			}
			assignProp(this, "shape", newShape);
			return newShape;
		},
		checks: []
	}));
}
function omit(schema, mask) {
	const currDef = schema._zod.def;
	const checks = currDef.checks;
	if (checks && checks.length > 0) throw new Error(".omit() cannot be used on object schemas containing refinements");
	return clone(schema, mergeDefs(schema._zod.def, {
		get shape() {
			const newShape = { ...schema._zod.def.shape };
			for (const key in mask) {
				if (!(key in currDef.shape)) throw new Error(`Unrecognized key: "${key}"`);
				if (!mask[key]) continue;
				delete newShape[key];
			}
			assignProp(this, "shape", newShape);
			return newShape;
		},
		checks: []
	}));
}
function extend(schema, shape) {
	if (!isPlainObject(shape)) throw new Error("Invalid input to extend: expected a plain object");
	const checks = schema._zod.def.checks;
	if (checks && checks.length > 0) {
		const existingShape = schema._zod.def.shape;
		for (const key in shape) if (Object.getOwnPropertyDescriptor(existingShape, key) !== void 0) throw new Error("Cannot overwrite keys on object schemas containing refinements. Use `.safeExtend()` instead.");
	}
	return clone(schema, mergeDefs(schema._zod.def, { get shape() {
		const _shape = {
			...schema._zod.def.shape,
			...shape
		};
		assignProp(this, "shape", _shape);
		return _shape;
	} }));
}
function safeExtend(schema, shape) {
	if (!isPlainObject(shape)) throw new Error("Invalid input to safeExtend: expected a plain object");
	return clone(schema, mergeDefs(schema._zod.def, { get shape() {
		const _shape = {
			...schema._zod.def.shape,
			...shape
		};
		assignProp(this, "shape", _shape);
		return _shape;
	} }));
}
function merge(a, b) {
	if (a._zod.def.checks?.length) throw new Error(".merge() cannot be used on object schemas containing refinements. Use .safeExtend() instead.");
	return clone(a, mergeDefs(a._zod.def, {
		get shape() {
			const _shape = {
				...a._zod.def.shape,
				...b._zod.def.shape
			};
			assignProp(this, "shape", _shape);
			return _shape;
		},
		get catchall() {
			return b._zod.def.catchall;
		},
		checks: b._zod.def.checks ?? []
	}));
}
function partial(Class, schema, mask) {
	const checks = schema._zod.def.checks;
	if (checks && checks.length > 0) throw new Error(".partial() cannot be used on object schemas containing refinements");
	return clone(schema, mergeDefs(schema._zod.def, {
		get shape() {
			const oldShape = schema._zod.def.shape;
			const shape = { ...oldShape };
			if (mask) for (const key in mask) {
				if (!(key in oldShape)) throw new Error(`Unrecognized key: "${key}"`);
				if (!mask[key]) continue;
				shape[key] = Class ? new Class({
					type: "optional",
					innerType: oldShape[key]
				}) : oldShape[key];
			}
			else for (const key in oldShape) shape[key] = Class ? new Class({
				type: "optional",
				innerType: oldShape[key]
			}) : oldShape[key];
			assignProp(this, "shape", shape);
			return shape;
		},
		checks: []
	}));
}
function required(Class, schema, mask) {
	return clone(schema, mergeDefs(schema._zod.def, { get shape() {
		const oldShape = schema._zod.def.shape;
		const shape = { ...oldShape };
		if (mask) for (const key in mask) {
			if (!(key in shape)) throw new Error(`Unrecognized key: "${key}"`);
			if (!mask[key]) continue;
			shape[key] = new Class({
				type: "nonoptional",
				innerType: oldShape[key]
			});
		}
		else for (const key in oldShape) shape[key] = new Class({
			type: "nonoptional",
			innerType: oldShape[key]
		});
		assignProp(this, "shape", shape);
		return shape;
	} }));
}
function aborted(x, startIndex = 0) {
	if (x.aborted === true) return true;
	for (let i = startIndex; i < x.issues.length; i++) if (x.issues[i]?.continue !== true) return true;
	return false;
}
function explicitlyAborted(x, startIndex = 0) {
	if (x.aborted === true) return true;
	for (let i = startIndex; i < x.issues.length; i++) if (x.issues[i]?.continue === false) return true;
	return false;
}
function prefixIssues(path, issues) {
	return issues.map((iss) => {
		var _a;
		(_a = iss).path ?? (_a.path = []);
		iss.path.unshift(path);
		return iss;
	});
}
function unwrapMessage(message) {
	return typeof message === "string" ? message : message?.message;
}
function finalizeIssue(iss, ctx, config) {
	const message = iss.message ? iss.message : unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ?? unwrapMessage(ctx?.error?.(iss)) ?? unwrapMessage(config.customError?.(iss)) ?? unwrapMessage(config.localeError?.(iss)) ?? "Invalid input";
	const { inst: _inst, continue: _continue, input: _input, ...rest } = iss;
	rest.path ?? (rest.path = []);
	rest.message = message;
	if (ctx?.reportInput) rest.input = _input;
	return rest;
}
function getLengthableOrigin(input) {
	if (Array.isArray(input)) return "array";
	if (typeof input === "string") return "string";
	return "unknown";
}
function issue(...args) {
	const [iss, input, inst] = args;
	if (typeof iss === "string") return {
		message: iss,
		code: "custom",
		input,
		inst
	};
	return { ...iss };
}
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/errors.js
const initializer$1 = (inst, def) => {
	inst.name = "$ZodError";
	Object.defineProperty(inst, "_zod", {
		value: inst._zod,
		enumerable: false
	});
	Object.defineProperty(inst, "issues", {
		value: def,
		enumerable: false
	});
	inst.message = JSON.stringify(def, jsonStringifyReplacer, 2);
	Object.defineProperty(inst, "toString", {
		value: () => inst.message,
		enumerable: false
	});
};
const $ZodError = $constructor("$ZodError", initializer$1);
const $ZodRealError = $constructor("$ZodError", initializer$1, { Parent: Error });
function flattenError(error, mapper = (issue) => issue.message) {
	const fieldErrors = {};
	const formErrors = [];
	for (const sub of error.issues) if (sub.path.length > 0) {
		fieldErrors[sub.path[0]] = fieldErrors[sub.path[0]] || [];
		fieldErrors[sub.path[0]].push(mapper(sub));
	} else formErrors.push(mapper(sub));
	return {
		formErrors,
		fieldErrors
	};
}
function formatError(error, mapper = (issue) => issue.message) {
	const fieldErrors = { _errors: [] };
	const processError = (error, path = []) => {
		for (const issue of error.issues) if (issue.code === "invalid_union" && issue.errors.length) issue.errors.map((issues) => processError({ issues }, [...path, ...issue.path]));
		else if (issue.code === "invalid_key") processError({ issues: issue.issues }, [...path, ...issue.path]);
		else if (issue.code === "invalid_element") processError({ issues: issue.issues }, [...path, ...issue.path]);
		else {
			const fullpath = [...path, ...issue.path];
			if (fullpath.length === 0) fieldErrors._errors.push(mapper(issue));
			else {
				let curr = fieldErrors;
				let i = 0;
				while (i < fullpath.length) {
					const el = fullpath[i];
					if (!(i === fullpath.length - 1)) curr[el] = curr[el] || { _errors: [] };
					else {
						curr[el] = curr[el] || { _errors: [] };
						curr[el]._errors.push(mapper(issue));
					}
					curr = curr[el];
					i++;
				}
			}
		}
	};
	processError(error);
	return fieldErrors;
}
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/parse.js
const _parse = (_Err) => (schema, value, _ctx, _params) => {
	const ctx = _ctx ? {
		..._ctx,
		async: false
	} : { async: false };
	const result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) throw new $ZodAsyncError();
	if (result.issues.length) {
		const e = new ((_params?.Err) ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
		captureStackTrace(e, _params?.callee);
		throw e;
	}
	return result.value;
};
const _parseAsync = (_Err) => async (schema, value, _ctx, params) => {
	const ctx = _ctx ? {
		..._ctx,
		async: true
	} : { async: true };
	let result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) result = await result;
	if (result.issues.length) {
		const e = new ((params?.Err) ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
		captureStackTrace(e, params?.callee);
		throw e;
	}
	return result.value;
};
const _safeParse = (_Err) => (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		async: false
	} : { async: false };
	const result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) throw new $ZodAsyncError();
	return result.issues.length ? {
		success: false,
		error: new (_Err ?? $ZodError)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
	} : {
		success: true,
		data: result.value
	};
};
const safeParse$1 = /* @__PURE__*/ _safeParse($ZodRealError);
const _safeParseAsync = (_Err) => async (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		async: true
	} : { async: true };
	let result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) result = await result;
	return result.issues.length ? {
		success: false,
		error: new _Err(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
	} : {
		success: true,
		data: result.value
	};
};
const safeParseAsync$1 = /* @__PURE__*/ _safeParseAsync($ZodRealError);
const _encode = (_Err) => (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		direction: "backward"
	} : { direction: "backward" };
	return _parse(_Err)(schema, value, ctx);
};
const _decode = (_Err) => (schema, value, _ctx) => {
	return _parse(_Err)(schema, value, _ctx);
};
const _encodeAsync = (_Err) => async (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		direction: "backward"
	} : { direction: "backward" };
	return _parseAsync(_Err)(schema, value, ctx);
};
const _decodeAsync = (_Err) => async (schema, value, _ctx) => {
	return _parseAsync(_Err)(schema, value, _ctx);
};
const _safeEncode = (_Err) => (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		direction: "backward"
	} : { direction: "backward" };
	return _safeParse(_Err)(schema, value, ctx);
};
const _safeDecode = (_Err) => (schema, value, _ctx) => {
	return _safeParse(_Err)(schema, value, _ctx);
};
const _safeEncodeAsync = (_Err) => async (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		direction: "backward"
	} : { direction: "backward" };
	return _safeParseAsync(_Err)(schema, value, ctx);
};
const _safeDecodeAsync = (_Err) => async (schema, value, _ctx) => {
	return _safeParseAsync(_Err)(schema, value, _ctx);
};
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/regexes.js
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link cuid2} instead.
* See https://github.com/paralleldrive/cuid.
*/
const cuid = /^[cC][0-9a-z]{6,}$/;
const cuid2 = /^[0-9a-z]+$/;
const ulid = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;
const xid = /^[0-9a-vA-V]{20}$/;
const ksuid = /^[A-Za-z0-9]{27}$/;
const nanoid = /^[a-zA-Z0-9_-]{21}$/;
/** ISO 8601-1 duration regex. Does not support the 8601-2 extensions like negative durations or fractional/negative components. */
const duration$1 = /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/;
/** A regex for any UUID-like identifier: 8-4-4-4-12 hex pattern */
const guid = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
/** Returns a regex for validating an RFC 9562/4122 UUID.
*
* @param version Optionally specify a version 1-8. If no version is specified, all versions are supported. */
const uuid = (version) => {
	if (!version) return /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
	return new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${version}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`);
};
/** Practical email validation */
const email = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
const _emoji$1 = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
function emoji() {
	return new RegExp(_emoji$1, "u");
}
const ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
const ipv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
const cidrv4 = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/;
const cidrv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|::|([0-9a-fA-F]{1,4})?::([0-9a-fA-F]{1,4}:?){0,6})\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
const base64 = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/;
const base64url = /^[A-Za-z0-9_-]*$/;
const httpProtocol = /^https?$/;
const e164 = /^\+[1-9]\d{6,14}$/;
const dateSource = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
const date$1 = /*@__PURE__*/ new RegExp(`^${dateSource}$`);
function timeSource(args) {
	const hhmm = `(?:[01]\\d|2[0-3]):[0-5]\\d`;
	return typeof args.precision === "number" ? args.precision === -1 ? `${hhmm}` : args.precision === 0 ? `${hhmm}:[0-5]\\d` : `${hhmm}:[0-5]\\d\\.\\d{${args.precision}}` : `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
}
function time$1(args) {
	return new RegExp(`^${timeSource(args)}$`);
}
function datetime$1(args) {
	const time = timeSource({ precision: args.precision });
	const opts = ["Z"];
	if (args.local) opts.push("");
	if (args.offset) opts.push(`([+-](?:[01]\\d|2[0-3]):[0-5]\\d)`);
	const timeRegex = `${time}(?:${opts.join("|")})`;
	return new RegExp(`^${dateSource}T(?:${timeRegex})$`);
}
const string$1 = (params) => {
	const regex = params ? `[\\s\\S]{${params?.minimum ?? 0},${params?.maximum ?? ""}}` : `[\\s\\S]*`;
	return new RegExp(`^${regex}$`);
};
const integer = /^-?\d+$/;
const number$1 = /^-?\d+(?:\.\d+)?$/;
const boolean$1 = /^(?:true|false)$/i;
const lowercase = /^[^A-Z]*$/;
const uppercase = /^[^a-z]*$/;
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/checks.js
const $ZodCheck = /*@__PURE__*/ $constructor("$ZodCheck", (inst, def) => {
	var _a;
	inst._zod ?? (inst._zod = {});
	inst._zod.def = def;
	(_a = inst._zod).onattach ?? (_a.onattach = []);
});
const numericOriginMap = {
	number: "number",
	bigint: "bigint",
	object: "date"
};
const $ZodCheckLessThan = /*@__PURE__*/ $constructor("$ZodCheckLessThan", (inst, def) => {
	$ZodCheck.init(inst, def);
	const origin = numericOriginMap[typeof def.value];
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		const curr = (def.inclusive ? bag.maximum : bag.exclusiveMaximum) ?? Number.POSITIVE_INFINITY;
		if (def.value < curr) {
			if (def.inclusive) bag.maximum = def.value;
			else bag.exclusiveMaximum = def.value;
		}
	});
	inst._zod.check = (payload) => {
		if (def.inclusive ? payload.value <= def.value : payload.value < def.value) return;
		payload.issues.push({
			origin,
			code: "too_big",
			maximum: typeof def.value === "object" ? def.value.getTime() : def.value,
			input: payload.value,
			inclusive: def.inclusive,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckGreaterThan = /*@__PURE__*/ $constructor("$ZodCheckGreaterThan", (inst, def) => {
	$ZodCheck.init(inst, def);
	const origin = numericOriginMap[typeof def.value];
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		const curr = (def.inclusive ? bag.minimum : bag.exclusiveMinimum) ?? Number.NEGATIVE_INFINITY;
		if (def.value > curr) {
			if (def.inclusive) bag.minimum = def.value;
			else bag.exclusiveMinimum = def.value;
		}
	});
	inst._zod.check = (payload) => {
		if (def.inclusive ? payload.value >= def.value : payload.value > def.value) return;
		payload.issues.push({
			origin,
			code: "too_small",
			minimum: typeof def.value === "object" ? def.value.getTime() : def.value,
			input: payload.value,
			inclusive: def.inclusive,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckMultipleOf = /*@__PURE__*/ $constructor("$ZodCheckMultipleOf", (inst, def) => {
	$ZodCheck.init(inst, def);
	inst._zod.onattach.push((inst) => {
		var _a;
		(_a = inst._zod.bag).multipleOf ?? (_a.multipleOf = def.value);
	});
	inst._zod.check = (payload) => {
		if (typeof payload.value !== typeof def.value) throw new Error("Cannot mix number and bigint in multiple_of check.");
		if (typeof payload.value === "bigint" ? payload.value % def.value === BigInt(0) : floatSafeRemainder(payload.value, def.value) === 0) return;
		payload.issues.push({
			origin: typeof payload.value,
			code: "not_multiple_of",
			divisor: def.value,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckNumberFormat = /*@__PURE__*/ $constructor("$ZodCheckNumberFormat", (inst, def) => {
	$ZodCheck.init(inst, def);
	def.format = def.format || "float64";
	const isInt = def.format?.includes("int");
	const origin = isInt ? "int" : "number";
	const [minimum, maximum] = NUMBER_FORMAT_RANGES[def.format];
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.format = def.format;
		bag.minimum = minimum;
		bag.maximum = maximum;
		if (isInt) bag.pattern = integer;
	});
	inst._zod.check = (payload) => {
		const input = payload.value;
		if (isInt) {
			if (!Number.isInteger(input)) {
				payload.issues.push({
					expected: origin,
					format: def.format,
					code: "invalid_type",
					continue: false,
					input,
					inst
				});
				return;
			}
			if (!Number.isSafeInteger(input)) {
				if (input > 0) payload.issues.push({
					input,
					code: "too_big",
					maximum: Number.MAX_SAFE_INTEGER,
					note: "Integers must be within the safe integer range.",
					inst,
					origin,
					inclusive: true,
					continue: !def.abort
				});
				else payload.issues.push({
					input,
					code: "too_small",
					minimum: Number.MIN_SAFE_INTEGER,
					note: "Integers must be within the safe integer range.",
					inst,
					origin,
					inclusive: true,
					continue: !def.abort
				});
				return;
			}
		}
		if (input < minimum) payload.issues.push({
			origin: "number",
			input,
			code: "too_small",
			minimum,
			inclusive: true,
			inst,
			continue: !def.abort
		});
		if (input > maximum) payload.issues.push({
			origin: "number",
			input,
			code: "too_big",
			maximum,
			inclusive: true,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckMaxLength = /*@__PURE__*/ $constructor("$ZodCheckMaxLength", (inst, def) => {
	var _a;
	$ZodCheck.init(inst, def);
	(_a = inst._zod.def).when ?? (_a.when = (payload) => {
		const val = payload.value;
		return !nullish(val) && val.length !== void 0;
	});
	inst._zod.onattach.push((inst) => {
		const curr = inst._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
		if (def.maximum < curr) inst._zod.bag.maximum = def.maximum;
	});
	inst._zod.check = (payload) => {
		const input = payload.value;
		if (input.length <= def.maximum) return;
		const origin = getLengthableOrigin(input);
		payload.issues.push({
			origin,
			code: "too_big",
			maximum: def.maximum,
			inclusive: true,
			input,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckMinLength = /*@__PURE__*/ $constructor("$ZodCheckMinLength", (inst, def) => {
	var _a;
	$ZodCheck.init(inst, def);
	(_a = inst._zod.def).when ?? (_a.when = (payload) => {
		const val = payload.value;
		return !nullish(val) && val.length !== void 0;
	});
	inst._zod.onattach.push((inst) => {
		const curr = inst._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
		if (def.minimum > curr) inst._zod.bag.minimum = def.minimum;
	});
	inst._zod.check = (payload) => {
		const input = payload.value;
		if (input.length >= def.minimum) return;
		const origin = getLengthableOrigin(input);
		payload.issues.push({
			origin,
			code: "too_small",
			minimum: def.minimum,
			inclusive: true,
			input,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckLengthEquals = /*@__PURE__*/ $constructor("$ZodCheckLengthEquals", (inst, def) => {
	var _a;
	$ZodCheck.init(inst, def);
	(_a = inst._zod.def).when ?? (_a.when = (payload) => {
		const val = payload.value;
		return !nullish(val) && val.length !== void 0;
	});
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.minimum = def.length;
		bag.maximum = def.length;
		bag.length = def.length;
	});
	inst._zod.check = (payload) => {
		const input = payload.value;
		const length = input.length;
		if (length === def.length) return;
		const origin = getLengthableOrigin(input);
		const tooBig = length > def.length;
		payload.issues.push({
			origin,
			...tooBig ? {
				code: "too_big",
				maximum: def.length
			} : {
				code: "too_small",
				minimum: def.length
			},
			inclusive: true,
			exact: true,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckStringFormat = /*@__PURE__*/ $constructor("$ZodCheckStringFormat", (inst, def) => {
	var _a, _b;
	$ZodCheck.init(inst, def);
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.format = def.format;
		if (def.pattern) {
			bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
			bag.patterns.add(def.pattern);
		}
	});
	if (def.pattern) (_a = inst._zod).check ?? (_a.check = (payload) => {
		def.pattern.lastIndex = 0;
		if (def.pattern.test(payload.value)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: def.format,
			input: payload.value,
			...def.pattern ? { pattern: def.pattern.toString() } : {},
			inst,
			continue: !def.abort
		});
	});
	else (_b = inst._zod).check ?? (_b.check = () => {});
});
const $ZodCheckRegex = /*@__PURE__*/ $constructor("$ZodCheckRegex", (inst, def) => {
	$ZodCheckStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		def.pattern.lastIndex = 0;
		if (def.pattern.test(payload.value)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "regex",
			input: payload.value,
			pattern: def.pattern.toString(),
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckLowerCase = /*@__PURE__*/ $constructor("$ZodCheckLowerCase", (inst, def) => {
	def.pattern ?? (def.pattern = lowercase);
	$ZodCheckStringFormat.init(inst, def);
});
const $ZodCheckUpperCase = /*@__PURE__*/ $constructor("$ZodCheckUpperCase", (inst, def) => {
	def.pattern ?? (def.pattern = uppercase);
	$ZodCheckStringFormat.init(inst, def);
});
const $ZodCheckIncludes = /*@__PURE__*/ $constructor("$ZodCheckIncludes", (inst, def) => {
	$ZodCheck.init(inst, def);
	const escapedRegex = escapeRegex(def.includes);
	const pattern = new RegExp(typeof def.position === "number" ? `^.{${def.position}}${escapedRegex}` : escapedRegex);
	def.pattern = pattern;
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
		bag.patterns.add(pattern);
	});
	inst._zod.check = (payload) => {
		if (payload.value.includes(def.includes, def.position)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "includes",
			includes: def.includes,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckStartsWith = /*@__PURE__*/ $constructor("$ZodCheckStartsWith", (inst, def) => {
	$ZodCheck.init(inst, def);
	const pattern = new RegExp(`^${escapeRegex(def.prefix)}.*`);
	def.pattern ?? (def.pattern = pattern);
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
		bag.patterns.add(pattern);
	});
	inst._zod.check = (payload) => {
		if (payload.value.startsWith(def.prefix)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "starts_with",
			prefix: def.prefix,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckEndsWith = /*@__PURE__*/ $constructor("$ZodCheckEndsWith", (inst, def) => {
	$ZodCheck.init(inst, def);
	const pattern = new RegExp(`.*${escapeRegex(def.suffix)}$`);
	def.pattern ?? (def.pattern = pattern);
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
		bag.patterns.add(pattern);
	});
	inst._zod.check = (payload) => {
		if (payload.value.endsWith(def.suffix)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "ends_with",
			suffix: def.suffix,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckOverwrite = /*@__PURE__*/ $constructor("$ZodCheckOverwrite", (inst, def) => {
	$ZodCheck.init(inst, def);
	inst._zod.check = (payload) => {
		payload.value = def.tx(payload.value);
	};
});
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/doc.js
var Doc = class {
	constructor(args = []) {
		this.content = [];
		this.indent = 0;
		if (this) this.args = args;
	}
	indented(fn) {
		this.indent += 1;
		fn(this);
		this.indent -= 1;
	}
	write(arg) {
		if (typeof arg === "function") {
			arg(this, { execution: "sync" });
			arg(this, { execution: "async" });
			return;
		}
		const lines = arg.split("\n").filter((x) => x);
		const minIndent = Math.min(...lines.map((x) => x.length - x.trimStart().length));
		const dedented = lines.map((x) => x.slice(minIndent)).map((x) => " ".repeat(this.indent * 2) + x);
		for (const line of dedented) this.content.push(line);
	}
	compile() {
		const F = Function;
		const args = this?.args;
		const lines = [...(this?.content ?? [``]).map((x) => `  ${x}`)];
		return new F(...args, lines.join("\n"));
	}
};
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/versions.js
const version = {
	major: 4,
	minor: 4,
	patch: 3
};
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/schemas.js
const $ZodType = /*@__PURE__*/ $constructor("$ZodType", (inst, def) => {
	var _a;
	inst ?? (inst = {});
	inst._zod.def = def;
	inst._zod.bag = inst._zod.bag || {};
	inst._zod.version = version;
	const checks = [...inst._zod.def.checks ?? []];
	if (inst._zod.traits.has("$ZodCheck")) checks.unshift(inst);
	for (const ch of checks) for (const fn of ch._zod.onattach) fn(inst);
	if (checks.length === 0) {
		(_a = inst._zod).deferred ?? (_a.deferred = []);
		inst._zod.deferred?.push(() => {
			inst._zod.run = inst._zod.parse;
		});
	} else {
		const runChecks = (payload, checks, ctx) => {
			let isAborted = aborted(payload);
			let asyncResult;
			for (const ch of checks) {
				if (ch._zod.def.when) {
					if (explicitlyAborted(payload)) continue;
					if (!ch._zod.def.when(payload)) continue;
				} else if (isAborted) continue;
				const currLen = payload.issues.length;
				const _ = ch._zod.check(payload);
				if (_ instanceof Promise && ctx?.async === false) throw new $ZodAsyncError();
				if (asyncResult || _ instanceof Promise) asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
					await _;
					if (payload.issues.length === currLen) return;
					if (!isAborted) isAborted = aborted(payload, currLen);
				});
				else {
					if (payload.issues.length === currLen) continue;
					if (!isAborted) isAborted = aborted(payload, currLen);
				}
			}
			if (asyncResult) return asyncResult.then(() => {
				return payload;
			});
			return payload;
		};
		const handleCanaryResult = (canary, payload, ctx) => {
			if (aborted(canary)) {
				canary.aborted = true;
				return canary;
			}
			const checkResult = runChecks(payload, checks, ctx);
			if (checkResult instanceof Promise) {
				if (ctx.async === false) throw new $ZodAsyncError();
				return checkResult.then((checkResult) => inst._zod.parse(checkResult, ctx));
			}
			return inst._zod.parse(checkResult, ctx);
		};
		inst._zod.run = (payload, ctx) => {
			if (ctx.skipChecks) return inst._zod.parse(payload, ctx);
			if (ctx.direction === "backward") {
				const canary = inst._zod.parse({
					value: payload.value,
					issues: []
				}, {
					...ctx,
					skipChecks: true
				});
				if (canary instanceof Promise) return canary.then((canary) => {
					return handleCanaryResult(canary, payload, ctx);
				});
				return handleCanaryResult(canary, payload, ctx);
			}
			const result = inst._zod.parse(payload, ctx);
			if (result instanceof Promise) {
				if (ctx.async === false) throw new $ZodAsyncError();
				return result.then((result) => runChecks(result, checks, ctx));
			}
			return runChecks(result, checks, ctx);
		};
	}
	defineLazy(inst, "~standard", () => ({
		validate: (value) => {
			try {
				const r = safeParse$1(inst, value);
				return r.success ? { value: r.data } : { issues: r.error?.issues };
			} catch (_) {
				return safeParseAsync$1(inst, value).then((r) => r.success ? { value: r.data } : { issues: r.error?.issues });
			}
		},
		vendor: "zod",
		version: 1
	}));
});
const $ZodString = /*@__PURE__*/ $constructor("$ZodString", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.pattern = [...inst?._zod.bag?.patterns ?? []].pop() ?? string$1(inst._zod.bag);
	inst._zod.parse = (payload, _) => {
		if (def.coerce) try {
			payload.value = String(payload.value);
		} catch (_) {}
		if (typeof payload.value === "string") return payload;
		payload.issues.push({
			expected: "string",
			code: "invalid_type",
			input: payload.value,
			inst
		});
		return payload;
	};
});
const $ZodStringFormat = /*@__PURE__*/ $constructor("$ZodStringFormat", (inst, def) => {
	$ZodCheckStringFormat.init(inst, def);
	$ZodString.init(inst, def);
});
const $ZodGUID = /*@__PURE__*/ $constructor("$ZodGUID", (inst, def) => {
	def.pattern ?? (def.pattern = guid);
	$ZodStringFormat.init(inst, def);
});
const $ZodUUID = /*@__PURE__*/ $constructor("$ZodUUID", (inst, def) => {
	if (def.version) {
		const v = {
			v1: 1,
			v2: 2,
			v3: 3,
			v4: 4,
			v5: 5,
			v6: 6,
			v7: 7,
			v8: 8
		}[def.version];
		if (v === void 0) throw new Error(`Invalid UUID version: "${def.version}"`);
		def.pattern ?? (def.pattern = uuid(v));
	} else def.pattern ?? (def.pattern = uuid());
	$ZodStringFormat.init(inst, def);
});
const $ZodEmail = /*@__PURE__*/ $constructor("$ZodEmail", (inst, def) => {
	def.pattern ?? (def.pattern = email);
	$ZodStringFormat.init(inst, def);
});
const $ZodURL = /*@__PURE__*/ $constructor("$ZodURL", (inst, def) => {
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		try {
			const trimmed = payload.value.trim();
			if (!def.normalize && def.protocol?.source === httpProtocol.source) {
				if (!/^https?:\/\//i.test(trimmed)) {
					payload.issues.push({
						code: "invalid_format",
						format: "url",
						note: "Invalid URL format",
						input: payload.value,
						inst,
						continue: !def.abort
					});
					return;
				}
			}
			const url = new URL(trimmed);
			if (def.hostname) {
				def.hostname.lastIndex = 0;
				if (!def.hostname.test(url.hostname)) payload.issues.push({
					code: "invalid_format",
					format: "url",
					note: "Invalid hostname",
					pattern: def.hostname.source,
					input: payload.value,
					inst,
					continue: !def.abort
				});
			}
			if (def.protocol) {
				def.protocol.lastIndex = 0;
				if (!def.protocol.test(url.protocol.endsWith(":") ? url.protocol.slice(0, -1) : url.protocol)) payload.issues.push({
					code: "invalid_format",
					format: "url",
					note: "Invalid protocol",
					pattern: def.protocol.source,
					input: payload.value,
					inst,
					continue: !def.abort
				});
			}
			if (def.normalize) payload.value = url.href;
			else payload.value = trimmed;
			return;
		} catch (_) {
			payload.issues.push({
				code: "invalid_format",
				format: "url",
				input: payload.value,
				inst,
				continue: !def.abort
			});
		}
	};
});
const $ZodEmoji = /*@__PURE__*/ $constructor("$ZodEmoji", (inst, def) => {
	def.pattern ?? (def.pattern = emoji());
	$ZodStringFormat.init(inst, def);
});
const $ZodNanoID = /*@__PURE__*/ $constructor("$ZodNanoID", (inst, def) => {
	def.pattern ?? (def.pattern = nanoid);
	$ZodStringFormat.init(inst, def);
});
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link $ZodCUID2} instead.
* See https://github.com/paralleldrive/cuid.
*/
const $ZodCUID = /*@__PURE__*/ $constructor("$ZodCUID", (inst, def) => {
	def.pattern ?? (def.pattern = cuid);
	$ZodStringFormat.init(inst, def);
});
const $ZodCUID2 = /*@__PURE__*/ $constructor("$ZodCUID2", (inst, def) => {
	def.pattern ?? (def.pattern = cuid2);
	$ZodStringFormat.init(inst, def);
});
const $ZodULID = /*@__PURE__*/ $constructor("$ZodULID", (inst, def) => {
	def.pattern ?? (def.pattern = ulid);
	$ZodStringFormat.init(inst, def);
});
const $ZodXID = /*@__PURE__*/ $constructor("$ZodXID", (inst, def) => {
	def.pattern ?? (def.pattern = xid);
	$ZodStringFormat.init(inst, def);
});
const $ZodKSUID = /*@__PURE__*/ $constructor("$ZodKSUID", (inst, def) => {
	def.pattern ?? (def.pattern = ksuid);
	$ZodStringFormat.init(inst, def);
});
const $ZodISODateTime = /*@__PURE__*/ $constructor("$ZodISODateTime", (inst, def) => {
	def.pattern ?? (def.pattern = datetime$1(def));
	$ZodStringFormat.init(inst, def);
});
const $ZodISODate = /*@__PURE__*/ $constructor("$ZodISODate", (inst, def) => {
	def.pattern ?? (def.pattern = date$1);
	$ZodStringFormat.init(inst, def);
});
const $ZodISOTime = /*@__PURE__*/ $constructor("$ZodISOTime", (inst, def) => {
	def.pattern ?? (def.pattern = time$1(def));
	$ZodStringFormat.init(inst, def);
});
const $ZodISODuration = /*@__PURE__*/ $constructor("$ZodISODuration", (inst, def) => {
	def.pattern ?? (def.pattern = duration$1);
	$ZodStringFormat.init(inst, def);
});
const $ZodIPv4 = /*@__PURE__*/ $constructor("$ZodIPv4", (inst, def) => {
	def.pattern ?? (def.pattern = ipv4);
	$ZodStringFormat.init(inst, def);
	inst._zod.bag.format = `ipv4`;
});
const $ZodIPv6 = /*@__PURE__*/ $constructor("$ZodIPv6", (inst, def) => {
	def.pattern ?? (def.pattern = ipv6);
	$ZodStringFormat.init(inst, def);
	inst._zod.bag.format = `ipv6`;
	inst._zod.check = (payload) => {
		try {
			new URL(`http://[${payload.value}]`);
		} catch {
			payload.issues.push({
				code: "invalid_format",
				format: "ipv6",
				input: payload.value,
				inst,
				continue: !def.abort
			});
		}
	};
});
const $ZodCIDRv4 = /*@__PURE__*/ $constructor("$ZodCIDRv4", (inst, def) => {
	def.pattern ?? (def.pattern = cidrv4);
	$ZodStringFormat.init(inst, def);
});
const $ZodCIDRv6 = /*@__PURE__*/ $constructor("$ZodCIDRv6", (inst, def) => {
	def.pattern ?? (def.pattern = cidrv6);
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		const parts = payload.value.split("/");
		try {
			if (parts.length !== 2) throw new Error();
			const [address, prefix] = parts;
			if (!prefix) throw new Error();
			const prefixNum = Number(prefix);
			if (`${prefixNum}` !== prefix) throw new Error();
			if (prefixNum < 0 || prefixNum > 128) throw new Error();
			new URL(`http://[${address}]`);
		} catch {
			payload.issues.push({
				code: "invalid_format",
				format: "cidrv6",
				input: payload.value,
				inst,
				continue: !def.abort
			});
		}
	};
});
function isValidBase64(data) {
	if (data === "") return true;
	if (/\s/.test(data)) return false;
	if (data.length % 4 !== 0) return false;
	try {
		atob(data);
		return true;
	} catch {
		return false;
	}
}
const $ZodBase64 = /*@__PURE__*/ $constructor("$ZodBase64", (inst, def) => {
	def.pattern ?? (def.pattern = base64);
	$ZodStringFormat.init(inst, def);
	inst._zod.bag.contentEncoding = "base64";
	inst._zod.check = (payload) => {
		if (isValidBase64(payload.value)) return;
		payload.issues.push({
			code: "invalid_format",
			format: "base64",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
function isValidBase64URL(data) {
	if (!base64url.test(data)) return false;
	const base64 = data.replace(/[-_]/g, (c) => c === "-" ? "+" : "/");
	return isValidBase64(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
}
const $ZodBase64URL = /*@__PURE__*/ $constructor("$ZodBase64URL", (inst, def) => {
	def.pattern ?? (def.pattern = base64url);
	$ZodStringFormat.init(inst, def);
	inst._zod.bag.contentEncoding = "base64url";
	inst._zod.check = (payload) => {
		if (isValidBase64URL(payload.value)) return;
		payload.issues.push({
			code: "invalid_format",
			format: "base64url",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodE164 = /*@__PURE__*/ $constructor("$ZodE164", (inst, def) => {
	def.pattern ?? (def.pattern = e164);
	$ZodStringFormat.init(inst, def);
});
function isValidJWT(token, algorithm = null) {
	try {
		const tokensParts = token.split(".");
		if (tokensParts.length !== 3) return false;
		const [header] = tokensParts;
		if (!header) return false;
		const parsedHeader = JSON.parse(atob(header));
		if ("typ" in parsedHeader && parsedHeader?.typ !== "JWT") return false;
		if (!parsedHeader.alg) return false;
		if (algorithm && (!("alg" in parsedHeader) || parsedHeader.alg !== algorithm)) return false;
		return true;
	} catch {
		return false;
	}
}
const $ZodJWT = /*@__PURE__*/ $constructor("$ZodJWT", (inst, def) => {
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		if (isValidJWT(payload.value, def.alg)) return;
		payload.issues.push({
			code: "invalid_format",
			format: "jwt",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodNumber = /*@__PURE__*/ $constructor("$ZodNumber", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.pattern = inst._zod.bag.pattern ?? number$1;
	inst._zod.parse = (payload, _ctx) => {
		if (def.coerce) try {
			payload.value = Number(payload.value);
		} catch (_) {}
		const input = payload.value;
		if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) return payload;
		const received = typeof input === "number" ? Number.isNaN(input) ? "NaN" : !Number.isFinite(input) ? "Infinity" : void 0 : void 0;
		payload.issues.push({
			expected: "number",
			code: "invalid_type",
			input,
			inst,
			...received ? { received } : {}
		});
		return payload;
	};
});
const $ZodNumberFormat = /*@__PURE__*/ $constructor("$ZodNumberFormat", (inst, def) => {
	$ZodCheckNumberFormat.init(inst, def);
	$ZodNumber.init(inst, def);
});
const $ZodBoolean = /*@__PURE__*/ $constructor("$ZodBoolean", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.pattern = boolean$1;
	inst._zod.parse = (payload, _ctx) => {
		if (def.coerce) try {
			payload.value = Boolean(payload.value);
		} catch (_) {}
		const input = payload.value;
		if (typeof input === "boolean") return payload;
		payload.issues.push({
			expected: "boolean",
			code: "invalid_type",
			input,
			inst
		});
		return payload;
	};
});
const $ZodUnknown = /*@__PURE__*/ $constructor("$ZodUnknown", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload) => payload;
});
const $ZodNever = /*@__PURE__*/ $constructor("$ZodNever", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, _ctx) => {
		payload.issues.push({
			expected: "never",
			code: "invalid_type",
			input: payload.value,
			inst
		});
		return payload;
	};
});
function handleArrayResult(result, final, index) {
	if (result.issues.length) final.issues.push(...prefixIssues(index, result.issues));
	final.value[index] = result.value;
}
const $ZodArray = /*@__PURE__*/ $constructor("$ZodArray", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		if (!Array.isArray(input)) {
			payload.issues.push({
				expected: "array",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		payload.value = Array(input.length);
		const proms = [];
		for (let i = 0; i < input.length; i++) {
			const item = input[i];
			const result = def.element._zod.run({
				value: item,
				issues: []
			}, ctx);
			if (result instanceof Promise) proms.push(result.then((result) => handleArrayResult(result, payload, i)));
			else handleArrayResult(result, payload, i);
		}
		if (proms.length) return Promise.all(proms).then(() => payload);
		return payload;
	};
});
function handlePropertyResult(result, final, key, input, isOptionalIn, isOptionalOut) {
	const isPresent = key in input;
	if (result.issues.length) {
		if (isOptionalIn && isOptionalOut && !isPresent) return;
		final.issues.push(...prefixIssues(key, result.issues));
	}
	if (!isPresent && !isOptionalIn) {
		if (!result.issues.length) final.issues.push({
			code: "invalid_type",
			expected: "nonoptional",
			input: void 0,
			path: [key]
		});
		return;
	}
	if (result.value === void 0) {
		if (isPresent) final.value[key] = void 0;
	} else final.value[key] = result.value;
}
function normalizeDef(def) {
	const keys = Object.keys(def.shape);
	for (const k of keys) if (!def.shape?.[k]?._zod?.traits?.has("$ZodType")) throw new Error(`Invalid element at key "${k}": expected a Zod schema`);
	const okeys = optionalKeys(def.shape);
	return {
		...def,
		keys,
		keySet: new Set(keys),
		numKeys: keys.length,
		optionalKeys: new Set(okeys)
	};
}
function handleCatchall(proms, input, payload, ctx, def, inst) {
	const unrecognized = [];
	const keySet = def.keySet;
	const _catchall = def.catchall._zod;
	const t = _catchall.def.type;
	const isOptionalIn = _catchall.optin === "optional";
	const isOptionalOut = _catchall.optout === "optional";
	for (const key in input) {
		if (key === "__proto__") continue;
		if (keySet.has(key)) continue;
		if (t === "never") {
			unrecognized.push(key);
			continue;
		}
		const r = _catchall.run({
			value: input[key],
			issues: []
		}, ctx);
		if (r instanceof Promise) proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut)));
		else handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut);
	}
	if (unrecognized.length) payload.issues.push({
		code: "unrecognized_keys",
		keys: unrecognized,
		input,
		inst
	});
	if (!proms.length) return payload;
	return Promise.all(proms).then(() => {
		return payload;
	});
}
const $ZodObject = /*@__PURE__*/ $constructor("$ZodObject", (inst, def) => {
	$ZodType.init(inst, def);
	if (!Object.getOwnPropertyDescriptor(def, "shape")?.get) {
		const sh = def.shape;
		Object.defineProperty(def, "shape", { get: () => {
			const newSh = { ...sh };
			Object.defineProperty(def, "shape", { value: newSh });
			return newSh;
		} });
	}
	const _normalized = cached(() => normalizeDef(def));
	defineLazy(inst._zod, "propValues", () => {
		const shape = def.shape;
		const propValues = {};
		for (const key in shape) {
			const field = shape[key]._zod;
			if (field.values) {
				propValues[key] ?? (propValues[key] = /* @__PURE__ */ new Set());
				for (const v of field.values) propValues[key].add(v);
			}
		}
		return propValues;
	});
	const isObject$2 = isObject;
	const catchall = def.catchall;
	let value;
	inst._zod.parse = (payload, ctx) => {
		value ?? (value = _normalized.value);
		const input = payload.value;
		if (!isObject$2(input)) {
			payload.issues.push({
				expected: "object",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		payload.value = {};
		const proms = [];
		const shape = value.shape;
		for (const key of value.keys) {
			const el = shape[key];
			const isOptionalIn = el._zod.optin === "optional";
			const isOptionalOut = el._zod.optout === "optional";
			const r = el._zod.run({
				value: input[key],
				issues: []
			}, ctx);
			if (r instanceof Promise) proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut)));
			else handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut);
		}
		if (!catchall) return proms.length ? Promise.all(proms).then(() => payload) : payload;
		return handleCatchall(proms, input, payload, ctx, _normalized.value, inst);
	};
});
const $ZodObjectJIT = /*@__PURE__*/ $constructor("$ZodObjectJIT", (inst, def) => {
	$ZodObject.init(inst, def);
	const superParse = inst._zod.parse;
	const _normalized = cached(() => normalizeDef(def));
	const generateFastpass = (shape) => {
		const doc = new Doc([
			"shape",
			"payload",
			"ctx"
		]);
		const normalized = _normalized.value;
		const parseStr = (key) => {
			const k = esc(key);
			return `shape[${k}]._zod.run({ value: input[${k}], issues: [] }, ctx)`;
		};
		doc.write(`const input = payload.value;`);
		const ids = Object.create(null);
		let counter = 0;
		for (const key of normalized.keys) ids[key] = `key_${counter++}`;
		doc.write(`const newResult = {};`);
		for (const key of normalized.keys) {
			const id = ids[key];
			const k = esc(key);
			const schema = shape[key];
			const isOptionalIn = schema?._zod?.optin === "optional";
			const isOptionalOut = schema?._zod?.optout === "optional";
			doc.write(`const ${id} = ${parseStr(key)};`);
			if (isOptionalIn && isOptionalOut) doc.write(`
        if (${id}.issues.length) {
          if (${k} in input) {
            payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
              ...iss,
              path: iss.path ? [${k}, ...iss.path] : [${k}]
            })));
          }
        }
        
        if (${id}.value === undefined) {
          if (${k} in input) {
            newResult[${k}] = undefined;
          }
        } else {
          newResult[${k}] = ${id}.value;
        }
        
      `);
			else if (!isOptionalIn) doc.write(`
        const ${id}_present = ${k} in input;
        if (${id}.issues.length) {
          payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${k}, ...iss.path] : [${k}]
          })));
        }
        if (!${id}_present && !${id}.issues.length) {
          payload.issues.push({
            code: "invalid_type",
            expected: "nonoptional",
            input: undefined,
            path: [${k}]
          });
        }

        if (${id}_present) {
          if (${id}.value === undefined) {
            newResult[${k}] = undefined;
          } else {
            newResult[${k}] = ${id}.value;
          }
        }

      `);
			else doc.write(`
        if (${id}.issues.length) {
          payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${k}, ...iss.path] : [${k}]
          })));
        }
        
        if (${id}.value === undefined) {
          if (${k} in input) {
            newResult[${k}] = undefined;
          }
        } else {
          newResult[${k}] = ${id}.value;
        }
        
      `);
		}
		doc.write(`payload.value = newResult;`);
		doc.write(`return payload;`);
		const fn = doc.compile();
		return (payload, ctx) => fn(shape, payload, ctx);
	};
	let fastpass;
	const isObject$3 = isObject;
	const jit = !globalConfig.jitless;
	const fastEnabled = jit && allowsEval.value;
	const catchall = def.catchall;
	let value;
	inst._zod.parse = (payload, ctx) => {
		value ?? (value = _normalized.value);
		const input = payload.value;
		if (!isObject$3(input)) {
			payload.issues.push({
				expected: "object",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		if (jit && fastEnabled && ctx?.async === false && ctx.jitless !== true) {
			if (!fastpass) fastpass = generateFastpass(def.shape);
			payload = fastpass(payload, ctx);
			if (!catchall) return payload;
			return handleCatchall([], input, payload, ctx, value, inst);
		}
		return superParse(payload, ctx);
	};
});
function handleUnionResults(results, final, inst, ctx) {
	for (const result of results) if (result.issues.length === 0) {
		final.value = result.value;
		return final;
	}
	const nonaborted = results.filter((r) => !aborted(r));
	if (nonaborted.length === 1) {
		final.value = nonaborted[0].value;
		return nonaborted[0];
	}
	final.issues.push({
		code: "invalid_union",
		input: final.value,
		inst,
		errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
	});
	return final;
}
const $ZodUnion = /*@__PURE__*/ $constructor("$ZodUnion", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "optin", () => def.options.some((o) => o._zod.optin === "optional") ? "optional" : void 0);
	defineLazy(inst._zod, "optout", () => def.options.some((o) => o._zod.optout === "optional") ? "optional" : void 0);
	defineLazy(inst._zod, "values", () => {
		if (def.options.every((o) => o._zod.values)) return new Set(def.options.flatMap((option) => Array.from(option._zod.values)));
	});
	defineLazy(inst._zod, "pattern", () => {
		if (def.options.every((o) => o._zod.pattern)) {
			const patterns = def.options.map((o) => o._zod.pattern);
			return new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join("|")})$`);
		}
	});
	const first = def.options.length === 1 ? def.options[0]._zod.run : null;
	inst._zod.parse = (payload, ctx) => {
		if (first) return first(payload, ctx);
		let async = false;
		const results = [];
		for (const option of def.options) {
			const result = option._zod.run({
				value: payload.value,
				issues: []
			}, ctx);
			if (result instanceof Promise) {
				results.push(result);
				async = true;
			} else {
				if (result.issues.length === 0) return result;
				results.push(result);
			}
		}
		if (!async) return handleUnionResults(results, payload, inst, ctx);
		return Promise.all(results).then((results) => {
			return handleUnionResults(results, payload, inst, ctx);
		});
	};
});
const $ZodDiscriminatedUnion = /*@__PURE__*/ $constructor("$ZodDiscriminatedUnion", (inst, def) => {
	def.inclusive = false;
	$ZodUnion.init(inst, def);
	const _super = inst._zod.parse;
	defineLazy(inst._zod, "propValues", () => {
		const propValues = {};
		for (const option of def.options) {
			const pv = option._zod.propValues;
			if (!pv || Object.keys(pv).length === 0) throw new Error(`Invalid discriminated union option at index "${def.options.indexOf(option)}"`);
			for (const [k, v] of Object.entries(pv)) {
				if (!propValues[k]) propValues[k] = /* @__PURE__ */ new Set();
				for (const val of v) propValues[k].add(val);
			}
		}
		return propValues;
	});
	const disc = cached(() => {
		const opts = def.options;
		const map = /* @__PURE__ */ new Map();
		for (const o of opts) {
			const values = o._zod.propValues?.[def.discriminator];
			if (!values || values.size === 0) throw new Error(`Invalid discriminated union option at index "${def.options.indexOf(o)}"`);
			for (const v of values) {
				if (map.has(v)) throw new Error(`Duplicate discriminator value "${String(v)}"`);
				map.set(v, o);
			}
		}
		return map;
	});
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		if (!isObject(input)) {
			payload.issues.push({
				code: "invalid_type",
				expected: "object",
				input,
				inst
			});
			return payload;
		}
		const opt = disc.value.get(input?.[def.discriminator]);
		if (opt) return opt._zod.run(payload, ctx);
		if (def.unionFallback || ctx.direction === "backward") return _super(payload, ctx);
		payload.issues.push({
			code: "invalid_union",
			errors: [],
			note: "No matching discriminator",
			discriminator: def.discriminator,
			options: Array.from(disc.value.keys()),
			input,
			path: [def.discriminator],
			inst
		});
		return payload;
	};
});
const $ZodIntersection = /*@__PURE__*/ $constructor("$ZodIntersection", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		const left = def.left._zod.run({
			value: input,
			issues: []
		}, ctx);
		const right = def.right._zod.run({
			value: input,
			issues: []
		}, ctx);
		if (left instanceof Promise || right instanceof Promise) return Promise.all([left, right]).then(([left, right]) => {
			return handleIntersectionResults(payload, left, right);
		});
		return handleIntersectionResults(payload, left, right);
	};
});
function mergeValues(a, b) {
	if (a === b) return {
		valid: true,
		data: a
	};
	if (a instanceof Date && b instanceof Date && +a === +b) return {
		valid: true,
		data: a
	};
	if (isPlainObject(a) && isPlainObject(b)) {
		const bKeys = Object.keys(b);
		const sharedKeys = Object.keys(a).filter((key) => bKeys.indexOf(key) !== -1);
		const newObj = {
			...a,
			...b
		};
		for (const key of sharedKeys) {
			const sharedValue = mergeValues(a[key], b[key]);
			if (!sharedValue.valid) return {
				valid: false,
				mergeErrorPath: [key, ...sharedValue.mergeErrorPath]
			};
			newObj[key] = sharedValue.data;
		}
		return {
			valid: true,
			data: newObj
		};
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return {
			valid: false,
			mergeErrorPath: []
		};
		const newArray = [];
		for (let index = 0; index < a.length; index++) {
			const itemA = a[index];
			const itemB = b[index];
			const sharedValue = mergeValues(itemA, itemB);
			if (!sharedValue.valid) return {
				valid: false,
				mergeErrorPath: [index, ...sharedValue.mergeErrorPath]
			};
			newArray.push(sharedValue.data);
		}
		return {
			valid: true,
			data: newArray
		};
	}
	return {
		valid: false,
		mergeErrorPath: []
	};
}
function handleIntersectionResults(result, left, right) {
	const unrecKeys = /* @__PURE__ */ new Map();
	let unrecIssue;
	for (const iss of left.issues) if (iss.code === "unrecognized_keys") {
		unrecIssue ?? (unrecIssue = iss);
		for (const k of iss.keys) {
			if (!unrecKeys.has(k)) unrecKeys.set(k, {});
			unrecKeys.get(k).l = true;
		}
	} else result.issues.push(iss);
	for (const iss of right.issues) if (iss.code === "unrecognized_keys") for (const k of iss.keys) {
		if (!unrecKeys.has(k)) unrecKeys.set(k, {});
		unrecKeys.get(k).r = true;
	}
	else result.issues.push(iss);
	const bothKeys = [...unrecKeys].filter(([, f]) => f.l && f.r).map(([k]) => k);
	if (bothKeys.length && unrecIssue) result.issues.push({
		...unrecIssue,
		keys: bothKeys
	});
	if (aborted(result)) return result;
	const merged = mergeValues(left.value, right.value);
	if (!merged.valid) throw new Error(`Unmergable intersection. Error path: ${JSON.stringify(merged.mergeErrorPath)}`);
	result.value = merged.data;
	return result;
}
const $ZodEnum = /*@__PURE__*/ $constructor("$ZodEnum", (inst, def) => {
	$ZodType.init(inst, def);
	const values = getEnumValues(def.entries);
	const valuesSet = new Set(values);
	inst._zod.values = valuesSet;
	inst._zod.pattern = new RegExp(`^(${values.filter((k) => propertyKeyTypes.has(typeof k)).map((o) => typeof o === "string" ? escapeRegex(o) : o.toString()).join("|")})$`);
	inst._zod.parse = (payload, _ctx) => {
		const input = payload.value;
		if (valuesSet.has(input)) return payload;
		payload.issues.push({
			code: "invalid_value",
			values,
			input,
			inst
		});
		return payload;
	};
});
const $ZodLiteral = /*@__PURE__*/ $constructor("$ZodLiteral", (inst, def) => {
	$ZodType.init(inst, def);
	if (def.values.length === 0) throw new Error("Cannot create literal schema with no valid values");
	const values = new Set(def.values);
	inst._zod.values = values;
	inst._zod.pattern = new RegExp(`^(${def.values.map((o) => typeof o === "string" ? escapeRegex(o) : o ? escapeRegex(o.toString()) : String(o)).join("|")})$`);
	inst._zod.parse = (payload, _ctx) => {
		const input = payload.value;
		if (values.has(input)) return payload;
		payload.issues.push({
			code: "invalid_value",
			values: def.values,
			input,
			inst
		});
		return payload;
	};
});
const $ZodTransform = /*@__PURE__*/ $constructor("$ZodTransform", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "optional";
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") throw new $ZodEncodeError(inst.constructor.name);
		const _out = def.transform(payload.value, payload);
		if (ctx.async) return (_out instanceof Promise ? _out : Promise.resolve(_out)).then((output) => {
			payload.value = output;
			payload.fallback = true;
			return payload;
		});
		if (_out instanceof Promise) throw new $ZodAsyncError();
		payload.value = _out;
		payload.fallback = true;
		return payload;
	};
});
function handleOptionalResult(result, input) {
	if (input === void 0 && (result.issues.length || result.fallback)) return {
		issues: [],
		value: void 0
	};
	return result;
}
const $ZodOptional = /*@__PURE__*/ $constructor("$ZodOptional", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "optional";
	inst._zod.optout = "optional";
	defineLazy(inst._zod, "values", () => {
		return def.innerType._zod.values ? /* @__PURE__ */ new Set([...def.innerType._zod.values, void 0]) : void 0;
	});
	defineLazy(inst._zod, "pattern", () => {
		const pattern = def.innerType._zod.pattern;
		return pattern ? new RegExp(`^(${cleanRegex(pattern.source)})?$`) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		if (def.innerType._zod.optin === "optional") {
			const input = payload.value;
			const result = def.innerType._zod.run(payload, ctx);
			if (result instanceof Promise) return result.then((r) => handleOptionalResult(r, input));
			return handleOptionalResult(result, input);
		}
		if (payload.value === void 0) return payload;
		return def.innerType._zod.run(payload, ctx);
	};
});
const $ZodExactOptional = /*@__PURE__*/ $constructor("$ZodExactOptional", (inst, def) => {
	$ZodOptional.init(inst, def);
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	defineLazy(inst._zod, "pattern", () => def.innerType._zod.pattern);
	inst._zod.parse = (payload, ctx) => {
		return def.innerType._zod.run(payload, ctx);
	};
});
const $ZodNullable = /*@__PURE__*/ $constructor("$ZodNullable", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
	defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
	defineLazy(inst._zod, "pattern", () => {
		const pattern = def.innerType._zod.pattern;
		return pattern ? new RegExp(`^(${cleanRegex(pattern.source)}|null)$`) : void 0;
	});
	defineLazy(inst._zod, "values", () => {
		return def.innerType._zod.values ? /* @__PURE__ */ new Set([...def.innerType._zod.values, null]) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		if (payload.value === null) return payload;
		return def.innerType._zod.run(payload, ctx);
	};
});
const $ZodDefault = /*@__PURE__*/ $constructor("$ZodDefault", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "optional";
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		if (payload.value === void 0) {
			payload.value = def.defaultValue;
			/**
			* $ZodDefault returns the default value immediately in forward direction.
			* It doesn't pass the default value into the validator ("prefault"). There's no reason to pass the default value through validation. The validity of the default is enforced by TypeScript statically. Otherwise, it's the responsibility of the user to ensure the default is valid. In the case of pipes with divergent in/out types, you can specify the default on the `in` schema of your ZodPipe to set a "prefault" for the pipe.   */
			return payload;
		}
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then((result) => handleDefaultResult(result, def));
		return handleDefaultResult(result, def);
	};
});
function handleDefaultResult(payload, def) {
	if (payload.value === void 0) payload.value = def.defaultValue;
	return payload;
}
const $ZodPrefault = /*@__PURE__*/ $constructor("$ZodPrefault", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "optional";
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		if (payload.value === void 0) payload.value = def.defaultValue;
		return def.innerType._zod.run(payload, ctx);
	};
});
const $ZodNonOptional = /*@__PURE__*/ $constructor("$ZodNonOptional", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "values", () => {
		const v = def.innerType._zod.values;
		return v ? new Set([...v].filter((x) => x !== void 0)) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then((result) => handleNonOptionalResult(result, inst));
		return handleNonOptionalResult(result, inst);
	};
});
function handleNonOptionalResult(payload, inst) {
	if (!payload.issues.length && payload.value === void 0) payload.issues.push({
		code: "invalid_type",
		expected: "nonoptional",
		input: payload.value,
		inst
	});
	return payload;
}
const $ZodCatch = /*@__PURE__*/ $constructor("$ZodCatch", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "optional";
	defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then((result) => {
			payload.value = result.value;
			if (result.issues.length) {
				payload.value = def.catchValue({
					...payload,
					error: { issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config())) },
					input: payload.value
				});
				payload.issues = [];
				payload.fallback = true;
			}
			return payload;
		});
		payload.value = result.value;
		if (result.issues.length) {
			payload.value = def.catchValue({
				...payload,
				error: { issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config())) },
				input: payload.value
			});
			payload.issues = [];
			payload.fallback = true;
		}
		return payload;
	};
});
const $ZodPipe = /*@__PURE__*/ $constructor("$ZodPipe", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "values", () => def.in._zod.values);
	defineLazy(inst._zod, "optin", () => def.in._zod.optin);
	defineLazy(inst._zod, "optout", () => def.out._zod.optout);
	defineLazy(inst._zod, "propValues", () => def.in._zod.propValues);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") {
			const right = def.out._zod.run(payload, ctx);
			if (right instanceof Promise) return right.then((right) => handlePipeResult(right, def.in, ctx));
			return handlePipeResult(right, def.in, ctx);
		}
		const left = def.in._zod.run(payload, ctx);
		if (left instanceof Promise) return left.then((left) => handlePipeResult(left, def.out, ctx));
		return handlePipeResult(left, def.out, ctx);
	};
});
function handlePipeResult(left, next, ctx) {
	if (left.issues.length) {
		left.aborted = true;
		return left;
	}
	return next._zod.run({
		value: left.value,
		issues: left.issues,
		fallback: left.fallback
	}, ctx);
}
const $ZodReadonly = /*@__PURE__*/ $constructor("$ZodReadonly", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "propValues", () => def.innerType._zod.propValues);
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	defineLazy(inst._zod, "optin", () => def.innerType?._zod?.optin);
	defineLazy(inst._zod, "optout", () => def.innerType?._zod?.optout);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then(handleReadonlyResult);
		return handleReadonlyResult(result);
	};
});
function handleReadonlyResult(payload) {
	payload.value = Object.freeze(payload.value);
	return payload;
}
const $ZodCustom = /*@__PURE__*/ $constructor("$ZodCustom", (inst, def) => {
	$ZodCheck.init(inst, def);
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, _) => {
		return payload;
	};
	inst._zod.check = (payload) => {
		const input = payload.value;
		const r = def.fn(input);
		if (r instanceof Promise) return r.then((r) => handleRefineResult(r, payload, input, inst));
		handleRefineResult(r, payload, input, inst);
	};
});
function handleRefineResult(result, payload, input, inst) {
	if (!result) {
		const _iss = {
			code: "custom",
			input,
			inst,
			path: [...inst._zod.def.path ?? []],
			continue: !inst._zod.def.abort
		};
		if (inst._zod.def.params) _iss.params = inst._zod.def.params;
		payload.issues.push(issue(_iss));
	}
}
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/registries.js
var _a;
var $ZodRegistry = class {
	constructor() {
		this._map = /* @__PURE__ */ new WeakMap();
		this._idmap = /* @__PURE__ */ new Map();
	}
	add(schema, ..._meta) {
		const meta = _meta[0];
		this._map.set(schema, meta);
		if (meta && typeof meta === "object" && "id" in meta) this._idmap.set(meta.id, schema);
		return this;
	}
	clear() {
		this._map = /* @__PURE__ */ new WeakMap();
		this._idmap = /* @__PURE__ */ new Map();
		return this;
	}
	remove(schema) {
		const meta = this._map.get(schema);
		if (meta && typeof meta === "object" && "id" in meta) this._idmap.delete(meta.id);
		this._map.delete(schema);
		return this;
	}
	get(schema) {
		const p = schema._zod.parent;
		if (p) {
			const pm = { ...this.get(p) ?? {} };
			delete pm.id;
			const f = {
				...pm,
				...this._map.get(schema)
			};
			return Object.keys(f).length ? f : void 0;
		}
		return this._map.get(schema);
	}
	has(schema) {
		return this._map.has(schema);
	}
};
function registry() {
	return new $ZodRegistry();
}
(_a = globalThis).__zod_globalRegistry ?? (_a.__zod_globalRegistry = registry());
const globalRegistry = globalThis.__zod_globalRegistry;
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/api.js
// @__NO_SIDE_EFFECTS__
function _string(Class, params) {
	return new Class({
		type: "string",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _email(Class, params) {
	return new Class({
		type: "string",
		format: "email",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _guid(Class, params) {
	return new Class({
		type: "string",
		format: "guid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuid(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuidv4(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		version: "v4",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuidv6(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		version: "v6",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuidv7(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		version: "v7",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _url(Class, params) {
	return new Class({
		type: "string",
		format: "url",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _emoji(Class, params) {
	return new Class({
		type: "string",
		format: "emoji",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _nanoid(Class, params) {
	return new Class({
		type: "string",
		format: "nanoid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link _cuid2} instead.
* See https://github.com/paralleldrive/cuid.
*/
// @__NO_SIDE_EFFECTS__
function _cuid(Class, params) {
	return new Class({
		type: "string",
		format: "cuid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _cuid2(Class, params) {
	return new Class({
		type: "string",
		format: "cuid2",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ulid(Class, params) {
	return new Class({
		type: "string",
		format: "ulid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _xid(Class, params) {
	return new Class({
		type: "string",
		format: "xid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ksuid(Class, params) {
	return new Class({
		type: "string",
		format: "ksuid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ipv4(Class, params) {
	return new Class({
		type: "string",
		format: "ipv4",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ipv6(Class, params) {
	return new Class({
		type: "string",
		format: "ipv6",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _cidrv4(Class, params) {
	return new Class({
		type: "string",
		format: "cidrv4",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _cidrv6(Class, params) {
	return new Class({
		type: "string",
		format: "cidrv6",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _base64(Class, params) {
	return new Class({
		type: "string",
		format: "base64",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _base64url(Class, params) {
	return new Class({
		type: "string",
		format: "base64url",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _e164(Class, params) {
	return new Class({
		type: "string",
		format: "e164",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _jwt(Class, params) {
	return new Class({
		type: "string",
		format: "jwt",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoDateTime(Class, params) {
	return new Class({
		type: "string",
		format: "datetime",
		check: "string_format",
		offset: false,
		local: false,
		precision: null,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoDate(Class, params) {
	return new Class({
		type: "string",
		format: "date",
		check: "string_format",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoTime(Class, params) {
	return new Class({
		type: "string",
		format: "time",
		check: "string_format",
		precision: null,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoDuration(Class, params) {
	return new Class({
		type: "string",
		format: "duration",
		check: "string_format",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _number(Class, params) {
	return new Class({
		type: "number",
		checks: [],
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _int(Class, params) {
	return new Class({
		type: "number",
		check: "number_format",
		abort: false,
		format: "safeint",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _boolean(Class, params) {
	return new Class({
		type: "boolean",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _unknown(Class) {
	return new Class({ type: "unknown" });
}
// @__NO_SIDE_EFFECTS__
function _never(Class, params) {
	return new Class({
		type: "never",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _lt(value, params) {
	return new $ZodCheckLessThan({
		check: "less_than",
		...normalizeParams(params),
		value,
		inclusive: false
	});
}
// @__NO_SIDE_EFFECTS__
function _lte(value, params) {
	return new $ZodCheckLessThan({
		check: "less_than",
		...normalizeParams(params),
		value,
		inclusive: true
	});
}
// @__NO_SIDE_EFFECTS__
function _gt(value, params) {
	return new $ZodCheckGreaterThan({
		check: "greater_than",
		...normalizeParams(params),
		value,
		inclusive: false
	});
}
// @__NO_SIDE_EFFECTS__
function _gte(value, params) {
	return new $ZodCheckGreaterThan({
		check: "greater_than",
		...normalizeParams(params),
		value,
		inclusive: true
	});
}
// @__NO_SIDE_EFFECTS__
function _multipleOf(value, params) {
	return new $ZodCheckMultipleOf({
		check: "multiple_of",
		...normalizeParams(params),
		value
	});
}
// @__NO_SIDE_EFFECTS__
function _maxLength(maximum, params) {
	return new $ZodCheckMaxLength({
		check: "max_length",
		...normalizeParams(params),
		maximum
	});
}
// @__NO_SIDE_EFFECTS__
function _minLength(minimum, params) {
	return new $ZodCheckMinLength({
		check: "min_length",
		...normalizeParams(params),
		minimum
	});
}
// @__NO_SIDE_EFFECTS__
function _length(length, params) {
	return new $ZodCheckLengthEquals({
		check: "length_equals",
		...normalizeParams(params),
		length
	});
}
// @__NO_SIDE_EFFECTS__
function _regex(pattern, params) {
	return new $ZodCheckRegex({
		check: "string_format",
		format: "regex",
		...normalizeParams(params),
		pattern
	});
}
// @__NO_SIDE_EFFECTS__
function _lowercase(params) {
	return new $ZodCheckLowerCase({
		check: "string_format",
		format: "lowercase",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uppercase(params) {
	return new $ZodCheckUpperCase({
		check: "string_format",
		format: "uppercase",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _includes(includes, params) {
	return new $ZodCheckIncludes({
		check: "string_format",
		format: "includes",
		...normalizeParams(params),
		includes
	});
}
// @__NO_SIDE_EFFECTS__
function _startsWith(prefix, params) {
	return new $ZodCheckStartsWith({
		check: "string_format",
		format: "starts_with",
		...normalizeParams(params),
		prefix
	});
}
// @__NO_SIDE_EFFECTS__
function _endsWith(suffix, params) {
	return new $ZodCheckEndsWith({
		check: "string_format",
		format: "ends_with",
		...normalizeParams(params),
		suffix
	});
}
// @__NO_SIDE_EFFECTS__
function _overwrite(tx) {
	return new $ZodCheckOverwrite({
		check: "overwrite",
		tx
	});
}
// @__NO_SIDE_EFFECTS__
function _normalize(form) {
	return /* @__PURE__ */ _overwrite((input) => input.normalize(form));
}
// @__NO_SIDE_EFFECTS__
function _trim() {
	return /* @__PURE__ */ _overwrite((input) => input.trim());
}
// @__NO_SIDE_EFFECTS__
function _toLowerCase() {
	return /* @__PURE__ */ _overwrite((input) => input.toLowerCase());
}
// @__NO_SIDE_EFFECTS__
function _toUpperCase() {
	return /* @__PURE__ */ _overwrite((input) => input.toUpperCase());
}
// @__NO_SIDE_EFFECTS__
function _slugify() {
	return /* @__PURE__ */ _overwrite((input) => slugify(input));
}
// @__NO_SIDE_EFFECTS__
function _array(Class, element, params) {
	return new Class({
		type: "array",
		element,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _refine(Class, fn, _params) {
	return new Class({
		type: "custom",
		check: "custom",
		fn,
		...normalizeParams(_params)
	});
}
// @__NO_SIDE_EFFECTS__
function _superRefine(fn, params) {
	const ch = /* @__PURE__ */ _check((payload) => {
		payload.addIssue = (issue$2) => {
			if (typeof issue$2 === "string") payload.issues.push(issue(issue$2, payload.value, ch._zod.def));
			else {
				const _issue = issue$2;
				if (_issue.fatal) _issue.continue = false;
				_issue.code ?? (_issue.code = "custom");
				_issue.input ?? (_issue.input = payload.value);
				_issue.inst ?? (_issue.inst = ch);
				_issue.continue ?? (_issue.continue = !ch._zod.def.abort);
				payload.issues.push(issue(_issue));
			}
		};
		return fn(payload.value, payload);
	}, params);
	return ch;
}
// @__NO_SIDE_EFFECTS__
function _check(fn, params) {
	const ch = new $ZodCheck({
		check: "custom",
		...normalizeParams(params)
	});
	ch._zod.check = fn;
	return ch;
}
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/to-json-schema.js
function initializeContext(params) {
	let target = params?.target ?? "draft-2020-12";
	if (target === "draft-4") target = "draft-04";
	if (target === "draft-7") target = "draft-07";
	return {
		processors: params.processors ?? {},
		metadataRegistry: params?.metadata ?? globalRegistry,
		target,
		unrepresentable: params?.unrepresentable ?? "throw",
		override: params?.override ?? (() => {}),
		io: params?.io ?? "output",
		counter: 0,
		seen: /* @__PURE__ */ new Map(),
		cycles: params?.cycles ?? "ref",
		reused: params?.reused ?? "inline",
		external: params?.external ?? void 0
	};
}
function process$1(schema, ctx, _params = {
	path: [],
	schemaPath: []
}) {
	var _a;
	const def = schema._zod.def;
	const seen = ctx.seen.get(schema);
	if (seen) {
		seen.count++;
		if (_params.schemaPath.includes(schema)) seen.cycle = _params.path;
		return seen.schema;
	}
	const result = {
		schema: {},
		count: 1,
		cycle: void 0,
		path: _params.path
	};
	ctx.seen.set(schema, result);
	const overrideSchema = schema._zod.toJSONSchema?.();
	if (overrideSchema) result.schema = overrideSchema;
	else {
		const params = {
			..._params,
			schemaPath: [..._params.schemaPath, schema],
			path: _params.path
		};
		if (schema._zod.processJSONSchema) schema._zod.processJSONSchema(ctx, result.schema, params);
		else {
			const _json = result.schema;
			const processor = ctx.processors[def.type];
			if (!processor) throw new Error(`[toJSONSchema]: Non-representable type encountered: ${def.type}`);
			processor(schema, ctx, _json, params);
		}
		const parent = schema._zod.parent;
		if (parent) {
			if (!result.ref) result.ref = parent;
			process$1(parent, ctx, params);
			ctx.seen.get(parent).isParent = true;
		}
	}
	const meta = ctx.metadataRegistry.get(schema);
	if (meta) Object.assign(result.schema, meta);
	if (ctx.io === "input" && isTransforming(schema)) {
		delete result.schema.examples;
		delete result.schema.default;
	}
	if (ctx.io === "input" && "_prefault" in result.schema) (_a = result.schema).default ?? (_a.default = result.schema._prefault);
	delete result.schema._prefault;
	return ctx.seen.get(schema).schema;
}
function extractDefs(ctx, schema) {
	const root = ctx.seen.get(schema);
	if (!root) throw new Error("Unprocessed schema. This is a bug in Zod.");
	const idToSchema = /* @__PURE__ */ new Map();
	for (const entry of ctx.seen.entries()) {
		const id = ctx.metadataRegistry.get(entry[0])?.id;
		if (id) {
			const existing = idToSchema.get(id);
			if (existing && existing !== entry[0]) throw new Error(`Duplicate schema id "${id}" detected during JSON Schema conversion. Two different schemas cannot share the same id when converted together.`);
			idToSchema.set(id, entry[0]);
		}
	}
	const makeURI = (entry) => {
		const defsSegment = ctx.target === "draft-2020-12" ? "$defs" : "definitions";
		if (ctx.external) {
			const externalId = ctx.external.registry.get(entry[0])?.id;
			const uriGenerator = ctx.external.uri ?? ((id) => id);
			if (externalId) return { ref: uriGenerator(externalId) };
			const id = entry[1].defId ?? entry[1].schema.id ?? `schema${ctx.counter++}`;
			entry[1].defId = id;
			return {
				defId: id,
				ref: `${uriGenerator("__shared")}#/${defsSegment}/${id}`
			};
		}
		if (entry[1] === root) return { ref: "#" };
		const defUriPrefix = `#/${defsSegment}/`;
		const defId = entry[1].schema.id ?? `__schema${ctx.counter++}`;
		return {
			defId,
			ref: defUriPrefix + defId
		};
	};
	const extractToDef = (entry) => {
		if (entry[1].schema.$ref) return;
		const seen = entry[1];
		const { ref, defId } = makeURI(entry);
		seen.def = { ...seen.schema };
		if (defId) seen.defId = defId;
		const schema = seen.schema;
		for (const key in schema) delete schema[key];
		schema.$ref = ref;
	};
	if (ctx.cycles === "throw") for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (seen.cycle) throw new Error(`Cycle detected: #/${seen.cycle?.join("/")}/<root>

Set the \`cycles\` parameter to \`"ref"\` to resolve cyclical schemas with defs.`);
	}
	for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (schema === entry[0]) {
			extractToDef(entry);
			continue;
		}
		if (ctx.external) {
			const ext = ctx.external.registry.get(entry[0])?.id;
			if (schema !== entry[0] && ext) {
				extractToDef(entry);
				continue;
			}
		}
		if (ctx.metadataRegistry.get(entry[0])?.id) {
			extractToDef(entry);
			continue;
		}
		if (seen.cycle) {
			extractToDef(entry);
			continue;
		}
		if (seen.count > 1) {
			if (ctx.reused === "ref") {
				extractToDef(entry);
				continue;
			}
		}
	}
}
function finalize(ctx, schema) {
	const root = ctx.seen.get(schema);
	if (!root) throw new Error("Unprocessed schema. This is a bug in Zod.");
	const flattenRef = (zodSchema) => {
		const seen = ctx.seen.get(zodSchema);
		if (seen.ref === null) return;
		const schema = seen.def ?? seen.schema;
		const _cached = { ...schema };
		const ref = seen.ref;
		seen.ref = null;
		if (ref) {
			flattenRef(ref);
			const refSeen = ctx.seen.get(ref);
			const refSchema = refSeen.schema;
			if (refSchema.$ref && (ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0")) {
				schema.allOf = schema.allOf ?? [];
				schema.allOf.push(refSchema);
			} else Object.assign(schema, refSchema);
			Object.assign(schema, _cached);
			if (zodSchema._zod.parent === ref) for (const key in schema) {
				if (key === "$ref" || key === "allOf") continue;
				if (!(key in _cached)) delete schema[key];
			}
			if (refSchema.$ref && refSeen.def) for (const key in schema) {
				if (key === "$ref" || key === "allOf") continue;
				if (key in refSeen.def && JSON.stringify(schema[key]) === JSON.stringify(refSeen.def[key])) delete schema[key];
			}
		}
		const parent = zodSchema._zod.parent;
		if (parent && parent !== ref) {
			flattenRef(parent);
			const parentSeen = ctx.seen.get(parent);
			if (parentSeen?.schema.$ref) {
				schema.$ref = parentSeen.schema.$ref;
				if (parentSeen.def) for (const key in schema) {
					if (key === "$ref" || key === "allOf") continue;
					if (key in parentSeen.def && JSON.stringify(schema[key]) === JSON.stringify(parentSeen.def[key])) delete schema[key];
				}
			}
		}
		ctx.override({
			zodSchema,
			jsonSchema: schema,
			path: seen.path ?? []
		});
	};
	for (const entry of [...ctx.seen.entries()].reverse()) flattenRef(entry[0]);
	const result = {};
	if (ctx.target === "draft-2020-12") result.$schema = "https://json-schema.org/draft/2020-12/schema";
	else if (ctx.target === "draft-07") result.$schema = "http://json-schema.org/draft-07/schema#";
	else if (ctx.target === "draft-04") result.$schema = "http://json-schema.org/draft-04/schema#";
	else if (ctx.target === "openapi-3.0") {}
	if (ctx.external?.uri) {
		const id = ctx.external.registry.get(schema)?.id;
		if (!id) throw new Error("Schema is missing an `id` property");
		result.$id = ctx.external.uri(id);
	}
	Object.assign(result, root.def ?? root.schema);
	const rootMetaId = ctx.metadataRegistry.get(schema)?.id;
	if (rootMetaId !== void 0 && result.id === rootMetaId) delete result.id;
	const defs = ctx.external?.defs ?? {};
	for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (seen.def && seen.defId) {
			if (seen.def.id === seen.defId) delete seen.def.id;
			defs[seen.defId] = seen.def;
		}
	}
	if (ctx.external) {} else if (Object.keys(defs).length > 0) {
		if (ctx.target === "draft-2020-12") result.$defs = defs;
		else result.definitions = defs;
	}
	try {
		const finalized = JSON.parse(JSON.stringify(result));
		Object.defineProperty(finalized, "~standard", {
			value: {
				...schema["~standard"],
				jsonSchema: {
					input: createStandardJSONSchemaMethod(schema, "input", ctx.processors),
					output: createStandardJSONSchemaMethod(schema, "output", ctx.processors)
				}
			},
			enumerable: false,
			writable: false
		});
		return finalized;
	} catch (_err) {
		throw new Error("Error converting schema to JSON.");
	}
}
function isTransforming(_schema, _ctx) {
	const ctx = _ctx ?? { seen: /* @__PURE__ */ new Set() };
	if (ctx.seen.has(_schema)) return false;
	ctx.seen.add(_schema);
	const def = _schema._zod.def;
	if (def.type === "transform") return true;
	if (def.type === "array") return isTransforming(def.element, ctx);
	if (def.type === "set") return isTransforming(def.valueType, ctx);
	if (def.type === "lazy") return isTransforming(def.getter(), ctx);
	if (def.type === "promise" || def.type === "optional" || def.type === "nonoptional" || def.type === "nullable" || def.type === "readonly" || def.type === "default" || def.type === "prefault") return isTransforming(def.innerType, ctx);
	if (def.type === "intersection") return isTransforming(def.left, ctx) || isTransforming(def.right, ctx);
	if (def.type === "record" || def.type === "map") return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
	if (def.type === "pipe") {
		if (_schema._zod.traits.has("$ZodCodec")) return true;
		return isTransforming(def.in, ctx) || isTransforming(def.out, ctx);
	}
	if (def.type === "object") {
		for (const key in def.shape) if (isTransforming(def.shape[key], ctx)) return true;
		return false;
	}
	if (def.type === "union") {
		for (const option of def.options) if (isTransforming(option, ctx)) return true;
		return false;
	}
	if (def.type === "tuple") {
		for (const item of def.items) if (isTransforming(item, ctx)) return true;
		if (def.rest && isTransforming(def.rest, ctx)) return true;
		return false;
	}
	return false;
}
/**
* Creates a toJSONSchema method for a schema instance.
* This encapsulates the logic of initializing context, processing, extracting defs, and finalizing.
*/
const createToJSONSchemaMethod = (schema, processors = {}) => (params) => {
	const ctx = initializeContext({
		...params,
		processors
	});
	process$1(schema, ctx);
	extractDefs(ctx, schema);
	return finalize(ctx, schema);
};
const createStandardJSONSchemaMethod = (schema, io, processors = {}) => (params) => {
	const { libraryOptions, target } = params ?? {};
	const ctx = initializeContext({
		...libraryOptions ?? {},
		target,
		io,
		processors
	});
	process$1(schema, ctx);
	extractDefs(ctx, schema);
	return finalize(ctx, schema);
};
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/json-schema-processors.js
const formatMap = {
	guid: "uuid",
	url: "uri",
	datetime: "date-time",
	json_string: "json-string",
	regex: ""
};
const stringProcessor = (schema, ctx, _json, _params) => {
	const json = _json;
	json.type = "string";
	const { minimum, maximum, format, patterns, contentEncoding } = schema._zod.bag;
	if (typeof minimum === "number") json.minLength = minimum;
	if (typeof maximum === "number") json.maxLength = maximum;
	if (format) {
		json.format = formatMap[format] ?? format;
		if (json.format === "") delete json.format;
		if (format === "time") delete json.format;
	}
	if (contentEncoding) json.contentEncoding = contentEncoding;
	if (patterns && patterns.size > 0) {
		const regexes = [...patterns];
		if (regexes.length === 1) json.pattern = regexes[0].source;
		else if (regexes.length > 1) json.allOf = [...regexes.map((regex) => ({
			...ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0" ? { type: "string" } : {},
			pattern: regex.source
		}))];
	}
};
const numberProcessor = (schema, ctx, _json, _params) => {
	const json = _json;
	const { minimum, maximum, format, multipleOf, exclusiveMaximum, exclusiveMinimum } = schema._zod.bag;
	if (typeof format === "string" && format.includes("int")) json.type = "integer";
	else json.type = "number";
	const exMin = typeof exclusiveMinimum === "number" && exclusiveMinimum >= (minimum ?? Number.NEGATIVE_INFINITY);
	const exMax = typeof exclusiveMaximum === "number" && exclusiveMaximum <= (maximum ?? Number.POSITIVE_INFINITY);
	const legacy = ctx.target === "draft-04" || ctx.target === "openapi-3.0";
	if (exMin) {
		if (legacy) {
			json.minimum = exclusiveMinimum;
			json.exclusiveMinimum = true;
		} else json.exclusiveMinimum = exclusiveMinimum;
	} else if (typeof minimum === "number") json.minimum = minimum;
	if (exMax) {
		if (legacy) {
			json.maximum = exclusiveMaximum;
			json.exclusiveMaximum = true;
		} else json.exclusiveMaximum = exclusiveMaximum;
	} else if (typeof maximum === "number") json.maximum = maximum;
	if (typeof multipleOf === "number") json.multipleOf = multipleOf;
};
const booleanProcessor = (_schema, _ctx, json, _params) => {
	json.type = "boolean";
};
const neverProcessor = (_schema, _ctx, json, _params) => {
	json.not = {};
};
const enumProcessor = (schema, _ctx, json, _params) => {
	const def = schema._zod.def;
	const values = getEnumValues(def.entries);
	if (values.every((v) => typeof v === "number")) json.type = "number";
	if (values.every((v) => typeof v === "string")) json.type = "string";
	json.enum = values;
};
const literalProcessor = (schema, ctx, json, _params) => {
	const def = schema._zod.def;
	const vals = [];
	for (const val of def.values) if (val === void 0) {
		if (ctx.unrepresentable === "throw") throw new Error("Literal `undefined` cannot be represented in JSON Schema");
	} else if (typeof val === "bigint") {
		if (ctx.unrepresentable === "throw") throw new Error("BigInt literals cannot be represented in JSON Schema");
		else vals.push(Number(val));
	} else vals.push(val);
	if (vals.length === 0) {} else if (vals.length === 1) {
		const val = vals[0];
		json.type = val === null ? "null" : typeof val;
		if (ctx.target === "draft-04" || ctx.target === "openapi-3.0") json.enum = [val];
		else json.const = val;
	} else {
		if (vals.every((v) => typeof v === "number")) json.type = "number";
		if (vals.every((v) => typeof v === "string")) json.type = "string";
		if (vals.every((v) => typeof v === "boolean")) json.type = "boolean";
		if (vals.every((v) => v === null)) json.type = "null";
		json.enum = vals;
	}
};
const customProcessor = (_schema, ctx, _json, _params) => {
	if (ctx.unrepresentable === "throw") throw new Error("Custom types cannot be represented in JSON Schema");
};
const transformProcessor = (_schema, ctx, _json, _params) => {
	if (ctx.unrepresentable === "throw") throw new Error("Transforms cannot be represented in JSON Schema");
};
const arrayProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const def = schema._zod.def;
	const { minimum, maximum } = schema._zod.bag;
	if (typeof minimum === "number") json.minItems = minimum;
	if (typeof maximum === "number") json.maxItems = maximum;
	json.type = "array";
	json.items = process$1(def.element, ctx, {
		...params,
		path: [...params.path, "items"]
	});
};
const objectProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const def = schema._zod.def;
	json.type = "object";
	json.properties = {};
	const shape = def.shape;
	for (const key in shape) json.properties[key] = process$1(shape[key], ctx, {
		...params,
		path: [
			...params.path,
			"properties",
			key
		]
	});
	const allKeys = new Set(Object.keys(shape));
	const requiredKeys = new Set([...allKeys].filter((key) => {
		const v = def.shape[key]._zod;
		if (ctx.io === "input") return v.optin === void 0;
		else return v.optout === void 0;
	}));
	if (requiredKeys.size > 0) json.required = Array.from(requiredKeys);
	if (def.catchall?._zod.def.type === "never") json.additionalProperties = false;
	else if (!def.catchall) {
		if (ctx.io === "output") json.additionalProperties = false;
	} else if (def.catchall) json.additionalProperties = process$1(def.catchall, ctx, {
		...params,
		path: [...params.path, "additionalProperties"]
	});
};
const unionProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	const isExclusive = def.inclusive === false;
	const options = def.options.map((x, i) => process$1(x, ctx, {
		...params,
		path: [
			...params.path,
			isExclusive ? "oneOf" : "anyOf",
			i
		]
	}));
	if (isExclusive) json.oneOf = options;
	else json.anyOf = options;
};
const intersectionProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	const a = process$1(def.left, ctx, {
		...params,
		path: [
			...params.path,
			"allOf",
			0
		]
	});
	const b = process$1(def.right, ctx, {
		...params,
		path: [
			...params.path,
			"allOf",
			1
		]
	});
	const isSimpleIntersection = (val) => "allOf" in val && Object.keys(val).length === 1;
	json.allOf = [...isSimpleIntersection(a) ? a.allOf : [a], ...isSimpleIntersection(b) ? b.allOf : [b]];
};
const nullableProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	const inner = process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	if (ctx.target === "openapi-3.0") {
		seen.ref = def.innerType;
		json.nullable = true;
	} else json.anyOf = [inner, { type: "null" }];
};
const nonoptionalProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
};
const defaultProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	json.default = JSON.parse(JSON.stringify(def.defaultValue));
};
const prefaultProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	if (ctx.io === "input") json._prefault = JSON.parse(JSON.stringify(def.defaultValue));
};
const catchProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	let catchValue;
	try {
		catchValue = def.catchValue(void 0);
	} catch {
		throw new Error("Dynamic catch values are not supported in JSON Schema");
	}
	json.default = catchValue;
};
const pipeProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	const inIsTransform = def.in._zod.traits.has("$ZodTransform");
	const innerType = ctx.io === "input" ? inIsTransform ? def.out : def.in : def.out;
	process$1(innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = innerType;
};
const readonlyProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	json.readOnly = true;
};
const optionalProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
};
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/classic/iso.js
const ZodISODateTime = /*@__PURE__*/ $constructor("ZodISODateTime", (inst, def) => {
	$ZodISODateTime.init(inst, def);
	ZodStringFormat.init(inst, def);
});
function datetime(params) {
	return /* @__PURE__ */ _isoDateTime(ZodISODateTime, params);
}
const ZodISODate = /*@__PURE__*/ $constructor("ZodISODate", (inst, def) => {
	$ZodISODate.init(inst, def);
	ZodStringFormat.init(inst, def);
});
function date(params) {
	return /* @__PURE__ */ _isoDate(ZodISODate, params);
}
const ZodISOTime = /*@__PURE__*/ $constructor("ZodISOTime", (inst, def) => {
	$ZodISOTime.init(inst, def);
	ZodStringFormat.init(inst, def);
});
function time(params) {
	return /* @__PURE__ */ _isoTime(ZodISOTime, params);
}
const ZodISODuration = /*@__PURE__*/ $constructor("ZodISODuration", (inst, def) => {
	$ZodISODuration.init(inst, def);
	ZodStringFormat.init(inst, def);
});
function duration(params) {
	return /* @__PURE__ */ _isoDuration(ZodISODuration, params);
}
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/classic/errors.js
const initializer = (inst, issues) => {
	$ZodError.init(inst, issues);
	inst.name = "ZodError";
	Object.defineProperties(inst, {
		format: { value: (mapper) => formatError(inst, mapper) },
		flatten: { value: (mapper) => flattenError(inst, mapper) },
		addIssue: { value: (issue) => {
			inst.issues.push(issue);
			inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
		} },
		addIssues: { value: (issues) => {
			inst.issues.push(...issues);
			inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
		} },
		isEmpty: { get() {
			return inst.issues.length === 0;
		} }
	});
};
const ZodRealError = /*@__PURE__*/ $constructor("ZodError", initializer, { Parent: Error });
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/classic/parse.js
const parse = /* @__PURE__ */ _parse(ZodRealError);
const parseAsync = /* @__PURE__ */ _parseAsync(ZodRealError);
const safeParse = /* @__PURE__ */ _safeParse(ZodRealError);
const safeParseAsync = /* @__PURE__ */ _safeParseAsync(ZodRealError);
const encode = /* @__PURE__ */ _encode(ZodRealError);
const decode = /* @__PURE__ */ _decode(ZodRealError);
const encodeAsync = /* @__PURE__ */ _encodeAsync(ZodRealError);
const decodeAsync = /* @__PURE__ */ _decodeAsync(ZodRealError);
const safeEncode = /* @__PURE__ */ _safeEncode(ZodRealError);
const safeDecode = /* @__PURE__ */ _safeDecode(ZodRealError);
const safeEncodeAsync = /* @__PURE__ */ _safeEncodeAsync(ZodRealError);
const safeDecodeAsync = /* @__PURE__ */ _safeDecodeAsync(ZodRealError);
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/classic/schemas.js
const _installedGroups = /* @__PURE__ */ new WeakMap();
function _installLazyMethods(inst, group, methods) {
	const proto = Object.getPrototypeOf(inst);
	let installed = _installedGroups.get(proto);
	if (!installed) {
		installed = /* @__PURE__ */ new Set();
		_installedGroups.set(proto, installed);
	}
	if (installed.has(group)) return;
	installed.add(group);
	for (const key in methods) {
		const fn = methods[key];
		Object.defineProperty(proto, key, {
			configurable: true,
			enumerable: false,
			get() {
				const bound = fn.bind(this);
				Object.defineProperty(this, key, {
					configurable: true,
					writable: true,
					enumerable: true,
					value: bound
				});
				return bound;
			},
			set(v) {
				Object.defineProperty(this, key, {
					configurable: true,
					writable: true,
					enumerable: true,
					value: v
				});
			}
		});
	}
}
const ZodType = /*@__PURE__*/ $constructor("ZodType", (inst, def) => {
	$ZodType.init(inst, def);
	Object.assign(inst["~standard"], { jsonSchema: {
		input: createStandardJSONSchemaMethod(inst, "input"),
		output: createStandardJSONSchemaMethod(inst, "output")
	} });
	inst.toJSONSchema = createToJSONSchemaMethod(inst, {});
	inst.def = def;
	inst.type = def.type;
	Object.defineProperty(inst, "_def", { value: def });
	inst.parse = (data, params) => parse(inst, data, params, { callee: inst.parse });
	inst.safeParse = (data, params) => safeParse(inst, data, params);
	inst.parseAsync = async (data, params) => parseAsync(inst, data, params, { callee: inst.parseAsync });
	inst.safeParseAsync = async (data, params) => safeParseAsync(inst, data, params);
	inst.spa = inst.safeParseAsync;
	inst.encode = (data, params) => encode(inst, data, params);
	inst.decode = (data, params) => decode(inst, data, params);
	inst.encodeAsync = async (data, params) => encodeAsync(inst, data, params);
	inst.decodeAsync = async (data, params) => decodeAsync(inst, data, params);
	inst.safeEncode = (data, params) => safeEncode(inst, data, params);
	inst.safeDecode = (data, params) => safeDecode(inst, data, params);
	inst.safeEncodeAsync = async (data, params) => safeEncodeAsync(inst, data, params);
	inst.safeDecodeAsync = async (data, params) => safeDecodeAsync(inst, data, params);
	_installLazyMethods(inst, "ZodType", {
		check(...chks) {
			const def = this.def;
			return this.clone(mergeDefs(def, { checks: [...def.checks ?? [], ...chks.map((ch) => typeof ch === "function" ? { _zod: {
				check: ch,
				def: { check: "custom" },
				onattach: []
			} } : ch)] }), { parent: true });
		},
		with(...chks) {
			return this.check(...chks);
		},
		clone(def, params) {
			return clone(this, def, params);
		},
		brand() {
			return this;
		},
		register(reg, meta) {
			reg.add(this, meta);
			return this;
		},
		refine(check, params) {
			return this.check(refine(check, params));
		},
		superRefine(refinement, params) {
			return this.check(superRefine(refinement, params));
		},
		overwrite(fn) {
			return this.check(/* @__PURE__ */ _overwrite(fn));
		},
		optional() {
			return optional(this);
		},
		exactOptional() {
			return exactOptional(this);
		},
		nullable() {
			return nullable(this);
		},
		nullish() {
			return optional(nullable(this));
		},
		nonoptional(params) {
			return nonoptional(this, params);
		},
		array() {
			return array(this);
		},
		or(arg) {
			return union([this, arg]);
		},
		and(arg) {
			return intersection(this, arg);
		},
		transform(tx) {
			return pipe(this, transform(tx));
		},
		default(d) {
			return _default(this, d);
		},
		prefault(d) {
			return prefault(this, d);
		},
		catch(params) {
			return _catch(this, params);
		},
		pipe(target) {
			return pipe(this, target);
		},
		readonly() {
			return readonly(this);
		},
		describe(description) {
			const cl = this.clone();
			globalRegistry.add(cl, { description });
			return cl;
		},
		meta(...args) {
			if (args.length === 0) return globalRegistry.get(this);
			const cl = this.clone();
			globalRegistry.add(cl, args[0]);
			return cl;
		},
		isOptional() {
			return this.safeParse(void 0).success;
		},
		isNullable() {
			return this.safeParse(null).success;
		},
		apply(fn) {
			return fn(this);
		}
	});
	Object.defineProperty(inst, "description", {
		get() {
			return globalRegistry.get(inst)?.description;
		},
		configurable: true
	});
	return inst;
});
/** @internal */
const _ZodString = /*@__PURE__*/ $constructor("_ZodString", (inst, def) => {
	$ZodString.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => stringProcessor(inst, ctx, json, params);
	const bag = inst._zod.bag;
	inst.format = bag.format ?? null;
	inst.minLength = bag.minimum ?? null;
	inst.maxLength = bag.maximum ?? null;
	_installLazyMethods(inst, "_ZodString", {
		regex(...args) {
			return this.check(/* @__PURE__ */ _regex(...args));
		},
		includes(...args) {
			return this.check(/* @__PURE__ */ _includes(...args));
		},
		startsWith(...args) {
			return this.check(/* @__PURE__ */ _startsWith(...args));
		},
		endsWith(...args) {
			return this.check(/* @__PURE__ */ _endsWith(...args));
		},
		min(...args) {
			return this.check(/* @__PURE__ */ _minLength(...args));
		},
		max(...args) {
			return this.check(/* @__PURE__ */ _maxLength(...args));
		},
		length(...args) {
			return this.check(/* @__PURE__ */ _length(...args));
		},
		nonempty(...args) {
			return this.check(/* @__PURE__ */ _minLength(1, ...args));
		},
		lowercase(params) {
			return this.check(/* @__PURE__ */ _lowercase(params));
		},
		uppercase(params) {
			return this.check(/* @__PURE__ */ _uppercase(params));
		},
		trim() {
			return this.check(/* @__PURE__ */ _trim());
		},
		normalize(...args) {
			return this.check(/* @__PURE__ */ _normalize(...args));
		},
		toLowerCase() {
			return this.check(/* @__PURE__ */ _toLowerCase());
		},
		toUpperCase() {
			return this.check(/* @__PURE__ */ _toUpperCase());
		},
		slugify() {
			return this.check(/* @__PURE__ */ _slugify());
		}
	});
});
const ZodString = /*@__PURE__*/ $constructor("ZodString", (inst, def) => {
	$ZodString.init(inst, def);
	_ZodString.init(inst, def);
	inst.email = (params) => inst.check(/* @__PURE__ */ _email(ZodEmail, params));
	inst.url = (params) => inst.check(/* @__PURE__ */ _url(ZodURL, params));
	inst.jwt = (params) => inst.check(/* @__PURE__ */ _jwt(ZodJWT, params));
	inst.emoji = (params) => inst.check(/* @__PURE__ */ _emoji(ZodEmoji, params));
	inst.guid = (params) => inst.check(/* @__PURE__ */ _guid(ZodGUID, params));
	inst.uuid = (params) => inst.check(/* @__PURE__ */ _uuid(ZodUUID, params));
	inst.uuidv4 = (params) => inst.check(/* @__PURE__ */ _uuidv4(ZodUUID, params));
	inst.uuidv6 = (params) => inst.check(/* @__PURE__ */ _uuidv6(ZodUUID, params));
	inst.uuidv7 = (params) => inst.check(/* @__PURE__ */ _uuidv7(ZodUUID, params));
	inst.nanoid = (params) => inst.check(/* @__PURE__ */ _nanoid(ZodNanoID, params));
	inst.guid = (params) => inst.check(/* @__PURE__ */ _guid(ZodGUID, params));
	inst.cuid = (params) => inst.check(/* @__PURE__ */ _cuid(ZodCUID, params));
	inst.cuid2 = (params) => inst.check(/* @__PURE__ */ _cuid2(ZodCUID2, params));
	inst.ulid = (params) => inst.check(/* @__PURE__ */ _ulid(ZodULID, params));
	inst.base64 = (params) => inst.check(/* @__PURE__ */ _base64(ZodBase64, params));
	inst.base64url = (params) => inst.check(/* @__PURE__ */ _base64url(ZodBase64URL, params));
	inst.xid = (params) => inst.check(/* @__PURE__ */ _xid(ZodXID, params));
	inst.ksuid = (params) => inst.check(/* @__PURE__ */ _ksuid(ZodKSUID, params));
	inst.ipv4 = (params) => inst.check(/* @__PURE__ */ _ipv4(ZodIPv4, params));
	inst.ipv6 = (params) => inst.check(/* @__PURE__ */ _ipv6(ZodIPv6, params));
	inst.cidrv4 = (params) => inst.check(/* @__PURE__ */ _cidrv4(ZodCIDRv4, params));
	inst.cidrv6 = (params) => inst.check(/* @__PURE__ */ _cidrv6(ZodCIDRv6, params));
	inst.e164 = (params) => inst.check(/* @__PURE__ */ _e164(ZodE164, params));
	inst.datetime = (params) => inst.check(datetime(params));
	inst.date = (params) => inst.check(date(params));
	inst.time = (params) => inst.check(time(params));
	inst.duration = (params) => inst.check(duration(params));
});
function string(params) {
	return /* @__PURE__ */ _string(ZodString, params);
}
const ZodStringFormat = /*@__PURE__*/ $constructor("ZodStringFormat", (inst, def) => {
	$ZodStringFormat.init(inst, def);
	_ZodString.init(inst, def);
});
const ZodEmail = /*@__PURE__*/ $constructor("ZodEmail", (inst, def) => {
	$ZodEmail.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodGUID = /*@__PURE__*/ $constructor("ZodGUID", (inst, def) => {
	$ZodGUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodUUID = /*@__PURE__*/ $constructor("ZodUUID", (inst, def) => {
	$ZodUUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodURL = /*@__PURE__*/ $constructor("ZodURL", (inst, def) => {
	$ZodURL.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodEmoji = /*@__PURE__*/ $constructor("ZodEmoji", (inst, def) => {
	$ZodEmoji.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodNanoID = /*@__PURE__*/ $constructor("ZodNanoID", (inst, def) => {
	$ZodNanoID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link ZodCUID2} instead.
* See https://github.com/paralleldrive/cuid.
*/
const ZodCUID = /*@__PURE__*/ $constructor("ZodCUID", (inst, def) => {
	$ZodCUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodCUID2 = /*@__PURE__*/ $constructor("ZodCUID2", (inst, def) => {
	$ZodCUID2.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodULID = /*@__PURE__*/ $constructor("ZodULID", (inst, def) => {
	$ZodULID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodXID = /*@__PURE__*/ $constructor("ZodXID", (inst, def) => {
	$ZodXID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodKSUID = /*@__PURE__*/ $constructor("ZodKSUID", (inst, def) => {
	$ZodKSUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodIPv4 = /*@__PURE__*/ $constructor("ZodIPv4", (inst, def) => {
	$ZodIPv4.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodIPv6 = /*@__PURE__*/ $constructor("ZodIPv6", (inst, def) => {
	$ZodIPv6.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodCIDRv4 = /*@__PURE__*/ $constructor("ZodCIDRv4", (inst, def) => {
	$ZodCIDRv4.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodCIDRv6 = /*@__PURE__*/ $constructor("ZodCIDRv6", (inst, def) => {
	$ZodCIDRv6.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodBase64 = /*@__PURE__*/ $constructor("ZodBase64", (inst, def) => {
	$ZodBase64.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodBase64URL = /*@__PURE__*/ $constructor("ZodBase64URL", (inst, def) => {
	$ZodBase64URL.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodE164 = /*@__PURE__*/ $constructor("ZodE164", (inst, def) => {
	$ZodE164.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodJWT = /*@__PURE__*/ $constructor("ZodJWT", (inst, def) => {
	$ZodJWT.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodNumber = /*@__PURE__*/ $constructor("ZodNumber", (inst, def) => {
	$ZodNumber.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => numberProcessor(inst, ctx, json, params);
	_installLazyMethods(inst, "ZodNumber", {
		gt(value, params) {
			return this.check(/* @__PURE__ */ _gt(value, params));
		},
		gte(value, params) {
			return this.check(/* @__PURE__ */ _gte(value, params));
		},
		min(value, params) {
			return this.check(/* @__PURE__ */ _gte(value, params));
		},
		lt(value, params) {
			return this.check(/* @__PURE__ */ _lt(value, params));
		},
		lte(value, params) {
			return this.check(/* @__PURE__ */ _lte(value, params));
		},
		max(value, params) {
			return this.check(/* @__PURE__ */ _lte(value, params));
		},
		int(params) {
			return this.check(int(params));
		},
		safe(params) {
			return this.check(int(params));
		},
		positive(params) {
			return this.check(/* @__PURE__ */ _gt(0, params));
		},
		nonnegative(params) {
			return this.check(/* @__PURE__ */ _gte(0, params));
		},
		negative(params) {
			return this.check(/* @__PURE__ */ _lt(0, params));
		},
		nonpositive(params) {
			return this.check(/* @__PURE__ */ _lte(0, params));
		},
		multipleOf(value, params) {
			return this.check(/* @__PURE__ */ _multipleOf(value, params));
		},
		step(value, params) {
			return this.check(/* @__PURE__ */ _multipleOf(value, params));
		},
		finite() {
			return this;
		}
	});
	const bag = inst._zod.bag;
	inst.minValue = Math.max(bag.minimum ?? Number.NEGATIVE_INFINITY, bag.exclusiveMinimum ?? Number.NEGATIVE_INFINITY) ?? null;
	inst.maxValue = Math.min(bag.maximum ?? Number.POSITIVE_INFINITY, bag.exclusiveMaximum ?? Number.POSITIVE_INFINITY) ?? null;
	inst.isInt = (bag.format ?? "").includes("int") || Number.isSafeInteger(bag.multipleOf ?? .5);
	inst.isFinite = true;
	inst.format = bag.format ?? null;
});
function number(params) {
	return /* @__PURE__ */ _number(ZodNumber, params);
}
const ZodNumberFormat = /*@__PURE__*/ $constructor("ZodNumberFormat", (inst, def) => {
	$ZodNumberFormat.init(inst, def);
	ZodNumber.init(inst, def);
});
function int(params) {
	return /* @__PURE__ */ _int(ZodNumberFormat, params);
}
const ZodBoolean = /*@__PURE__*/ $constructor("ZodBoolean", (inst, def) => {
	$ZodBoolean.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => booleanProcessor(inst, ctx, json, params);
});
function boolean(params) {
	return /* @__PURE__ */ _boolean(ZodBoolean, params);
}
const ZodUnknown = /*@__PURE__*/ $constructor("ZodUnknown", (inst, def) => {
	$ZodUnknown.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => void 0;
});
function unknown() {
	return /* @__PURE__ */ _unknown(ZodUnknown);
}
const ZodNever = /*@__PURE__*/ $constructor("ZodNever", (inst, def) => {
	$ZodNever.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => neverProcessor(inst, ctx, json, params);
});
function never(params) {
	return /* @__PURE__ */ _never(ZodNever, params);
}
const ZodArray = /*@__PURE__*/ $constructor("ZodArray", (inst, def) => {
	$ZodArray.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => arrayProcessor(inst, ctx, json, params);
	inst.element = def.element;
	_installLazyMethods(inst, "ZodArray", {
		min(n, params) {
			return this.check(/* @__PURE__ */ _minLength(n, params));
		},
		nonempty(params) {
			return this.check(/* @__PURE__ */ _minLength(1, params));
		},
		max(n, params) {
			return this.check(/* @__PURE__ */ _maxLength(n, params));
		},
		length(n, params) {
			return this.check(/* @__PURE__ */ _length(n, params));
		},
		unwrap() {
			return this.element;
		}
	});
});
function array(element, params) {
	return /* @__PURE__ */ _array(ZodArray, element, params);
}
const ZodObject = /*@__PURE__*/ $constructor("ZodObject", (inst, def) => {
	$ZodObjectJIT.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => objectProcessor(inst, ctx, json, params);
	defineLazy(inst, "shape", () => {
		return def.shape;
	});
	_installLazyMethods(inst, "ZodObject", {
		keyof() {
			return _enum(Object.keys(this._zod.def.shape));
		},
		catchall(catchall) {
			return this.clone({
				...this._zod.def,
				catchall
			});
		},
		passthrough() {
			return this.clone({
				...this._zod.def,
				catchall: unknown()
			});
		},
		loose() {
			return this.clone({
				...this._zod.def,
				catchall: unknown()
			});
		},
		strict() {
			return this.clone({
				...this._zod.def,
				catchall: never()
			});
		},
		strip() {
			return this.clone({
				...this._zod.def,
				catchall: void 0
			});
		},
		extend(incoming) {
			return extend(this, incoming);
		},
		safeExtend(incoming) {
			return safeExtend(this, incoming);
		},
		merge(other) {
			return merge(this, other);
		},
		pick(mask) {
			return pick(this, mask);
		},
		omit(mask) {
			return omit(this, mask);
		},
		partial(...args) {
			return partial(ZodOptional, this, args[0]);
		},
		required(...args) {
			return required(ZodNonOptional, this, args[0]);
		}
	});
});
function object(shape, params) {
	const def = {
		type: "object",
		shape: shape ?? {},
		...normalizeParams(params)
	};
	return new ZodObject(def);
}
const ZodUnion = /*@__PURE__*/ $constructor("ZodUnion", (inst, def) => {
	$ZodUnion.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => unionProcessor(inst, ctx, json, params);
	inst.options = def.options;
});
function union(options, params) {
	return new ZodUnion({
		type: "union",
		options,
		...normalizeParams(params)
	});
}
const ZodDiscriminatedUnion = /*@__PURE__*/ $constructor("ZodDiscriminatedUnion", (inst, def) => {
	ZodUnion.init(inst, def);
	$ZodDiscriminatedUnion.init(inst, def);
});
function discriminatedUnion(discriminator, options, params) {
	return new ZodDiscriminatedUnion({
		type: "union",
		options,
		discriminator,
		...normalizeParams(params)
	});
}
const ZodIntersection = /*@__PURE__*/ $constructor("ZodIntersection", (inst, def) => {
	$ZodIntersection.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => intersectionProcessor(inst, ctx, json, params);
});
function intersection(left, right) {
	return new ZodIntersection({
		type: "intersection",
		left,
		right
	});
}
const ZodEnum = /*@__PURE__*/ $constructor("ZodEnum", (inst, def) => {
	$ZodEnum.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => enumProcessor(inst, ctx, json, params);
	inst.enum = def.entries;
	inst.options = Object.values(def.entries);
	const keys = new Set(Object.keys(def.entries));
	inst.extract = (values, params) => {
		const newEntries = {};
		for (const value of values) if (keys.has(value)) newEntries[value] = def.entries[value];
		else throw new Error(`Key ${value} not found in enum`);
		return new ZodEnum({
			...def,
			checks: [],
			...normalizeParams(params),
			entries: newEntries
		});
	};
	inst.exclude = (values, params) => {
		const newEntries = { ...def.entries };
		for (const value of values) if (keys.has(value)) delete newEntries[value];
		else throw new Error(`Key ${value} not found in enum`);
		return new ZodEnum({
			...def,
			checks: [],
			...normalizeParams(params),
			entries: newEntries
		});
	};
});
function _enum(values, params) {
	const entries = Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values;
	return new ZodEnum({
		type: "enum",
		entries,
		...normalizeParams(params)
	});
}
const ZodLiteral = /*@__PURE__*/ $constructor("ZodLiteral", (inst, def) => {
	$ZodLiteral.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => literalProcessor(inst, ctx, json, params);
	inst.values = new Set(def.values);
	Object.defineProperty(inst, "value", { get() {
		if (def.values.length > 1) throw new Error("This schema contains multiple valid literal values. Use `.values` instead.");
		return def.values[0];
	} });
});
function literal(value, params) {
	return new ZodLiteral({
		type: "literal",
		values: Array.isArray(value) ? value : [value],
		...normalizeParams(params)
	});
}
const ZodTransform = /*@__PURE__*/ $constructor("ZodTransform", (inst, def) => {
	$ZodTransform.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => transformProcessor(inst, ctx, json, params);
	inst._zod.parse = (payload, _ctx) => {
		if (_ctx.direction === "backward") throw new $ZodEncodeError(inst.constructor.name);
		payload.addIssue = (issue$1) => {
			if (typeof issue$1 === "string") payload.issues.push(issue(issue$1, payload.value, def));
			else {
				const _issue = issue$1;
				if (_issue.fatal) _issue.continue = false;
				_issue.code ?? (_issue.code = "custom");
				_issue.input ?? (_issue.input = payload.value);
				_issue.inst ?? (_issue.inst = inst);
				payload.issues.push(issue(_issue));
			}
		};
		const output = def.transform(payload.value, payload);
		if (output instanceof Promise) return output.then((output) => {
			payload.value = output;
			payload.fallback = true;
			return payload;
		});
		payload.value = output;
		payload.fallback = true;
		return payload;
	};
});
function transform(fn) {
	return new ZodTransform({
		type: "transform",
		transform: fn
	});
}
const ZodOptional = /*@__PURE__*/ $constructor("ZodOptional", (inst, def) => {
	$ZodOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function optional(innerType) {
	return new ZodOptional({
		type: "optional",
		innerType
	});
}
const ZodExactOptional = /*@__PURE__*/ $constructor("ZodExactOptional", (inst, def) => {
	$ZodExactOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function exactOptional(innerType) {
	return new ZodExactOptional({
		type: "optional",
		innerType
	});
}
const ZodNullable = /*@__PURE__*/ $constructor("ZodNullable", (inst, def) => {
	$ZodNullable.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => nullableProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function nullable(innerType) {
	return new ZodNullable({
		type: "nullable",
		innerType
	});
}
const ZodDefault = /*@__PURE__*/ $constructor("ZodDefault", (inst, def) => {
	$ZodDefault.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => defaultProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
	inst.removeDefault = inst.unwrap;
});
function _default(innerType, defaultValue) {
	return new ZodDefault({
		type: "default",
		innerType,
		get defaultValue() {
			return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
		}
	});
}
const ZodPrefault = /*@__PURE__*/ $constructor("ZodPrefault", (inst, def) => {
	$ZodPrefault.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => prefaultProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function prefault(innerType, defaultValue) {
	return new ZodPrefault({
		type: "prefault",
		innerType,
		get defaultValue() {
			return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
		}
	});
}
const ZodNonOptional = /*@__PURE__*/ $constructor("ZodNonOptional", (inst, def) => {
	$ZodNonOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => nonoptionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function nonoptional(innerType, params) {
	return new ZodNonOptional({
		type: "nonoptional",
		innerType,
		...normalizeParams(params)
	});
}
const ZodCatch = /*@__PURE__*/ $constructor("ZodCatch", (inst, def) => {
	$ZodCatch.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => catchProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
	inst.removeCatch = inst.unwrap;
});
function _catch(innerType, catchValue) {
	return new ZodCatch({
		type: "catch",
		innerType,
		catchValue: typeof catchValue === "function" ? catchValue : () => catchValue
	});
}
const ZodPipe = /*@__PURE__*/ $constructor("ZodPipe", (inst, def) => {
	$ZodPipe.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => pipeProcessor(inst, ctx, json, params);
	inst.in = def.in;
	inst.out = def.out;
});
function pipe(in_, out) {
	return new ZodPipe({
		type: "pipe",
		in: in_,
		out
	});
}
const ZodReadonly = /*@__PURE__*/ $constructor("ZodReadonly", (inst, def) => {
	$ZodReadonly.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => readonlyProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function readonly(innerType) {
	return new ZodReadonly({
		type: "readonly",
		innerType
	});
}
const ZodCustom = /*@__PURE__*/ $constructor("ZodCustom", (inst, def) => {
	$ZodCustom.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => customProcessor(inst, ctx, json, params);
});
function refine(fn, _params = {}) {
	return /* @__PURE__ */ _refine(ZodCustom, fn, _params);
}
function superRefine(fn, params) {
	return /* @__PURE__ */ _superRefine(fn, params);
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-storage@0.2.2-alpha.3_@deepseek-ai+cordis@4.0.6-alpha.2/node_modules/@deepseek-ai/dsh-storage/lib/index.js
/**
* Backend-facing vocabulary of the storage hub: a backend owns one medium
* (a file-tree root, a database file) and exposes operation groups over it.
* This module defines the normative contract text for backend implementers; the shared
* conformance suite in `tests/contract.ts` checks every rule.
* @module @deepseek-ai/dsh-storage/src/backend
*/
/** Allowed format for unit and table names: safe as a file name and as a SQL identifier segment without escaping. */
const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/;
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-storage-domain@0.2.2-alpha.3_@deepseek-ai+cordis@4.0.6-alpha.2_@deepse_66431d32ad9b337d8d328e9f56772416/node_modules/@deepseek-ai/dsh-storage-domain/lib/index.js
/**
* Domain declaration vocabulary. A spec object is the single source of a
* domain's identity, layout, and record schemas: the owning package defines
* it once with {@link defineDomain} and both the type surface and the runtime
* (validation, descriptor projection) derive from it. Record schemas are zod
* (`z.infer` keeps types un-duplicated and the same schemas later project to
* RPC wire schemas); plugin `Config` stays schemastery.
* @module @deepseek-ai/dsh-storage-domain/src/spec
*/
/**
* Declare one table.
* @param schema - zod schema validating every stored record of this table.
* @returns the table declaration, key-typed by `K`.
*/
function domainTable(schema) {
	return { valueSchema: schema };
}
/**
* Identity helper that pins a spec's literal types and validates its fields.
* Misconfiguration fails loud at the owning package's module load, before any
* medium is touched: a domain or table name outside `UNIT_NAME_RE`, a version
* that is not a non-negative integer, or a global schema that accepts `null`
* all throw. The `null` rejection guards round-tripping: backends store the
* global as opaque JSON with `null` as the "never written" sentinel, so a
* nullable global would be indistinguishable from an absent one on reopen
* (a stored `null` silently reverts to `initial`).
* @param spec - The domain declaration.
* @returns the same spec, narrowed to its literal type.
*/
function defineDomain(spec) {
	if (!UNIT_NAME_RE.test(spec.name)) throw new Error(`domain name '${spec.name}' must match ${UNIT_NAME_RE}`);
	if (!Number.isInteger(spec.version) || spec.version < 0) throw new Error(`domain '${spec.name}' version must be a non-negative integer, got ${spec.version}`);
	for (const compat of spec.compatibleVersions ?? []) if (!Number.isInteger(compat) || compat < 0 || compat >= spec.version) throw new Error(`domain '${spec.name}' compatibleVersions entries must be non-negative integers below version ${spec.version}, got ${compat}`);
	if (spec.layout !== void 0) {
		const layout = spec.layout;
		if (layout !== "single" && layout !== "per-record") throw new Error(`domain '${spec.name}' layout must be 'single' or 'per-record', got ${layout}`);
	}
	if (spec.invalidRecords !== void 0) {
		const policy = spec.invalidRecords;
		if (policy !== "backup-and-skip") throw new Error(`domain '${spec.name}' invalidRecords must be 'backup-and-skip' when present, got ${policy}`);
	}
	for (const table of Object.keys(spec.tables)) if (!UNIT_NAME_RE.test(table)) throw new Error(`domain '${spec.name}' table name '${table}' must match ${UNIT_NAME_RE}`);
	if (spec.global !== void 0 && spec.global.schema.safeParse(null).success) throw new Error(`domain '${spec.name}' global schema must not accept null: null is the medium's "never written" sentinel, so a stored null could not round-trip`);
	return spec;
}
z.object({
	backend: z.string().required(),
	routes: z.dict(z.string()).default({})
});
/**
* The workspace domain declaration: record schema and the `defineDomain` spec
* the registry opens. The zod schema validates the shipped format at the
* durability boundary and is the direct source of a future RPC wire projection.
* @module @deepseek-ai/dsh-workspace/src/spec
*/
/** Workspace id schema at the durable boundary; branding has no runtime representation. */
const workspaceId = string().transform((value) => value);
const sessionId = string().transform((value) => brandString(value));
/**
* Durable shape of one workspace record. `path` is the `fs.realpath` canon
* stamped at create; `sessionIds` is the ordered ownership account (array
* order is display order); timestamps are ISO-8601 strings.
*/
const workspaceRecord = object({
	path: string(),
	title: string(),
	sessionIds: array(sessionId),
	createdAt: string(),
	updatedAt: string()
});
/**
* Recoverable two-write mutation marker. The marker is persisted before the
* record/order pair can diverge, so startup can distinguish an interrupted
* registry operation from unexplained medium corruption.
*/
const workspacePendingMutation = discriminatedUnion("operation", [object({
	operation: literal("create"),
	workspaceId
}), object({
	operation: literal("delete"),
	workspaceId
})]);
defineDomain({
	name: "workspace",
	version: 2,
	global: {
		schema: object({
			initialized: boolean(),
			/** First-use Workspace identity, retained after its registration is deleted. */
			defaultWorkspaceId: workspaceId.optional(),
			workspaceIds: array(workspaceId),
			archivedSessionIds: array(sessionId).default([]),
			pinnedSessionIds: array(sessionId).default([]),
			pendingMutation: workspacePendingMutation.optional()
		}),
		initial: {
			initialized: false,
			workspaceIds: [],
			archivedSessionIds: [],
			pinnedSessionIds: []
		}
	},
	tables: { workspaces: domainTable(workspaceRecord) }
});
/**
* Workspace entity registry (`ctx.workspaceRegistry`): durable workspace records,
* stable registry order, and header-validated session membership over the
* domain data form.
* @module @deepseek-ai/dsh-workspace
*/
/**
* Brand a string as a {@link WorkspaceId}.
* @param id - Raw workspace id string.
* @returns the same string, branded at compile time.
*/
function WorkspaceId(id) {
	return id;
}
Service.init;
//#endregion
//#region src/core.ts
/**
* dsh-session-bridge core: 会话创建 / 发消息 / 等待回复 / 读取 / 查找。
* 所有逻辑跑在插件宿主上下文（rootCtx），操作的是 DSH 真实的会话与 agent 注册表。
*/
/**
* 兼容读取不同 dsh-session 版本上的会话事件：
* - 旧版 \`Session\` 暴露 \`get events(): readonly SessionEvent[]\`；
* - 新版将 \`get events\` 改为 \`snapshotEvents(fromSeq?, toSeqExclusive?)\` 方法——
*   \`.events\` 直接读取会得到 \`undefined\`，对 for...of 迭代即抛
*   \`events is not iterable\`。
* 两者都读不到（或 session 不存在）时回退为空数组，绝不抛迭代错误。
*
* 注意：dsh 0.1.6-alpha.1 起 \`snapshotEvents()\`（连同 \`eventAt()\` /
* \`ownEvents()\`）已标记 @deprecated —— 官方策略是"现有逻辑可暂不迁移，但禁止
* 新增调用"；其替代不是同步读，而是（a）恢复后读取 Session 投影/派生状态，或
* （b）按需异步分页读取历史窗口（见 dsh 决策
* 2026-09-09-deprecate-synchronous-session-event-reads）。本函数的调用方
* （foldMessages / segmentsSince / wait 基线）仍依赖完整同步快照，故按该决定暂缓
* 迁移；将来官方补齐分页读后，只需改造这一个入口。
*/
function sessionEvents(session) {
	const s = session;
	if (s === null || s === void 0) return [];
	if (Array.isArray(s.events)) return s.events;
	if (typeof s.snapshotEvents === "function") try {
		return s.snapshotEvents();
	} catch {
		return [];
	}
	return [];
}
/** 规约任意"事件列表"值为数组（非数组 → []），避免 events is not iterable。 */
function asEventList(events) {
	return Array.isArray(events) ? events : [];
}
/**
* 读取一个持久化（离线）会话的事件日志与头部元数据。兼容两代 persistence API：
* - 旧版：`sessionPersistence.inspect(id)` 直接返回 { events, meta }；
* - dsh 0.1.5 之后：`inspect` 已删除，改用 `open(id, 'read')` → `handle.read()`
*   （+ `handle.header`），读句柄不抢写所有权，读后必须 close()。
* 会话不存在时两个 API 都抛错，调用方按原语义处理。
* DSH 0.1.7 的持久化层在 open/read 时准备 V3→V4 迁移，可能补入
* interrupted turn/end 并重新编号。始终消费返回的逻辑事件，不读取物理 JSONL。
*/
async function inspectPersistedSession(ctx, id) {
	const persistence = ctx.sessionPersistence;
	if (typeof persistence.inspect === "function") return await persistence.inspect(id);
	const handle = await persistence.open(id, "read");
	try {
		const { events } = await handle.read();
		return {
			events,
			meta: handle.header
		};
	} finally {
		await handle.close();
	}
}
/** agent.followup / steer 接受的用户消息值。 */
function userMessage(text) {
	return {
		id: randomUUID(),
		role: "user",
		content: [{
			type: "text",
			text
		}],
		source: { kind: "user" }
	};
}
function blockText(content) {
	if (!Array.isArray(content)) return void 0;
	const parts = [];
	for (const raw of content) {
		const block = raw;
		if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
			if (block.text !== "") parts.push(block.text);
		}
	}
	return parts.length === 0 ? void 0 : parts.join("\n");
}
/** 提取指定类型的 content block 文本（如 reasoning），用于从消息 content 里读出思维链。 */
function blockTextByType(content, wantedType) {
	if (!Array.isArray(content)) return void 0;
	const parts = [];
	for (const raw of content) {
		const block = raw;
		if (block !== null && typeof block === "object" && block.type === wantedType && typeof block.text === "string") {
			if (block.text !== "") parts.push(block.text);
		}
	}
	return parts.length === 0 ? void 0 : parts.join("\n");
}
function countImages(content) {
	if (!Array.isArray(content)) return 0;
	let n = 0;
	for (const raw of content) {
		const block = raw;
		if (block !== null && typeof block === "object" && block.type === "image") n += 1;
	}
	return n;
}
function toolNamesOf(toolCalls) {
	if (!Array.isArray(toolCalls)) return [];
	const names = [];
	for (const raw of toolCalls) {
		const call = raw;
		if (call !== null && typeof call === "object" && typeof call.name === "string" && !names.includes(call.name)) names.push(call.name);
	}
	return names;
}
/** 折叠会话事件日志为可读消息行（跳过非 user 来源与空消息）。 */
function foldMessages(events) {
	const list = asEventList(events);
	const rows = [];
	for (const event of list) if (event.type === "user/message") {
		const source = event.data.source;
		if (source !== void 0 && source.kind !== "user") continue;
		const text = blockText(event.data.content);
		if (text === void 0) continue;
		rows.push({
			seq: event.seq,
			time: event.time,
			role: "user",
			text,
			images: countImages(event.data.content)
		});
	} else if (event.type === "assistant/message") {
		const message = event.data.message;
		const text = message === null ? void 0 : blockText(message.content);
		const reasoning = message === null ? void 0 : blockTextByType(message.content, "reasoning") ?? blockText(message.reasoning);
		const images = message === null ? 0 : countImages(message.content);
		const toolCalls = message === null ? [] : toolNamesOf(message.toolCalls);
		if (text === void 0 && reasoning === void 0 && toolCalls.length === 0) continue;
		const row = {
			seq: event.seq,
			time: event.time,
			role: "assistant",
			images
		};
		if (text !== void 0) row.text = text;
		if (reasoning !== void 0) row.reasoning = reasoning;
		if (toolCalls.length > 0) row.toolCalls = toolCalls;
		rows.push(row);
	}
	return rows;
}
/** 按已完成输出段落折叠事件日志：每个 assistant/message 割一段，返回 sinceSeq 后的所有段落（事件序）。 */
function segmentsSince(events, sinceSeq = 0) {
	const list = asEventList(events);
	const out = [];
	let openTurn = false;
	for (const event of list) {
		if (event.type === "turn/start") {
			openTurn = true;
			continue;
		}
		if (event.type === "turn/end") {
			openTurn = false;
			continue;
		}
		if (event.type !== "assistant/message") continue;
		if (event.seq <= sinceSeq) continue;
		const message = event.data.message;
		const text = message === null ? void 0 : blockText(message.content);
		const reasoning = message === null ? void 0 : blockTextByType(message.content, "reasoning") ?? blockText(message.reasoning);
		const toolCalls = message === null ? [] : toolNamesOf(message.toolCalls);
		const turn = event.data?.turn;
		const step = event.data?.step;
		const seg = {
			seq: event.seq,
			time: event.time,
			turn: typeof turn === "number" ? turn : 0,
			step: typeof step === "number" ? step : 0,
			toolCalls,
			openTurn
		};
		if (text !== void 0) seg.text = text;
		if (reasoning !== void 0) seg.reasoning = reasoning;
		out.push(seg);
	}
	return out;
}
/** 取自 sinceSeq 之后最新一个已完成输出段落（无则 null）。 */
function latestSegmentSince(events, sinceSeq = 0) {
	const segs = segmentsSince(events, sinceSeq);
	return segs.length === 0 ? null : segs[segs.length - 1] ?? null;
}
/**
* 对一个 live 会话的事件日志折叠出其"最近推理/文本增量流"。兼容两代日志形状：
* - dsh 0.1.5 之后：turn 内不再发布独立 chunk 事件，流式增量内嵌在已定型
*   assistant/message（或未定型 assistant/attempt）事件的 `stream` 记录里
*   （reasoning-chunks / text-chunks 批量段 + 原始 chunk：reasoning-delta / text-delta）；
* - 0.1.2-rc 之前：独立的 assistant/chunk 事件（turn 中途即可见、增量，
*   这正是旧版监控思维链并按规则提前终止所需的粒度）。
* 两者兼读、取最新一份；无任何增量（会话空闲、或该 provider 不流式推理/无推理）
* 返回 null，调用方应回落为 foldMessages 里已定型的 message.reasoning。
* 纯读、无副作用；事件形状不做任何假设，缺失/异常一律安全处理。
*/
function liveReasoningSnapshot(events) {
	const list = asEventList(events);
	let lastFinalizedSeq = -1;
	let reasoning = "";
	let text = "";
	let seq = -1;
	let time = 0;
	let turn = 0;
	let step = 0;
	let foundDelta = false;
	for (const event of list) {
		const type = event.type;
		if (type === "assistant/message" || type === "assistant/attempt") {
			const data = event.data;
			if (data !== null && data !== void 0 && typeof data === "object" && Array.isArray(data.stream)) {
				let r = "";
				let t = "";
				for (const raw of data.stream) {
					const record = raw;
					if (record === null || typeof record !== "object") continue;
					if (record.type === "reasoning-chunks" && Array.isArray(record.texts)) {
						for (const s of record.texts) if (typeof s === "string") r += s;
					} else if (record.type === "text-chunks" && Array.isArray(record.texts)) {
						for (const s of record.texts) if (typeof s === "string") t += s;
					} else if (record.type === "chunk") {
						const c = record.chunk;
						if (c !== null && typeof c === "object" && typeof c.type === "string" && typeof c.text === "string") {
							if (c.type === "reasoning-delta") r += c.text;
							else if (c.type === "text-delta") t += c.text;
						}
					}
				}
				if (r !== "" || t !== "") {
					if (typeof data.turn === "number") turn = data.turn;
					if (typeof data.step === "number") step = data.step;
					reasoning = r;
					text = t;
					seq = event.seq;
					time = event.time;
					foundDelta = true;
				}
			}
			if (type === "assistant/message") lastFinalizedSeq = event.seq;
			continue;
		}
		if (type !== "assistant/chunk") continue;
		if (event.seq <= lastFinalizedSeq) continue;
		const data = event.data;
		if (data === null || data === void 0 || typeof data !== "object") continue;
		const c = data.chunk;
		if (c === null || typeof c !== "object" || typeof c.type !== "string") continue;
		if (c.type === "reasoning-delta" || c.type === "text-delta") {
			if (typeof c.text !== "string") continue;
			if (c.type === "reasoning-delta") reasoning += c.text;
			else text += c.text;
			if (typeof data.turn === "number") turn = data.turn;
			if (typeof data.step === "number") step = data.step;
			foundDelta = true;
			if (event.seq > seq) seq = event.seq;
			if (event.time > time) time = event.time;
		}
	}
	if (!foundDelta) return null;
	return {
		turn,
		step,
		reasoning,
		text,
		seq,
		time
	};
}
/** 思维链尾巴默认截断上限（字符）。 */
const REASONING_TAIL_LIMIT = 4e3;
/**
* 组装一条受字符上限约束的"思维链尾巴"用于展示/摘要：
* 优先进行中的 liveReasoning，否则最近已定型的 lastReasoning；
* 超出上限时截断并附省略标记。两者皆无返回 undefined。
*/
function reasoningTailOf(liveReasoning, lastReasoning, limit = REASONING_TAIL_LIMIT) {
	const source = liveReasoning ?? lastReasoning;
	if (source === void 0 || source === "") return void 0;
	if (source.length <= limit) return source;
	return source.slice(0, limit) + "…";
}
/**
* 会话标题：优先 session/title 事件（last-wins，与 UI 一致）；
* 无标题事件时回落为第一条用户消息（截断 80 字符）。
*/
function titleOf(events) {
	const list = asEventList(events);
	let title;
	for (const event of list) {
		const raw = event;
		if (raw.type === "session/title") {
			const t = raw.data.title;
			if (typeof t === "string" && t !== "") title = t;
		}
	}
	if (title !== void 0) return title;
	for (const event of list) if (event.type === "user/message") {
		const source = event.data.source;
		if (source !== void 0 && source.kind !== "user") continue;
		const text = blockText(event.data.content);
		if (text !== void 0) {
			const trimmed = text.replace(/\s+/g, " ").trim();
			return trimmed.length > 80 ? trimmed.slice(0, 80) + "…" : trimmed;
		}
	}
}
/** 日志最大事件序号。 */
function maxSeq(events) {
	const list = asEventList(events);
	let m = -1;
	for (const event of list) if (event.seq > m) m = event.seq;
	return m;
}
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
* 轮询等待某会话在 baseline 之后出现新的 assistant 回复。
*
* 完成条件默认是"出现一条带文本的新 assistant 回复"（即回复可读），而不是
* 等待 turn/end。实测发现 bridge 通过 agent.followup() 驱动的 turn 在事件流里
* 不保证产生 turn/end（会一直等满超时），导致"回复早就有了、读取却要等十几二十秒"。
* 因此默认不再用 turn/end 作门控；需要完整收尾语义时用 requireTurnEnd:true 显式开启，
* 此时才会等到其后出现 turn/end。
*
* 返回的 message：默认是 baseline 之后最新的一条**带文本** assistant 行；整个等待
* 窗口内没有等到新文本回复时，回落为 baseline 及之前最新的一条带文本回复并置
* stale:true（绝不把更晚的无文本中间行当回复返回 —— 那正是渲染层打印 "(no text)"
* 的来源）。segment 模式同理：新段落优先，否则回落既有段落。
* 超时/中止返回已收集内容；timedOut 表示"本次等待要求的输出未在预算内出现"。
*/
async function waitForReply(opts) {
	const started = Date.now();
	const deadline = started + opts.timeoutMs;
	const requireTurnEnd = opts.requireTurnEnd ?? false;
	const waitForSegment = opts.waitForSegment ?? false;
	let latest = null;
	let textReply = null;
	let segment = null;
	let turnEnded = false;
	for (;;) {
		if (opts.signal !== void 0 && opts.signal.aborted) break;
		const events = sessionEvents(opts.session);
		for (const row of foldMessages(events)) {
			if (row.seq <= opts.baselineSeq || row.role !== "assistant") continue;
			if (latest === null || row.seq > latest.seq) latest = row;
			if (row.text !== void 0 && (textReply === null || row.seq > textReply.seq)) textReply = row;
		}
		if (waitForSegment) {
			const seg = latestSegmentSince(events, opts.baselineSeq);
			if (seg !== null && (segment === null || seg.seq > segment.seq)) segment = seg;
		}
		if (requireTurnEnd && latest !== null) {
			for (const event of events) if (event.seq > latest.seq && event.type === "turn/end") {
				turnEnded = true;
				break;
			}
		}
		let done;
		if (requireTurnEnd) done = latest !== null && turnEnded;
		else if (waitForSegment) done = segment !== null;
		else done = textReply !== null;
		if (done) break;
		if (Date.now() >= deadline) break;
		await sleep(100);
	}
	const observedNew = waitForSegment ? segment !== null : textReply !== null;
	const sawNewRow = latest !== null;
	let stale = false;
	if (waitForSegment) {
		if (segment === null) {
			const prev = lastSegmentUpTo(sessionEvents(opts.session), opts.baselineSeq);
			if (prev !== null) {
				segment = prev;
				stale = true;
			}
		}
	} else if (textReply === null) {
		const prev = lastTextRowUpTo(foldMessages(sessionEvents(opts.session)), opts.baselineSeq);
		if (prev !== null) {
			textReply = prev;
			stale = true;
		}
	}
	const message = waitForSegment && segment !== null ? {
		seq: segment.seq,
		time: segment.time,
		role: "assistant",
		images: 0,
		...segment.text !== void 0 ? { text: segment.text } : {},
		...segment.reasoning !== void 0 ? { reasoning: segment.reasoning } : {},
		...segment.toolCalls.length > 0 ? { toolCalls: segment.toolCalls } : {}
	} : textReply;
	return {
		message,
		seq: message === null ? opts.baselineSeq : message.seq,
		turnEnded,
		timedOut: requireTurnEnd ? !(sawNewRow && turnEnded) : !observedNew,
		stale,
		aborted: opts.signal !== void 0 && opts.signal.aborted,
		waitedMs: Date.now() - started
	};
}
/** seq 及之前最新一个已完成输出段落（wait 零新输出时回落既有段落）。 */
function lastSegmentUpTo(events, seq) {
	const segs = segmentsSince(events);
	for (let i = segs.length - 1; i >= 0; i -= 1) {
		const seg = segs[i];
		if (seg !== void 0 && seg.seq <= seq) return seg;
	}
	return null;
}
/** seq 及之前最新一条带文本的 assistant 行（wait 零新文本回复时回落既有回复）。 */
function lastTextRowUpTo(rows, seq) {
	for (let i = rows.length - 1; i >= 0; i -= 1) {
		const row = rows[i];
		if (row !== void 0 && row.role === "assistant" && row.text !== void 0 && row.seq <= seq) return row;
	}
	return null;
}
/**
* 解析目标工作目录：workspaceId（注册表）> cwd（绝对路径/任意拼写）> 调用者会话 cwd。
* 跨工作区由 workspaceId / cwd 任意指定实现。
*/
async function resolveTargetCwd(ctx, callerCwd, args) {
	if (typeof args.workspaceId === "string" && args.workspaceId !== "") {
		const ws = ctx.workspaceRegistry.get(WorkspaceId(args.workspaceId));
		if (ws === void 0) throw new Error(`workspace not found: ${args.workspaceId}`);
		return ws.path;
	}
	if (typeof args.cwd === "string" && args.cwd.trim() !== "") return args.cwd.trim();
	if (callerCwd !== void 0 && callerCwd !== "") return callerCwd;
	throw new Error("cannot determine target working directory: pass cwd or workspaceId");
}
/** 会话 id → workspace id（遍历注册表反查，跨全部工作区）。 */
function workspaceBySession(ctx) {
	const map = /* @__PURE__ */ new Map();
	for (const ws of ctx.workspaceRegistry.list()) for (const sessionId of ws.sessionIds) map.set(sessionId, String(ws.id));
	return map;
}
/** 会话 cwd → workspace id（按路径匹配；无则 undefined）。 */
function workspaceByPath(ctx, cwd) {
	if (cwd === void 0) return void 0;
	for (const ws of ctx.workspaceRegistry.list()) if (ws.path === cwd) return ws.id;
}
/**
* 将会话计入其 cwd 所属的 workspace（镜像 session-controller 的 create /
* fork 记账：它们创建代理后都会调用 workspace.attachSession）。没有这一步，
* bridge 直建的新会话不会出现在任何 workspace 组，而是落到 UI 的"未分组"。
* cwd 无可校验 workspace 时（目录未登记/无法解析）返回 undefined，会话保持
* 未分组，与 workspace 的既有语义一致；attach 失败只告警、不阻断会话本身。
* @returns 会话所属 workspace id，无可归属时 undefined。
*/
async function attachSessionToWorkspace(ctx, sessionId, cwd) {
	if (cwd === void 0 || cwd === "") return void 0;
	let workspace;
	try {
		workspace = await ctx.workspaceRegistry.resolveByPath(cwd);
	} catch {
		workspace = void 0;
	}
	if (workspace === void 0) return void 0;
	try {
		await workspace.attachSession(sessionId);
	} catch (error) {
		console.warn(`[dsh-session-bridge] failed to attach session '${sessionId}' to workspace '${workspace.id}': ` + (error instanceof Error ? error.message : String(error)));
		return;
	}
	return workspace.id;
}
/**
* 卡住判定（唯一真源，status 渲染与监控 watchdog 共用）：只有 **running** 会话才可能
* "卡住" —— 空闲/已收尾的会话没有进展是正常状态，不能报 stall。阈值语义为"超过"
* （严格大于），与工具描述/README 的 "more than stalledMs" 一致。
*/
function isStalled(running, stalledMs, thresholdMs) {
	return running === "running" && stalledMs !== null && stalledMs > thresholdMs;
}
/**
* 计算一个 live 会话的监控快照（agent 状态 + 事件折叠出的进度/卡住事实）。
* 纯读，无副作用。用于 `session_bridge_status`。
*/
function statusSnapshot(ctx, agent) {
	const events = sessionEvents(agent.session);
	const rows = foldMessages(events);
	let lastActivityAt = null;
	let lastTurn = 0;
	let openTurn = false;
	for (const event of events) {
		if (event.type === "turn/start" || event.type === "turn/end") {
			const turn = event.data?.turn;
			if (typeof turn === "number" && turn > 0) lastTurn = turn;
		}
		if (event.type === "turn/start") openTurn = true;
		if (event.type === "turn/end") openTurn = false;
		if (event.time > (lastActivityAt ?? 0)) lastActivityAt = event.time;
	}
	const recent = rows.slice(-8);
	let lastAssistantText;
	let lastReasoning;
	for (let i = rows.length - 1; i >= 0; i -= 1) {
		const row = rows[i];
		if (row !== void 0 && row.role === "assistant") {
			if (lastAssistantText === void 0 && row.text !== void 0) lastAssistantText = row.text;
			if (lastReasoning === void 0 && row.reasoning !== void 0) lastReasoning = row.reasoning;
			if (lastAssistantText !== void 0 && lastReasoning !== void 0) break;
		}
	}
	const live = liveReasoningSnapshot(events);
	const liveReasoning = live !== null && live.reasoning !== "" ? live.reasoning : void 0;
	const reasoningTail = reasoningTailOf(liveReasoning, lastReasoning);
	const inbox = agent.inbox;
	const cwd = agent.session.header.cwd;
	const title = titleOf(events);
	return {
		sessionId: agent.id,
		live: true,
		running: agent.status,
		...title === void 0 ? {} : { title },
		...cwd === void 0 ? {} : { cwd },
		...workspaceByPath(ctx, cwd) === void 0 ? {} : { workspaceId: workspaceByPath(ctx, cwd) },
		openTurn,
		lastTurn,
		lastActivityAt,
		stalledMs: lastActivityAt === null ? null : Date.now() - lastActivityAt,
		pendingWork: inbox?.hasPending === true || (inbox?.nextTurn?.length ?? 0) + (inbox?.nextStep?.length ?? 0) > 0,
		nextTurnCount: inbox?.nextTurn?.length ?? 0,
		nextStepCount: inbox?.nextStep?.length ?? 0,
		...lastAssistantText === void 0 ? {} : { lastAssistantText },
		...lastReasoning === void 0 ? {} : { lastReasoning },
		...liveReasoning === void 0 ? {} : { liveReasoning },
		...reasoningTail === void 0 ? {} : { reasoningTail },
		messageCount: rows.length,
		recent
	};
}
/**
* 组装 `session_bridge_archived` 的返回条目：只有当标题确实解析出来时才带上
* `title` 字段。显式写入 `title: undefined` 会让工具返回值不再是 lossless JSON，
* 宿主会因此拒绝**整个**工具结果（真实事故：归档集合里存在"无用户消息 / 无
* session/title 事件"的会话时，`resolveTitles: true` 必然报
* `value is not lossless JSON`）。标题缺失只是信息缺失，不应让工具整体失败。
*/
function archivedEntries(ids, titles) {
	return ids.map((sessionId) => {
		const title = titles.get(sessionId);
		return title === void 0 || title === "" ? { sessionId } : {
			sessionId,
			title
		};
	});
}
/** 取 live agent（跨工具/监控共用）。不存在返回 undefined。 */
function getLiveAgent(ctx, sessionId) {
	return ctx.agents.get(sessionId);
}
/** 对 live 会话发送一条用户消息（queue=追加一轮，steer=打断当前步注入）。 */
function sendLiveMessage(ctx, sessionId, message, mode) {
	const agent = getLiveAgent(ctx, sessionId);
	if (agent === void 0) return false;
	if (mode === "steer") agent.steer(userMessage(message));
	else agent.followup(userMessage(message));
	return true;
}
/** 中止一个 live 会话的活动 turn（可保留队列输入）。返回是否发起了取消。 */
function cancelLiveSession(ctx, sessionId, keepInbox, reason) {
	const agent = getLiveAgent(ctx, sessionId);
	if (agent === void 0) return false;
	const cause = typeof reason === "string" && reason.trim() !== "" ? {
		kind: "hook",
		reason: reason.trim()
	} : { kind: "user" };
	agent.cancel(cause, { keepInbox });
	return true;
}
/**
* 目标会话是否是**顶层**会话（而不是某个 agent 派生的子代理）。
*
* 判据是 dsh-agent 的 `AgentRegistry.roots()`：它返回"创建时没有 owner"的 agent
* （`entry.owner === undefined`），其注释明确"durable session lineage 不影响该运行时
* 关系"。桥创建的会话与 UI 主会话都是顶层。
*
* 返回 undefined 表示**无法判定**（宿主没有 roots API，例如旧 harness 或测试桩）——
* 调用方应按顶层处理，保持旧行为，而不是改判成子代理。
*/
function isRootAgent(ctx, sessionId) {
	const agents = ctx.agents;
	if (typeof agents.roots !== "function") return void 0;
	try {
		return agents.roots().some((agent) => agent.id === sessionId);
	} catch {
		return;
	}
}
/**
* 收集某个会话**直接派生**的子代理快照（循环转移时的交接清单用）。
*
* 归属判定优先用 `AgentRegistry.isOwnedBy(id, owner)`（`store.get(id)?.owner === owner`，
* 精确到运行时父子关系，且"运行时归属与持久化谱系无关"）；宿主没有该方法时回落到
* session header 的 `parentSession`（持久化信息，重启后仍可读，但会把 fork 出来的
* 会话也算进来，故仅作兜底）。
*
* 只读；任何一步异常都不抛出——宁可少列一个子代理，也不能让转移流程失败。
*/
function collectDescendants(ctx, owner) {
	const agents = ctx.agents;
	let list;
	try {
		list = typeof agents.list === "function" ? agents.list() : [];
	} catch {
		return [];
	}
	const owned = [];
	for (const candidate of list) {
		if (candidate === owner || candidate.id === owner.id) continue;
		if (typeof agents.isOwnedBy === "function") {
			let byOwner = false;
			try {
				byOwner = agents.isOwnedBy(candidate.id, owner);
			} catch {
				byOwner = false;
			}
			if (byOwner) owned.push(candidate);
			continue;
		}
		if ((candidate.session?.header)?.parentSession === owner.id) owned.push(candidate);
	}
	return owned.map((child) => {
		const header = child.session.header;
		const task = firstUserText$1(foldMessages(sessionEvents(child.session)));
		return {
			id: child.id,
			status: child.status,
			running: child.status === "running",
			...header.origin === void 0 ? {} : { origin: header.origin },
			...header.delegationDepth === void 0 ? {} : { delegationDepth: header.delegationDepth },
			...task === void 0 ? {} : { task: clipText(task, 400) }
		};
	});
}
/** 截断到 limit 字符（超出加省略号）。 */
function clipText(text, limit) {
	return text.length > limit ? text.slice(0, limit) + "…" : text;
}
/** 事件日志里第一条用户指令（子代理领到的任务描述）。 */
function firstUserText$1(rows) {
	for (const row of rows) if (row.role === "user" && row.text !== void 0) return row.text;
}
/** 默认阈值：2 句×3 次 / 3 句×2 次起判；2 次重复太常见，不触发。 */
const LOOP_DEFAULTS = {
	minCycles: 2,
	minRepeats: 3,
	minConfidence: .6,
	charN: 4,
	charRepeatRate: .5,
	charMinTokens: 120
};
/**
* 把文本切成检测单位：在换行与句末标点**之后**切分，标点保留在单位内。
* 每段折叠空白并 trim，空段丢弃。
*/
function splitUnits(text) {
	if (typeof text !== "string" || text === "") return [];
	const parts = text.split(/(?<=[。！？；!?;\n])/);
	const units = [];
	for (const raw of parts) {
		const unit = raw.replace(/\s+/g, " ").trim();
		if (unit !== "") units.push(unit);
	}
	return units;
}
/** 比较 units[from .. from+p-1] 与模板 units[ref .. ref+p-1] 是否逐段相等。 */
function sameRun(units, from, ref, p) {
	for (let j = 0; j < p; j += 1) if (units[from + j] !== units[ref + j]) return false;
	return true;
}
/**
* 在单位序列**尾部**找最小周期：以最后 p 个单位为模板，从尾部向前数连续相等的
* 周期数 k（而不是 `floor(n/p)`）。这一点很关键——长思维链里"前面几百句正常、
* 最后三轮开始循环"是最常见的情形，用 `floor(n/p)` 会把检测范围拉到前缀噪声上，
* 反而漏报。p 从 1 递增，因此返回的是**最小**周期。
* 要求 k 同时满足 minCycles 与 minRepeats（有效门槛 = 两者较大者）。未找到返回 null。
*/
function tailPeriodicRepeat(units, opts = {}) {
	const minCycles = opts.minCycles ?? LOOP_DEFAULTS.minCycles;
	const minRepeats = opts.minRepeats ?? LOOP_DEFAULTS.minRepeats;
	const maxPeriod = opts.maxPeriod ?? 8;
	const floor = Math.max(minCycles, minRepeats);
	const n = Array.isArray(units) ? units.length : 0;
	const limit = Math.min(maxPeriod, Math.floor(n / floor));
	for (let p = 1; p <= limit; p += 1) {
		let k = 1;
		while ((k + 1) * p <= n && sameRun(units, n - (k + 1) * p, n - p, p)) k += 1;
		if (k < floor) continue;
		const start = n - k * p;
		return {
			period: p,
			repeats: k,
			covered: k * p,
			unit: units.slice(start, start + p).join("")
		};
	}
	return null;
}
/**
* 字符 n-gram 重复率（空白先剥离）：`repeated` 为"重复出现的 token 数"
* （每个 token 的出现次数减一之和），`rate = repeated / tokens`。
*/
function charRepeatRate(text, n) {
	const size = Number.isInteger(n) && n >= 2 ? n : LOOP_DEFAULTS.charN;
	const compact = typeof text === "string" ? text.replace(/\s+/g, "") : "";
	if (compact.length < size) return {
		tokens: 0,
		repeated: 0,
		rate: 0,
		top: ""
	};
	const counts = /* @__PURE__ */ new Map();
	let tokens = 0;
	for (let i = 0; i + size <= compact.length; i += 1) {
		const gram = compact.slice(i, i + size);
		counts.set(gram, (counts.get(gram) ?? 0) + 1);
		tokens += 1;
	}
	let repeated = 0;
	let top = "";
	let topCount = 0;
	for (const [gram, count] of counts) {
		if (count > 1) repeated += count - 1;
		if (count > topCount) {
			topCount = count;
			top = gram;
		}
	}
	return {
		tokens,
		repeated,
		rate: tokens === 0 ? 0 : repeated / tokens,
		top
	};
}
/**
* 句子级置信度：重复次数（权重 0.5）+ 单位长度（0.3）+ 循环段字符量（0.2）。
* 刻意**不**用 covered/units.length：那会让"前面 100 句正常、最后 3 轮循环"这种
* 最需要抓的情形反被判为低置信度（前缀越长越不触发，方向正好反了）。
*/
function sentenceConfidence(repeats, covered, unitLength) {
	const repeatTerm = Math.min(1, repeats / 3);
	const lengthTerm = Math.min(1, unitLength / 6);
	const coverTerm = Math.min(1, unitLength * covered / 16);
	return Math.min(1, .5 * repeatTerm + .3 * lengthTerm + .2 * coverTerm);
}
function preview(text) {
	return text.length > 120 ? text.slice(0, 120) + "…" : text;
}
function missSignal(chars) {
	return {
		detected: false,
		kind: "sentence",
		period: 0,
		repeats: 0,
		confidence: 0,
		unit: "",
		chars
	};
}
/**
* 检测一段文本是否陷入循环。先试句子级周期（更精确、可解释），未达阈值时再用
* 字符 n-gram 兜底；两者都不满足返回 detected:false 的信号（仍带最接近的量化值）。
*/
function detectLoop(text, config = {}) {
	const minCycles = config.minCycles ?? LOOP_DEFAULTS.minCycles;
	const minRepeats = config.minRepeats ?? LOOP_DEFAULTS.minRepeats;
	const minConfidence = config.minConfidence ?? LOOP_DEFAULTS.minConfidence;
	const charN = config.charN ?? LOOP_DEFAULTS.charN;
	const charRate = config.charRepeatRate ?? LOOP_DEFAULTS.charRepeatRate;
	const charMinTokens = config.charMinTokens ?? LOOP_DEFAULTS.charMinTokens;
	const source = typeof text === "string" ? text : "";
	const tail = source.length > 1200 ? source.slice(-1200) : source;
	const periodic = tailPeriodicRepeat(splitUnits(tail), {
		minCycles,
		minRepeats
	});
	let sentence = missSignal(tail.length);
	if (periodic !== null) {
		const confidence = sentenceConfidence(periodic.repeats, periodic.covered, periodic.unit.length);
		sentence = {
			detected: confidence >= minConfidence,
			kind: "sentence",
			period: periodic.period,
			repeats: periodic.repeats,
			confidence,
			unit: preview(periodic.unit),
			chars: tail.length
		};
		if (sentence.detected) return sentence;
	}
	const stats = charRepeatRate(tail, charN);
	if (stats.tokens >= charMinTokens) {
		const unique = Math.max(1, stats.tokens - stats.repeated);
		const charSignal = {
			detected: stats.rate >= charRate,
			kind: "char",
			period: charN,
			repeats: Math.round(stats.tokens / unique),
			confidence: stats.rate,
			unit: preview(stats.top),
			chars: tail.length
		};
		if (charSignal.detected || charSignal.confidence > sentence.confidence) return charSignal;
	}
	return sentence;
}
function clip(text, limit) {
	return text.length > limit ? text.slice(0, limit) + "…" : text;
}
function firstUserText(rows) {
	for (const row of rows) if (row.role === "user" && row.text !== void 0) return row.text;
}
/**
* 从事件日志折叠出交接所需的任务上下文。思维链优先取**已定型**的最后一段；
* 若没有（会话正卡在循环里、最后一段还没定型），回落到进行中的增量流——
* 循环现场通常正是后者。
*/
function extractTaskContext(events, options = {}) {
	const taskLimit = options.taskLimit ?? 1200;
	const userLimit = options.userLimit ?? 600;
	const assistantLimit = options.assistantLimit ?? 800;
	const reasoningLimit = options.reasoningLimit ?? 1200;
	const recentUsers = options.recentUsers ?? 3;
	const rows = foldMessages(events);
	const task = firstUserText(rows);
	const recentUser = rows.filter((row) => row.role === "user" && row.text !== void 0).slice(-recentUsers).map((row) => clip(row.text ?? "", userLimit));
	let lastAssistant;
	let lastReasoning;
	for (let i = rows.length - 1; i >= 0; i -= 1) {
		const row = rows[i];
		if (row === void 0 || row.role !== "assistant") continue;
		if (lastAssistant === void 0 && row.text !== void 0) lastAssistant = clip(row.text, assistantLimit);
		if (lastReasoning === void 0 && row.reasoning !== void 0) lastReasoning = clip(row.reasoning, reasoningLimit);
		if (lastAssistant !== void 0 && lastReasoning !== void 0) break;
	}
	if (lastReasoning === void 0) {
		const live = liveReasoningSnapshot(events);
		if (live !== null && live.reasoning !== "") lastReasoning = clip(live.reasoning, reasoningLimit);
	}
	return {
		...task === void 0 ? {} : { task: clip(task, taskLimit) },
		recentUser,
		...lastAssistant === void 0 ? {} : { lastAssistant },
		...lastReasoning === void 0 ? {} : { lastReasoning }
	};
}
/** 内置交接模板。占位符：{{sessionId}} {{cwd}} {{reason}} {{task}} {{evidence}} {{descendants}}。 */
const DEFAULT_HANDOFF_TEMPLATE = [
	"你接续一个被中断的任务。原会话的思维链陷入了循环（{{reason}}），已被自动中断。",
	"",
	"原会话: {{sessionId}}",
	"工作目录: {{cwd}}",
	"",
	"原任务指令:",
	"{{task}}",
	"",
	"中断前近况:",
	"{{evidence}}",
	"",
	"{{descendants}}",
	"",
	"请先用 session_bridge_read(sessionId=\"{{sessionId}}\") 读取原会话的完整记录以了解上下文，",
	"然后继续推进该任务。不要重复原会话已完成的步骤，也不要再产出它循环时那段内容。"
].join("\n");
function renderEvidence(context) {
	const parts = [];
	if (context.recentUser.length > 0) parts.push("最近的用户指令:\n" + context.recentUser.map((text) => "- " + text.replace(/\n+/g, " ")).join("\n"));
	if (context.lastAssistant !== void 0) parts.push("最后一条回复:\n" + context.lastAssistant);
	if (context.lastReasoning !== void 0) parts.push("最后一段思维链（可能已进入循环）:\n" + context.lastReasoning);
	return parts.length === 0 ? "(无可用摘要)" : parts.join("\n\n");
}
function renderDescendants(items) {
	const shown = items.slice(0, 5);
	const lines = shown.map((item) => {
		const depth = item.delegationDepth === void 0 ? "" : `, depth ${String(item.delegationDepth)}`;
		const task = item.task === void 0 ? "" : ": " + item.task.replace(/\n+/g, " ");
		return `- ${item.id} (${item.status}${depth})${task}`;
	});
	if (items.length > shown.length) lines.push(`- …另有 ${String(items.length - shown.length)} 个未列出`);
	return lines;
}
/**
* 渲染交接提示。子代理分三类给出不同指令：仍在跑的**不要重做**（去读它的结果）、
* 被终止的按原分工重派、已结束的直接读结果。空段落整段省略。
*/
function buildHandoffPrompt(input) {
	const descendants = input.descendants ?? [];
	const stopped = new Set(input.stopped ?? []);
	const running = descendants.filter((item) => item.running && !stopped.has(item.id));
	const halted = descendants.filter((item) => stopped.has(item.id));
	const finished = descendants.filter((item) => !item.running && !stopped.has(item.id));
	const blocks = [];
	if (running.length > 0) blocks.push([
		"原会话仍在运行的子代理（不要重做它们的工作；可用 session_bridge_status / session_bridge_wait 观察，",
		"完成后用 session_bridge_read 取结果）:",
		...renderDescendants(running)
	].join("\n"));
	if (halted.length > 0) blocks.push(["已终止的子代理（因思维链循环被中断；需要时请按同样的分工重新派生）:", ...renderDescendants(halted)].join("\n"));
	if (finished.length > 0) blocks.push(["已结束的子代理（结果留在原会话日志里，可用 session_bridge_read 取回）:", ...renderDescendants(finished)].join("\n"));
	return (input.template !== void 0 && input.template.trim() !== "" ? input.template : DEFAULT_HANDOFF_TEMPLATE).replaceAll("{{sessionId}}", input.sessionId).replaceAll("{{cwd}}", input.cwd).replaceAll("{{reason}}", input.reason).replaceAll("{{task}}", input.context.task ?? "(未能从原会话日志中解析出任务指令)").replaceAll("{{evidence}}", renderEvidence(input.context)).replaceAll("{{descendants}}", blocks.join("\n\n"));
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-scope@0.2.2-alpha.3_@deepseek-ai+cordis@4.0.6-alpha.2/node_modules/@deepseek-ai/dsh-scope/lib/index.js
/**
* Shared insertion-ordered storage and effect ownership for scope-aware registries.
*
* @module @deepseek-ai/dsh-scope
*/
/**
* Insertion-ordered named entries with caller-owned duplicate diagnostics.
*
* Values are borrowed. Iterators are live within one nonempty table
* generation; draining the table detaches them from later insertions. Each
* successful insertion returns an idempotent undo for that exact entry.
*/
var NamedEntries = class {
	duplicateError;
	data = /* @__PURE__ */ new Map();
	constructor(duplicateError) {
		this.duplicateError = duplicateError;
	}
	/**
	* Insert one unique name.
	* @param name - name unique within this table.
	* @param value - borrowed value to retain.
	* @returns an idempotent undo that removes only this insertion.
	*/
	insert(name, value) {
		const data = this.data;
		if (data.has(name)) throw this.duplicateError(name);
		data.set(name, value);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			data.delete(name);
			if (data.size === 0 && this.data === data) this.data = /* @__PURE__ */ new Map();
		};
	}
	/**
	* Read one named value.
	* @param name - name to resolve.
	* @returns the retained value, or `undefined` when absent.
	*/
	get(name) {
		return this.data.get(name);
	}
	/**
	* Test one name for membership.
	* @param name - name to test.
	* @returns whether the table contains that name.
	*/
	has(name) {
		return this.data.has(name);
	}
	/**
	* Iterate live names in insertion order.
	* @returns the native live key iterator.
	*/
	keys() {
		return this.data.keys();
	}
	/**
	* Iterate live entries in insertion order.
	* @returns the native live entry iterator.
	*/
	entries() {
		return this.data.entries();
	}
	/**
	* Iterate live values in insertion order.
	* @returns the native live value iterator.
	*/
	values() {
		return this.data.values();
	}
	/**
	* Test whether this table has no entries.
	* @returns whether the table is empty.
	*/
	isEmpty() {
		return this.data.size === 0;
	}
};
/**
* Insertion-ordered anonymous entries with independent registration identity.
*
* Equal values remain separate registrations. Values are borrowed, and
* iterators are live within one nonempty table generation; draining the table
* detaches them from later appends.
*/
var AnonymousEntries = class {
	data = /* @__PURE__ */ new Map();
	/**
	* Append one independently owned value.
	* @param value - borrowed value to retain.
	* @returns an idempotent undo for this exact append.
	*/
	append(value) {
		const data = this.data;
		const key = Symbol();
		data.set(key, value);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			data.delete(key);
			if (data.size === 0 && this.data === data) this.data = /* @__PURE__ */ new Map();
		};
	}
	/**
	* Iterate live values in insertion order.
	* @returns the native live value iterator.
	*/
	values() {
		return this.data.values();
	}
	/**
	* Test whether this table has no entries.
	* @returns whether the table is empty.
	*/
	isEmpty() {
		return this.data.size === 0;
	}
};
/**
* Own the global and exact-scope layers for one registry.
*
* Reads never create scoped layers. Registrations derive both visibility and
* effect ownership from the supplied Cordis context, collect undo before
* notification, and reclaim only a completely empty aggregate layer.
*/
var ScopedLayers = class {
	createLayer;
	onChange;
	/** The eagerly constructed context-global layer. */
	global;
	scoped = /* @__PURE__ */ new Map();
	constructor(createLayer, onChange) {
		this.createLayer = createLayer;
		this.onChange = onChange;
		this.global = createLayer(void 0);
	}
	/**
	* Read an existing exact-scope overlay. Deliberately chain-blind: callers
	* addressing one scope's OWN contributions (its restrictions, its guards)
	* must not silently pick up an ancestor's — use {@link chainLayers} where
	* inheritance is the point.
	* @param scope - exact scope key; `undefined` denotes no overlay.
	* @returns the existing scoped layer, or `undefined` without creating one.
	*/
	peek(scope) {
		if (scope === void 0) return void 0;
		return this.scoped.get(scope);
	}
	/**
	* Existing overlays along the scope's parent chain ({@link scopeChainOf}),
	* farthest ancestor first and the exact scope last, so a caller layering
	* them in order gives the nearest scope the final word.
	* @param scope - viewing scope, or `undefined` for no overlays.
	* @returns the existing layers, nearest last; absent overlays are skipped.
	*/
	chainLayers(scope) {
		const layers = [];
		for (const key of scopeChainOf(scope).reverse()) {
			const layer = this.scoped.get(key);
			if (layer !== void 0) layers.push(layer);
		}
		return layers;
	}
	/**
	* Materialize global named entries followed by scope-chain shadows,
	* farthest ancestor first, so the nearest scope's entry wins a name.
	* @param scope - viewing scope, or `undefined` for the global view.
	* @param pick - select the named table from a layer.
	* @returns an insertion-ordered effective map.
	*/
	merge(scope, pick) {
		const merged = new Map(pick(this.global).entries());
		for (const layer of this.chainLayers(scope)) for (const [name, value] of pick(layer).entries()) merged.set(name, value);
		return merged;
	}
	/**
	* Attach one synchronous layer mutation to its registration context.
	* @param ctx - context that determines both scope visibility and effect ownership.
	* @param action - atomic mutation returning its synchronous undo.
	* @param options - Cordis effect label and optional change notification.
	* @returns the exact disposer returned by `ctx.effect()`.
	*/
	effect(ctx, action, options) {
		const scope = scopeOf(ctx);
		const notify = options.notify ?? true;
		return ctx.effect(function* () {
			let layer;
			let created = false;
			if (scope === void 0) layer = this.global;
			else {
				const existing = this.scoped.get(scope);
				if (existing === void 0) {
					layer = this.createLayer(scope);
					this.scoped.set(scope, layer);
					created = true;
				} else layer = existing;
			}
			let undo;
			try {
				undo = action(layer);
			} catch (error) {
				if (scope !== void 0 && created && layer.isEmpty()) this.scoped.delete(scope);
				throw error;
			}
			yield () => {
				undo();
				if (scope !== void 0 && layer.isEmpty()) this.scoped.delete(scope);
				if (notify) this.onChange();
			};
			if (notify) this.onChange();
		}.bind(this), options.label);
	}
};
/**
* Scoped-context primitive: mint a Cordis context that tags registrations with
* an opaque identity and build routing-only event carriers for that identity.
*
* @module @deepseek-ai/dsh-scope
*/
/** Context tag written by {@link createScope}. */
const kScope = Symbol("dsh.scope");
/**
* The enclosing scope of each key. One relation powers both directions of
* scope nesting: registration views inherit DOWN the chain (a child scope
* sees its ancestors' layers — {@link ScopedLayers}), and event admission
* extends UP it (a listener tagged with an ancestor receives events dispatched
* to a descendant key — {@link scopeTarget}).
*/
const scopeParents = /* @__PURE__ */ new WeakMap();
/**
* The chain from a key to its root ancestor.
* @param key - the starting key, or `undefined` for the empty chain.
* @returns keys nearest-first: `[key, parent, grandparent, …]`.
*/
function scopeChainOf(key) {
	const chain = [];
	for (let cursor = key; cursor !== void 0; cursor = scopeParents.get(cursor)) chain.push(cursor);
	return chain;
}
/**
* Read the nearest scope tag inherited by a context.
* @param ctx - context to inspect.
* @returns its scope key, or `undefined` for an unscoped context.
*/
function scopeOf(ctx) {
	return ctx[kScope];
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-llm@0.2.2-alpha.3_@deepseek-ai+cordis@4.0.6-alpha.2/node_modules/@deepseek-ai/dsh-llm/lib/types/brand.js
/**
* dsh-llm's owned branded ids: tool-call correlation and provider request
* diagnostics.
*
* The `Branded<B>` primitive and stateless constructor live in
* `@deepseek-ai/dsh-brand` so every owner of a cross-boundary id can brand it
* without depending on dsh-llm; see that package's README for the
* nominal-typing policy.
*
* @module @deepseek-ai/dsh-llm/brand
*/
/**
* Brand an adapter-owned reasoning-effort identifier.
* @param id - the opaque identifier exposed by one model capability.
* @returns the same string, branded; no validation is performed.
*/
function ReasoningEffortId(id) {
	return brandString(id);
}
const sessionSeqSchema = number().int().nonnegative().transform(brandNumber);
object({
	openTurnStartSeq: sessionSeqSchema.nullable(),
	lastStepStartSeq: sessionSeqSchema.nullable(),
	lastStepBoundary: object({
		kind: union([literal("start"), literal("end")]),
		seq: sessionSeqSchema
	}).nullable(),
	lastTurn: number().int().nonnegative()
});
const selectionSchema = object({
	provider: string().min(1),
	model: string().min(1),
	reasoningEffort: string().min(1).transform(ReasoningEffortId).exactOptional()
}).nullable();
object({
	lastUsed: selectionSchema,
	pending: selectionSchema
}), object({
	lastUsed: selectionSchema,
	next: selectionSchema
});
function routeLabel(route, other) {
	return route.provider === other.provider ? route.model : `${route.provider}/${route.model}`;
}
function modelSwitchNotice(previous, selected) {
	const from = routeLabel(previous, selected);
	const to = routeLabel(selected, previous);
	return createUserMessage({
		content: [{
			type: "text",
			text: `[model changed: assistant turns above this point were generated by ${from}; the session continues with ${to}]`
		}],
		source: {
			kind: "model-selection",
			form: "notice",
			summary: boundContextSummary(`${from} → ${to}`)
		}
	});
}
/**
* Append a model-switch notice when the step's fixed route differs from the
* last request header. Effort-only changes and empty no-request decisions add
* no notice; a failure before header persistence repeats it on the next step.
* Install in the selected Agent's unpublished setup scope.
* @param agentCtx - The selected Agent's scoped context.
* @returns Disposer for the scoped pre-step listener.
*/
function installModelSelection(agentCtx) {
	return agentCtx.on("agent/pre-step", async ({ agent, messages, signal, step, modelSelection }, next) => {
		const decision = await next();
		if (decision.kind === "reject" || signal.aborted) return decision;
		if (decision.messages.length === 0 && (step === 1 || messages.length > 0)) return decision;
		const previous = agent.session.requestHeader()?.config;
		if (previous === void 0 || modelSelection.provider === previous.provider && modelSelection.model === previous.model) return decision;
		return {
			...decision,
			messages: [...decision.messages, modelSwitchNotice(previous, modelSelection)]
		};
	}, { prepend: true });
}
Service.init;
//#endregion
//#region src/session-create.ts
/**
* 会话创建：`session_bridge_create` 工具与守护循环的「循环转移」共用同一条路径。
*
* 抽出这一层的理由：转移必须"先建好新会话、确认成功，再取消原会话"，否则创建失败
* 就会丢任务；两处各写一份创建逻辑迟早漂移（模型继承、预设组合、workspace 记账、
* 桥侧登记、followup 锚点，任何一处漏掉都会让新会话行为不同）。所以只保留一份实现，
* tools 与 monitor 都调它。
*
* 这是**唯一**需要 `@deepseek-ai/dsh-agent` 运行时值（`installModelSelection`）的模块，
* 单独成文件是为了让纯逻辑测试（core/loop-guard/handoff）不必加载宿主包。
*/
/**
* 按宿主签名安装模型选择。返回 false 表示没有可用的安装器或安装失败，
* 调用方据此退回自己的 `agent/request` 兜底钩子（旧宿主上的最后一道保险）。
*/
function installModelSelectionCompat(install, agentCtx, selection) {
	if (install === void 0) return false;
	try {
		if (install.length >= 2) install(agentCtx, selection);
		else install(agentCtx);
		return true;
	} catch (error) {
		console.warn("[dsh-session-bridge] installModelSelection failed, falling back to the agent/request hook:", error instanceof Error ? error.message : String(error));
		return false;
	}
}
/**
* 创建一个真实的顶层 DSH 会话（agent + session + workspace 记账 + 桥侧登记），
* 可选立即投递首条提示。返回的 agent 已是 live agent。
*/
async function createBridgeSession(ctx, registry, options) {
	const caller = options.caller;
	const targetCwd = await resolveTargetCwd(ctx, options.callerCwd ?? caller?.session.header.cwd, options);
	const callerHeader = caller?.session.requestHeader?.();
	const provider = typeof options.provider === "string" && options.provider !== "" ? options.provider : callerHeader?.config?.provider ?? "";
	const model = typeof options.model === "string" && options.model !== "" ? options.model : callerHeader?.config?.model ?? "";
	const reasoningEffort = typeof options.reasoningEffort === "string" && options.reasoningEffort !== "" ? options.reasoningEffort : callerHeader?.config?.reasoningEffort;
	const selection = { current: {
		...provider !== "" ? { provider } : {},
		...model !== "" ? { model } : {},
		...reasoningEffort === void 0 ? {} : { reasoningEffort }
	} };
	const installModelSelection$1 = installModelSelection;
	const sessionId = `${options.idPrefix ?? "sb-"}${randomUUID()}`;
	const agents = ctx.agents;
	const requestedPreset = typeof options.agentPreset === "string" && options.agentPreset.trim() !== "" ? options.agentPreset.trim() : void 0;
	const agent = (await agents.create({
		sessionId,
		meta: {
			cwd: targetCwd,
			...requestedPreset === void 0 ? {} : { agentPreset: requestedPreset }
		},
		agentOptions: {
			...provider !== "" ? { provider } : {},
			...model !== "" ? { model } : {},
			...reasoningEffort === void 0 ? {} : { reasoningEffort }
		},
		setup: async (agentCtx) => {
			if (requestedPreset !== void 0) await ctx.agentPresets.mount(agentCtx, requestedPreset);
			else if (caller !== void 0) ctx.agentPresets.composeFrom(agentCtx, caller.ctx);
			if (installModelSelectionCompat(installModelSelection$1, agentCtx, selection)) return;
			agentCtx.on("agent/request", async (payload, next) => {
				const resolved = await next();
				const sel = selection.current;
				if (sel === void 0) return resolved;
				const { reasoningEffort: _drop, ...rest } = resolved;
				return {
					...rest,
					...sel.provider === void 0 ? {} : { provider: sel.provider },
					...sel.model === void 0 ? {} : { model: sel.model },
					...sel.reasoningEffort === void 0 ? {} : { reasoningEffort: sel.reasoningEffort }
				};
			});
		}
	})).agent;
	const workspaceId = await attachSessionToWorkspace(ctx, sessionId, targetCwd) ?? workspaceByPath(ctx, targetCwd);
	registry.record({
		sessionId,
		...typeof options.title === "string" && options.title.trim() !== "" ? { title: options.title.trim() } : {},
		cwd: targetCwd,
		...workspaceId === void 0 ? {} : { workspaceId },
		...provider !== "" ? { provider } : {},
		...model !== "" ? { model } : {},
		source: "create"
	});
	let baselineSeq;
	if (typeof options.prompt === "string" && options.prompt.trim() !== "") {
		baselineSeq = maxSeq(sessionEvents(agent.session));
		agent.followup(userMessage(options.prompt.trim()));
		registry.touch(sessionId);
	}
	return {
		sessionId,
		cwd: targetCwd,
		...workspaceId === void 0 ? {} : { workspaceId },
		agent,
		...baselineSeq === void 0 ? {} : { baselineSeq }
	};
}
//#endregion
//#region src/monitor.ts
/**
* dsh-session-bridge monitor: 线程内的后台守护循环。
* 对一个"主任务会话"按配置间隔轮询其进度（复用 statusSnapshot/规则判定），
* 根据实际情况自动调度——卡住则 steer 催办/纠偏、卡住过久则 cancel 终止、
* 出现完成关键词且空闲则结束监控并留档。可选 LLM 增强：判定是否偏离主题。
* 作为插件自身的组件存在（非独立插件），用 session_bridge_monitor_start/_stop/_list 控制。
*/
const SCAN_MS = 5e3;
/** 循环检测字段（默认只查思维链）。 */
function loopFieldOf(config) {
	const field = config.loopField;
	return field === "text" || field === "both" ? field : "reasoning";
}
function clampInt(value, fallback, min, max) {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.round(value)));
}
function clampFloat(value, fallback, min, max) {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}
/** 检测阈值：非法值一律回落默认（工具层已 clamp 一次，这里兜住内部直接调用）。 */
function loopThresholds(config) {
	return {
		minCycles: clampInt(config.loopMinCycles, LOOP_DEFAULTS.minCycles, 2, 8),
		minRepeats: clampInt(config.loopMinRepeats, LOOP_DEFAULTS.minRepeats, 2, 20),
		minConfidence: clampFloat(config.loopMinConfidence, LOOP_DEFAULTS.minConfidence, .1, 1),
		charN: LOOP_DEFAULTS.charN,
		charRepeatRate: LOOP_DEFAULTS.charRepeatRate,
		charMinTokens: LOOP_DEFAULTS.charMinTokens
	};
}
/** 触发冷却窗口：默认 max(intervalMs*2, 30s)。 */
function loopCooldownOf(config) {
	return clampInt(config.loopCooldownMs, Math.max(config.intervalMs * 2, 3e4), 1e3, 36e5);
}
/** 最大转移次数（同时是转移链深度上限）。 */
function loopMaxTransfersOf(config) {
	return clampInt(config.loopMaxTransfers, 3, 1, 50);
}
/** 同一签名连续命中多少次才触发。 */
function loopMinHitsOf(config) {
	return clampInt(config.loopMinHits, 1, 1, 100);
}
/** 空循环守卫状态。 */
function emptyLoopState() {
	return {
		fields: {},
		transfers: [],
		lastAttemptAt: null,
		subagentCancels: 0
	};
}
function dshLogFile(override) {
	if (override !== void 0 && override !== "") return override;
	return join(process.env.DSH_HOME || join(homedir(), ".dsh"), "super-injector", "dsh-session-bridge-monitor.log");
}
var SessionMonitor = class {
	entries = /* @__PURE__ */ new Map();
	timer;
	logFile;
	ctx;
	registry;
	policy;
	constructor(ctx, registry, logFile, policy) {
		this.ctx = ctx;
		this.registry = registry;
		this.logFile = dshLogFile(logFile);
		this.policy = policy;
	}
	/**
	* 本 tick 是否做循环检测：单次 monitor 参数（loopGuard=false）与插件级总开关
	* （设置页/命令）任意一个关闭即不做。总开关实时读 volatile 引用，所以已运行的守护也立即停手。
	*/
	loopEnabled(entry) {
		if (entry.config.loopGuard === false) return false;
		return this.policy === void 0 ? true : this.policy.enabled();
	}
	/** 守护没显式传的 loop* 参数，用插件配置里的全局默认值补齐（参数类改动从下一个 start 生效）。 */
	applyPolicyDefaults(config) {
		const policy = this.policy;
		if (policy === void 0) return config;
		const defaults = policy.defaults();
		return {
			...config,
			loopField: config.loopField ?? defaults.field,
			loopMinCycles: config.loopMinCycles ?? defaults.minCycles,
			loopMinRepeats: config.loopMinRepeats ?? defaults.minRepeats,
			loopMinConfidence: config.loopMinConfidence ?? defaults.minConfidence,
			loopMinHits: config.loopMinHits ?? defaults.minHits,
			loopCooldownMs: config.loopCooldownMs ?? defaults.cooldownMs,
			loopMaxTransfers: config.loopMaxTransfers ?? defaults.maxTransfers,
			loopDescendants: config.loopDescendants ?? defaults.descendants
		};
	}
	/** 启动对一个会话的监控（幂等：已存在则更新配置）。 */
	start(rawConfig) {
		const config = this.applyPolicyDefaults(rawConfig);
		const existing = this.entries.get(config.sessionId);
		const now = Date.now();
		const cotInit = { rules: (config.coTRules ?? []).reduce((acc, rule, index) => {
			const key = String(index) + ":" + rule.match + ":" + rule.field + ":" + rule.value;
			acc[key] = {
				hits: 0,
				lastFiredAt: null,
				lastMatch: false,
				lastSubject: ""
			};
			return acc;
		}, {}) };
		const entry = existing !== void 0 ? {
			...existing,
			config,
			lastTickAt: now
		} : {
			config,
			startedAt: now,
			lastTickAt: now,
			stuckCount: 0,
			lastAction: "none",
			lastActionAt: null,
			lastNote: "监控已启动",
			done: false,
			cycles: 0,
			cot: cotInit,
			loop: emptyLoopState()
		};
		if (entry.cot === void 0) entry.cot = cotInit;
		if (entry.loop === void 0) entry.loop = emptyLoopState();
		this.entries.set(config.sessionId, entry);
		this.ensureTimer();
		this.log(entry, "monitor start session=" + config.sessionId + " interval=" + config.intervalMs + " stalled=" + String(config.stalledMs ?? 6e4) + " maxStuck=" + String(config.maxStuckCycles ?? 3) + this.loopSummary(config));
		return entry;
	}
	/** 启动日志里的循环守卫摘要。 */
	loopSummary(config) {
		if (config.loopGuard === false) return " loop=off";
		if (this.policy !== void 0 && !this.policy.enabled()) return " loop=off(plugin)";
		const thresholds = loopThresholds(config);
		const depth = clampInt(config.loopTransferDepth, 0, 0, 1e3);
		return " loop=" + loopFieldOf(config) + "/" + String(thresholds.minCycles) + "x" + String(thresholds.minRepeats) + "@" + thresholds.minConfidence.toFixed(2) + " descendants=" + (config.loopDescendants ?? "report") + (config.loopTransfer === false ? " transfer=off" : " maxTransfers=" + String(loopMaxTransfersOf(config))) + (depth === 0 ? "" : " depth=" + String(depth));
	}
	/** 停止对一个会话的监控。返回是否存在。 */
	stop(sessionId) {
		const existed = this.entries.delete(sessionId);
		if (this.entries.size === 0) this.disposeTimer();
		if (existed) this.stderr("[dsh-session-bridge] monitor stop session=" + sessionId);
		return existed;
	}
	/** 全部活动监控快照。 */
	list() {
		return [...this.entries.values()].map((e) => ({
			...e,
			config: { ...e.config }
		}));
	}
	/** 移除所有监控（插件卸载用）。 */
	dispose() {
		this.disposeTimer();
		this.entries.clear();
	}
	/** 立即触发一轮扫描（测试/手动）：绕过 interval 节流，强制评估每个活动条目。 */
	async tickNow() {
		await this.tick(true);
	}
	ensureTimer() {
		if (this.timer !== void 0) return;
		const timer = this.ctx;
		this.timer = timer.setInterval(() => {
			this.tick().catch((error) => {
				this.stderr("[dsh-session-bridge] monitor tick error: " + String(error));
			});
		}, SCAN_MS);
	}
	disposeTimer() {
		if (this.timer === void 0) return;
		const ctx = this.ctx;
		try {
			ctx.clearInterval(this.timer);
		} catch {}
		this.timer = void 0;
	}
	/**
	* 一轮扫描。force=true 忽略 interval 节流（tickNow 用）。
	* 遍历用快照：循环转移会在 tickEntry 里新增（新会话）与删除（原会话）条目，
	* 直接迭代 Map 会让新条目在同一个 tick 里被重复评估。
	*/
	async tick(force = false) {
		const now = Date.now();
		for (const entry of [...this.entries.values()]) {
			if (entry.done) continue;
			if (!this.entries.has(entry.config.sessionId)) continue;
			if (!force && now - entry.lastTickAt < entry.config.intervalMs) continue;
			entry.lastTickAt = now;
			entry.cycles += 1;
			await this.tickEntry(entry);
		}
	}
	async tickEntry(entry) {
		const { sessionId } = entry.config;
		const agent = getLiveAgent(this.ctx, sessionId);
		if (agent === void 0) {
			entry.stuckCount += 1;
			entry.lastAction = "lost";
			entry.lastActionAt = Date.now();
			entry.lastNote = "目标会话离线（不在 live）";
			this.log(entry, "target not live; stuck=" + entry.stuckCount);
			if (this.shouldCancel(entry)) this.doCancel(entry, "目标会话离线");
			return;
		}
		const snapshot = statusSnapshot(this.ctx, agent);
		if (this.isDone(entry, snapshot)) {
			entry.done = true;
			entry.lastAction = "done";
			entry.lastActionAt = Date.now();
			entry.lastNote = "检测到完成信号，监控结束";
			this.log(entry, "DONE → stop monitor");
			this.stopWithLog(sessionId);
			return;
		}
		if (snapshot.running !== "running" && !snapshot.pendingWork) {
			entry.done = true;
			entry.lastAction = "done";
			entry.lastActionAt = Date.now();
			entry.lastNote = "目标已空闲且无待处理，监控收尾";
			this.log(entry, "IDLE no-pending → stop monitor (settled)");
			this.stopWithLog(sessionId);
			return;
		}
		if (snapshot.running === "running" && this.loopEnabled(entry)) {
			if (await this.evaluateLoopGuard(entry, snapshot, agent)) return;
		}
		if (isStalled(snapshot.running, snapshot.stalledMs, entry.config.stalledMs ?? 6e4)) {
			entry.stuckCount += 1;
			entry.lastActionAt = Date.now();
			if (this.shouldCancel(entry)) {
				this.doCancel(entry, "卡住超过 " + entry.config.maxStuckCycles + " 次");
				return;
			}
			if (entry.config.useLlm === true && this.hasLlm()) {
				const offtrack = await this.judgeOffTrack(entry, snapshot, agent.options);
				if (offtrack === "offtrack") {
					const steer = entry.config.onOffTrackSteer ?? "检测到任务偏离主题，请回到原始目标继续，并简要说明你下一步怎么做。";
					sendLiveMessage(this.ctx, sessionId, steer, "steer");
					entry.lastAction = "offtrack";
					entry.lastNote = "LLM 判定偏离主题，已 steer 纠偏";
					entry.stuckCount = 0;
					this.log(entry, "OFFTRACK → steer: " + steer);
					return;
				}
				if (offtrack === "stuck") {
					const steer = entry.config.onStallSteer ?? "较长一段时间没有实质进展，请简明汇报当前进度并继续推进任务。";
					sendLiveMessage(this.ctx, sessionId, steer, "steer");
					entry.lastAction = "steer";
					entry.lastNote = "LLM 判定卡住，已 steer 催办";
					this.log(entry, "STUCK → steer: " + steer);
					return;
				}
				entry.lastAction = "steady";
				entry.lastNote = "LLM 判定仍在推进";
				entry.stuckCount = 0;
				this.log(entry, "LLM verdict=steady; reset stuck");
				return;
			}
			const steer = entry.config.onStallSteer ?? "较长一段时间没有实质进展，请简明汇报当前进度并继续推进任务。";
			sendLiveMessage(this.ctx, sessionId, steer, "steer");
			entry.lastAction = "steer";
			entry.lastNote = "卡住 " + entry.stuckCount + " 次，已 steer 催办";
			this.log(entry, "STALL(#" + entry.stuckCount + ") → steer: " + steer);
			return;
		}
		if (this.evaluateCoTRules(entry, snapshot, sessionId)) return;
		if (entry.stuckCount !== 0) entry.stuckCount = 0;
		entry.lastAction = "steady";
		entry.lastActionAt = Date.now();
		entry.lastNote = "正常推进（lastActivity now-" + String(snapshot.stalledMs ?? "?") + "ms）";
		this.log(entry, "steady; lastActivity now-" + String(snapshot.stalledMs ?? "?") + "ms");
	}
	shouldCancel(entry) {
		return entry.stuckCount >= (entry.config.maxStuckCycles ?? 3);
	}
	doCancel(entry, reason) {
		cancelLiveSession(this.ctx, entry.config.sessionId, false, reason);
		entry.lastAction = "cancel";
		entry.lastActionAt = Date.now();
		entry.lastNote = "连续卡住，已 cancel 终止: " + reason;
		this.log(entry, "CANCEL session=" + entry.config.sessionId + " reason=" + reason);
	}
	isDone(entry, snapshot) {
		const keywords = entry.config.doneKeywords ?? [];
		if (keywords.length === 0) return false;
		if (snapshot.running === "running") return false;
		const text = `${snapshot.lastAssistantText ?? ""}\n${snapshot.recent.map((r) => r.text ?? "").join("\n")}`;
		if (!text) return false;
		return keywords.some((kw) => kw !== "" && text.includes(kw));
	}
	/**
	* 评估思维链（CoT）规则。规则只对 live 会话有意义：running 时用进行中的
	* reasoning-delta 流，空闲时回落到已定型 lastReasoning。not-contains 规则作用在
	* reasoning 字段时，若该会话本就没有推理（非推理模型/尚未产出），不判定为命中，
	* 避免误 cancel 一个根本不产生思维链的会话。
	* @returns true 表示本 tick 已被某条规则触发并处理（steer/cancel），调用方应 return。
	*/
	evaluateCoTRules(entry, snapshot, sessionId) {
		const rules = entry.config.coTRules ?? [];
		if (rules.length === 0) return false;
		const minHits = entry.config.cotMinHits ?? 1;
		const hasLive = (snapshot.liveReasoning ?? "") !== "";
		const subject = {
			reasoning: snapshot.liveReasoning ?? snapshot.lastReasoning ?? "",
			text: snapshot.lastAssistantText ?? "",
			hasReasoning: hasLive || (snapshot.lastReasoning ?? "") !== ""
		};
		const now = Date.now();
		const rulesState = entry.cot;
		let engaged = false;
		rules.forEach((rule, index) => {
			if (engaged) return;
			const key = String(index) + ":" + rule.match + ":" + rule.field + ":" + rule.value;
			const st = rulesState.rules[key] ?? {
				hits: 0,
				lastFiredAt: null,
				lastMatch: false
			};
			if (rule.field === "reasoning" && rule.match === "not-contains" && !subject.hasReasoning) {
				st.lastMatch = false;
				st.hits = 0;
				return;
			}
			let hit;
			if (rule.field === "reasoning") hit = rule.match === "contains" ? subject.reasoning.includes(rule.value) : !subject.reasoning.includes(rule.value);
			else if (rule.field === "text") hit = rule.match === "contains" ? subject.text.includes(rule.value) : !subject.text.includes(rule.value);
			else {
				const reasonHas = subject.reasoning.includes(rule.value);
				const textHas = subject.text.includes(rule.value);
				hit = rule.match === "contains" ? reasonHas || textHas : !reasonHas && !textHas;
			}
			st.lastMatch = hit;
			st.hits = hit ? st.hits + 1 : 0;
			this.log(entry, "CoT rule " + key + " hit=" + String(hit) + " hits=" + String(st.hits) + "/" + String(minHits));
			if (!(hit && st.hits >= minHits)) return;
			const coolMs = Math.max(entry.config.intervalMs, 5e3) * 2;
			if (st.lastFiredAt !== null && now - st.lastFiredAt < coolMs) return;
			st.lastFiredAt = now;
			if (rule.action === "cancel") {
				const reason = "reasoning-rule:" + rule.value;
				cancelLiveSession(this.ctx, sessionId, false, reason);
				entry.lastAction = "cot-cancel";
				entry.lastActionAt = Date.now();
				entry.lastNote = "思维链规则触发 cancel: " + rule.value;
				entry.stuckCount = 0;
				this.log(entry, "COT-CANCEL session=" + sessionId + " rule=" + key + " value=" + rule.value);
			} else {
				const steer = rule.message !== void 0 && rule.message.trim() !== "" ? rule.message.trim() : "监控判定：思维链/回复匹配规则「" + rule.value + "」，请据此调整方向并继续推进任务。";
				sendLiveMessage(this.ctx, sessionId, steer, "steer");
				entry.lastAction = "cot-steer";
				entry.lastActionAt = Date.now();
				entry.lastNote = "思维链规则触发 steer: " + rule.value;
				entry.stuckCount = 0;
				this.log(entry, "COT-STEER session=" + sessionId + " rule=" + key + " steer=" + steer);
			}
			engaged = true;
			st.hits = 0;
		});
		return engaged;
	}
	/**
	* 思维链循环守卫：目标会话的思维链陷入**序列循环**（同一段内容被反复输出，例如
	* "写。好。Go。写。好。Go。写。好。Go。"）时，中断它并把任务转移到新会话继续；
	* 同时顺带照看它派生的子代理（见 evaluateSubagentLoops）。
	*
	* 只在 running 时评估：空闲会话没有"正在循环"的思维链，而且 loop 检测吃的是
	* 实时推理增量（reasoning-delta），空闲时那份增量为空。
	* @returns true 表示本 tick 已处理（转移或中断），调用方应 return。
	*/
	async evaluateLoopGuard(entry, snapshot, agent) {
		const config = entry.config;
		const subagentHandled = config.loopDescendants !== "ignore" ? this.evaluateSubagentLoops(entry, agent) : false;
		const field = loopFieldOf(config);
		const thresholds = loopThresholds(config);
		const reasoning = (snapshot.liveReasoning ?? "") !== "" ? snapshot.liveReasoning ?? "" : snapshot.lastReasoning ?? "";
		const text = snapshot.lastAssistantText ?? "";
		let hit = null;
		if (field === "reasoning" || field === "both") {
			const signal = detectLoop(reasoning, thresholds);
			if (signal.detected) hit = {
				field: "reasoning",
				signal
			};
		}
		if (hit === null && (field === "text" || field === "both")) {
			const signal = detectLoop(text, thresholds);
			if (signal.detected) hit = {
				field: "text",
				signal
			};
		}
		if (hit === null) return subagentHandled;
		const now = Date.now();
		const signature = hit.field + "|" + String(hit.signal.period) + "|" + hit.signal.unit;
		const prev = entry.loop.fields[hit.field];
		const state = prev ?? {
			signature: "",
			hits: 0,
			lastFiredAt: null,
			lastSignal: null
		};
		state.hits = prev !== void 0 && prev.signature === signature ? prev.hits + 1 : 1;
		state.signature = signature;
		state.lastSignal = hit.signal;
		entry.loop.fields[hit.field] = state;
		const minHits = loopMinHitsOf(config);
		const reason = "chain-of-thought loop: field=" + hit.field + " period=" + String(hit.signal.period) + " repeats=" + String(hit.signal.repeats) + " confidence=" + hit.signal.confidence.toFixed(2) + (hit.signal.unit === "" ? "" : " unit=" + JSON.stringify(hit.signal.unit.slice(0, 60)));
		this.log(entry, "LOOP-HIT field=" + hit.field + " period=" + String(hit.signal.period) + " repeats=" + String(hit.signal.repeats) + " confidence=" + hit.signal.confidence.toFixed(2) + " hits=" + String(state.hits) + "/" + String(minHits));
		if (state.hits < minHits) return false;
		const cooldown = loopCooldownOf(config);
		if (state.lastFiredAt !== null && now - state.lastFiredAt < cooldown) {
			this.log(entry, "LOOP-HIT suppressed by cooldown (" + String(now - state.lastFiredAt) + "ms < " + String(cooldown) + "ms)");
			return false;
		}
		state.lastFiredAt = now;
		state.hits = 0;
		if (isRootAgent(this.ctx, config.sessionId) === false) {
			this.loopCancel(entry, reason + " [subagent session → no transfer]");
			this.notifyParent(entry, agent, config.sessionId, reason);
			return true;
		}
		const depth = clampInt(config.loopTransferDepth, 0, 0, 1e3);
		const maxTransfers = loopMaxTransfersOf(config);
		if (config.loopTransfer === false) {
			this.loopCancel(entry, reason + " [transfer disabled]");
			return true;
		}
		if (entry.loop.transfers.length >= maxTransfers || depth >= maxTransfers) {
			this.loopCancel(entry, reason + " [transfer budget exhausted: " + String(entry.loop.transfers.length) + "/" + String(maxTransfers) + ", depth " + String(depth) + "]");
			return true;
		}
		return await this.transferToNewSession(entry, agent, reason, hit.signal, depth);
	}
	/**
	* 把任务转移到新会话：**先建新会话**（带交接提示），确认成功后再中断原会话——
	* 反过来的话，创建失败就变成"任务被中断、且没有任何接续"，那是丢任务。
	* 任一步失败都保持原监控，并按 interval 节流重试。
	*/
	async transferToNewSession(entry, agent, reason, signal, depth) {
		const config = entry.config;
		const oldId = config.sessionId;
		const now = Date.now();
		const retryMs = Math.max(config.intervalMs, 1e4);
		if (entry.loop.lastAttemptAt !== null && now - entry.loop.lastAttemptAt < retryMs) return false;
		entry.loop.lastAttemptAt = now;
		const descendants = config.loopDescendants === "ignore" ? [] : collectDescendants(this.ctx, agent);
		const stopped = [];
		if (config.loopDescendants === "stop") for (const child of descendants) {
			if (!child.running) continue;
			if (cancelLiveSession(this.ctx, child.id, false, "loop transfer: stop descendant")) {
				stopped.push(child.id);
				this.log(entry, "LOOP-SUBAGENT-CANCEL id=" + child.id + " reason=transfer-stop");
			}
		}
		const context = extractTaskContext(sessionEvents(agent.session));
		const handoff = buildHandoffPrompt({
			sessionId: oldId,
			cwd: agent.session.header.cwd ?? "",
			reason,
			context,
			descendants,
			stopped,
			...config.loopHandoffPrompt === void 0 ? {} : { template: config.loopHandoffPrompt }
		});
		let created;
		try {
			created = await createBridgeSession(this.ctx, this.registry, {
				caller: {
					ctx: agent.ctx,
					session: agent.session
				},
				callerCwd: agent.session.header.cwd,
				title: (config.label ?? "session") + " (loop-transfer)",
				prompt: handoff
			});
		} catch (error) {
			entry.lastNote = "循环转移失败（保持原监控）: " + String(error);
			this.log(entry, "LOOP-TRANSFER-FAILED from=" + oldId + " error=" + String(error));
			return true;
		}
		entry.loop.transfers.push({
			at: now,
			from: oldId,
			to: created.sessionId,
			reason,
			period: signal.period,
			repeats: signal.repeats,
			confidence: signal.confidence,
			depth,
			descendants: descendants.map((item) => ({
				id: item.id,
				status: item.status,
				...item.task === void 0 ? {} : { task: item.task }
			})),
			stopped
		});
		this.log(entry, "LOOP-TRANSFER from=" + oldId + " to=" + created.sessionId + " depth=" + String(depth) + " descendants=" + String(descendants.length) + " stopped=" + String(stopped.length));
		this.stderr("[dsh-session-bridge] monitor loop-transfer " + oldId + " → " + created.sessionId);
		cancelLiveSession(this.ctx, oldId, false, "chain-of-thought loop detected");
		entry.lastAction = "loop-transfer";
		entry.lastActionAt = Date.now();
		entry.lastNote = "思维链循环，已转移到新会话 " + created.sessionId;
		if (config.loopAutoMonitor !== false) {
			const next = this.start({
				...config,
				sessionId: created.sessionId,
				label: (config.label ?? "session") + " (loop-transfer)",
				loopTransferDepth: depth + 1
			});
			next.loop.transfers = entry.loop.transfers;
			next.loop.subagentCancels = entry.loop.subagentCancels;
		}
		this.entries.delete(oldId);
		if (this.entries.size === 0) this.disposeTimer();
		return true;
	}
	/**
	* 照看目标会话派生的子代理：某个子代理的思维链陷入循环时，终止**那个子代理**，
	* 并 steer 主会话告知需要重派。
	*
	* 刻意不在这里做转移：子代理被终止不会打断主会话的执行树，而"子代理也各开一个新
	* 会话接续"会与主会话的转移叠加，导致重复劳动与递归级联（每个新会话又派生新子代理）。
	* 默认只查思维链（子代理的产出通常就是它的推理）。
	*/
	evaluateSubagentLoops(entry, agent) {
		const descendants = collectDescendants(this.ctx, agent);
		if (descendants.length === 0) return false;
		let handled = false;
		const config = entry.config;
		const thresholds = loopThresholds(config);
		const minHits = loopMinHitsOf(config);
		const cooldown = loopCooldownOf(config);
		const now = Date.now();
		for (const child of descendants) {
			if (!child.running) continue;
			const childAgent = getLiveAgent(this.ctx, child.id);
			if (childAgent === void 0) continue;
			const snapshot = statusSnapshot(this.ctx, childAgent);
			const signal = detectLoop((snapshot.liveReasoning ?? "") !== "" ? snapshot.liveReasoning ?? "" : snapshot.lastReasoning ?? "", thresholds);
			if (!signal.detected) continue;
			const key = "subagent:" + child.id;
			const signature = String(signal.period) + "|" + signal.unit;
			const prev = entry.loop.fields[key];
			const state = prev ?? {
				signature: "",
				hits: 0,
				lastFiredAt: null,
				lastSignal: null
			};
			state.hits = prev !== void 0 && prev.signature === signature ? prev.hits + 1 : 1;
			state.signature = signature;
			state.lastSignal = signal;
			entry.loop.fields[key] = state;
			if (state.hits < minHits) continue;
			if (state.lastFiredAt !== null && now - state.lastFiredAt < cooldown) continue;
			state.lastFiredAt = now;
			state.hits = 0;
			if (!cancelLiveSession(this.ctx, child.id, false, "chain-of-thought loop (subagent)")) continue;
			entry.loop.subagentCancels += 1;
			entry.lastAction = "loop-subagent-cancel";
			entry.lastActionAt = now;
			entry.lastNote = "子代理 " + child.id + " 思维链循环，已终止并通知主会话重派";
			this.log(entry, "LOOP-SUBAGENT-CANCEL id=" + child.id + " period=" + String(signal.period) + " repeats=" + String(signal.repeats) + " confidence=" + signal.confidence.toFixed(2));
			sendLiveMessage(this.ctx, config.sessionId, "你的子代理 " + child.id + " 的思维链陷入循环（period=" + String(signal.period) + " repeats=" + String(signal.repeats) + "），已被终止。请按原分工重新派生它，或自己完成那部分工作。", "steer");
			handled = true;
		}
		return handled;
	}
	/** 循环触发但无法/不该转移时：只中断原会话。 */
	loopCancel(entry, reason) {
		cancelLiveSession(this.ctx, entry.config.sessionId, false, reason);
		entry.lastAction = "loop-cancel";
		entry.lastActionAt = Date.now();
		entry.lastNote = "思维链循环，已中断: " + reason;
		this.log(entry, "LOOP-CANCEL session=" + entry.config.sessionId + " reason=" + reason);
	}
	/** 子代理会话自身循环被中断后，通知它的父会话（若父仍在 live）。 */
	notifyParent(entry, agent, childId, reason) {
		const parentId = agent.session.header.parentSession;
		if (parentId === void 0 || parentId === "") return;
		if (sendLiveMessage(this.ctx, parentId, "你的子代理 " + childId + " 的思维链陷入循环（" + reason + "），已被终止。请按原分工重新派生它，或自己完成那部分工作。", "steer")) this.log(entry, "LOOP-SUBAGENT-NOTIFY parent=" + parentId + " child=" + childId);
	}
	hasLlm() {
		return this.ctx.llm !== void 0;
	}
	/** LLM 判定当前状态：'stuck' | 'offtrack' | 'steady'。失败回落 'steady'。 */
	async judgeOffTrack(entry, snapshot, route) {
		const ctx = this.ctx;
		if (ctx.llm === void 0) return "steady";
		const provider = route.provider;
		const model = route.model;
		if (provider === void 0 || model === void 0) return "steady";
		const recentText = snapshot.recent.map((r) => (r.role === "user" ? "[user]" : "[assistant]") + " " + (r.text ?? r.reasoning ?? "")).join("\n").slice(-1200);
		try {
			let text = "";
			const stream = ctx.llm.stream({
				provider,
				model,
				system: "你是任务监控 agent。给定一个主任务会话的最新消息流，判定它当前处于哪种状态，只输出一个词：stuck（很久无实质进展）/ offtrack（明显偏离原始目标）/ steady（正常推进）。",
				messages: [createUserMessage({
					source: { kind: "user" },
					content: [{
						type: "text",
						text: recentText
					}]
				})],
				temperature: 0,
				reasoningEffort: ReasoningEffortId$1("off"),
				maxTokens: 40
			});
			for await (const chunk of stream) if (chunk.type === "text-delta") text += chunk.text;
			const verdict = text.trim().toLowerCase();
			if (verdict.startsWith("stuck")) return "stuck";
			if (verdict.startsWith("offtrack")) return "offtrack";
			return "steady";
		} catch {
			return "steady";
		}
	}
	stopWithLog(sessionId) {
		this.stderr("[dsh-session-bridge] monitor session=" + sessionId + " marked done");
		this.entries.delete(sessionId);
		if (this.entries.size === 0) this.disposeTimer();
	}
	log(entry, msg) {
		try {
			mkdirSync(dirname(this.logFile), { recursive: true });
			appendFileSync(this.logFile, `[${(/* @__PURE__ */ new Date()).toISOString()}] session=${entry.config.sessionId} lastReply=${entry.config.label ?? ""} ${msg}\n`);
		} catch {}
	}
	stderr(msg) {
		try {
			console.warn(msg);
		} catch {}
	}
};
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-tools@0.2.2-alpha.3_db698fec014e3667df9194d0bfe272ee/node_modules/@deepseek-ai/dsh-tools/lib/shared-DTdn5dXO.js
/** The selected provider is missing or unloaded; another provider must not take its calls. */
var ToolExecutorUnavailableError = class extends HarnessError {
	constructor() {
		super("The selected tool executor is unavailable. Load an executor in this composition before running the agent.", "TOOL_EXECUTOR_UNAVAILABLE");
		this.name = "ToolExecutorUnavailableError";
	}
};
/**
* Enforced JSON Schema subset shared by tool outputs, generated PTC mode
* types, subagents, and workflows. The subset accepts any JSON root, an
* annotation-only schema for unconstrained JSON, one scalar `type`, object
* `properties`/`required`/boolean `additionalProperties`, array `items`,
* type-correct scalar `enum`/`const`, and exact-one `oneOf`.
*
* Unsupported or misplaced keywords reject rather than being accepted without
* enforcement. Consumers that require an object root apply
* {@link assertObjectJsonSchema} before accepting input.
* @module dsh-tools/json-schema
*/
/**
* Thrown when a raw schema falls outside the enforced subset. `violations`
* lists every offending path instead of stopping at the first author error.
*/
var JsonSchemaError = class extends HarnessError {
	/** Individual schema violations in walk order. */
	violations;
	constructor(violations) {
		super(`unsupported JSON schema: ${violations.join("; ")}`, "UNSUPPORTED_SCHEMA");
		this.name = "JsonSchemaError";
		this.violations = violations;
	}
};
const CONSTRAINT_KEYWORDS = /* @__PURE__ */ new Set([
	"type",
	"oneOf",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"enum",
	"const"
]);
const ANNOTATION_KEYWORDS = /* @__PURE__ */ new Set([
	"description",
	"title",
	"default",
	"examples"
]);
const SCHEMA_TYPES = [
	"object",
	"array",
	"string",
	"number",
	"integer",
	"boolean",
	"null"
];
/** Whether a realm-owned intrinsic prototype is backed by its native constructor. */
function hasIntrinsicConstructor(prototype, name) {
	const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
	if (typeof constructor !== "function") return false;
	try {
		return constructor.name === name && constructor.prototype === prototype && Function.prototype.toString.call(constructor) === `function ${name}() { [native code] }`;
	} catch {
		return false;
	}
}
/** Whether a candidate is one realm's intrinsic `Object.prototype`. */
function isIntrinsicObjectPrototype(value) {
	return Object.getPrototypeOf(value) === null && hasIntrinsicConstructor(value, "Object");
}
/**
* Test for a realm-agnostic plain JSON record without accepting arrays or
* exotic objects.
* @param value - candidate record from any JavaScript realm.
* @returns Whether the value has a plain-object prototype chain.
*/
function isPlainJsonRecord(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	try {
		const prototype = Object.getPrototypeOf(value);
		return prototype === null || typeof prototype === "object" && isIntrinsicObjectPrototype(prototype);
	} catch {
		return false;
	}
}
/** Whether an array uses one realm's intrinsic `Array.prototype`. */
function hasPlainArrayPrototype(value) {
	const prototype = Object.getPrototypeOf(value);
	if (!Array.isArray(prototype) || !hasIntrinsicConstructor(prototype, "Array")) return false;
	const objectPrototype = Object.getPrototypeOf(prototype);
	return typeof objectPrototype === "object" && objectPrototype !== null && isIntrinsicObjectPrototype(objectPrototype);
}
/** Return whether a record contains only own enumerable string keys. */
function hasOnlyEnumerableStringKeys(value) {
	try {
		return Reflect.ownKeys(value).every((key) => typeof key === "string" && Object.prototype.propertyIsEnumerable.call(value, key));
	} catch {
		return false;
	}
}
/**
* Test for an ordinary schema record whose keys survive JSON projection.
* @param value - candidate record from any JavaScript realm.
* @returns Whether the record has an intrinsic prototype and only own enumerable string keys.
*/
function isJsonSchemaRecord(value) {
	return isPlainJsonRecord(value) && hasOnlyEnumerableStringKeys(value);
}
/**
* Test for a dense ordinary array with no JSON-invisible decorations.
* @param value - candidate array from any JavaScript realm.
* @returns Whether the array is intrinsic, dense, and undecorated.
*/
function isPlainJsonArray(value) {
	if (!Array.isArray(value)) return false;
	try {
		if (!hasPlainArrayPrototype(value) || Reflect.ownKeys(value).length !== value.length + 1) return false;
		for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) return false;
		return true;
	} catch {
		return false;
	}
}
/** Lossless finite JSON number, excluding negative zero. */
function isJsonNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0);
}
/** Whether a scalar is valid for one declared schema type. */
function scalarMatches(type, value) {
	switch (type) {
		case "string": return typeof value === "string";
		case "number": return isJsonNumber(value);
		case "integer": return isJsonNumber(value) && Number.isInteger(value);
		case "boolean": return typeof value === "boolean";
		case "null": return value === null;
		/* v8 ignore next -- JsonSchemaScalarType is closed; this retains compile-time exhaustiveness. */
		default: return assertNever(type, "JsonSchemaType");
	}
}
/** Keywords that are invalid beside `oneOf`. */
const ONE_OF_SIBLING_KEYWORDS = [
	"properties",
	"required",
	"additionalProperties",
	"items",
	"enum",
	"const"
];
/** Validate object-only fields after its property schemas have been visited. */
function checkObjectSchemaTail(node, path, properties, violations) {
	const hasRequired = Object.hasOwn(node, "required");
	const required = hasRequired ? node.required : void 0;
	if (hasRequired) if (!isPlainJsonArray(required) || required.some((entry) => typeof entry !== "string")) violations.push(`${path}.required must be an array of strings`);
	else {
		const declared = isJsonSchemaRecord(properties) ? properties : {};
		for (const key of required) if (!Object.hasOwn(declared, key)) violations.push(`${path}.required names "${key}" which is not in properties`);
	}
	if (Object.hasOwn(node, "additionalProperties") && typeof node.additionalProperties !== "boolean") violations.push(`${path}.additionalProperties must be a boolean`);
}
/** Collect every violation for one raw schema tree without using the JavaScript call stack. */
function checkSchemaNode(root, rootPath, violations, seen) {
	const tasks = [{
		kind: "enter",
		node: root,
		path: rootPath
	}];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (task.kind === "leave") {
			seen.delete(task.node);
			continue;
		}
		if (task.kind === "one-of-tail") {
			for (const key of ONE_OF_SIBLING_KEYWORDS) if (Object.hasOwn(task.node, key)) violations.push(`${task.path}.${key} is not supported beside oneOf`);
			continue;
		}
		if (task.kind === "object-tail") {
			checkObjectSchemaTail(task.node, task.path, task.properties, violations);
			continue;
		}
		const { node, path } = task;
		if (!isJsonSchemaRecord(node)) {
			violations.push(`${path} must be a schema object`);
			continue;
		}
		if (seen.has(node)) {
			violations.push(`${path} is circular`);
			continue;
		}
		seen.add(node);
		tasks.push({
			kind: "leave",
			node
		});
		for (const key of Object.keys(node)) {
			if (CONSTRAINT_KEYWORDS.has(key)) continue;
			if (ANNOTATION_KEYWORDS.has(key)) {
				try {
					if (!isJsonValue(node[key])) violations.push(`${path}.${key} annotation must be lossless JSON data`);
				} catch {
					violations.push(`${path}.${key} annotation must be lossless JSON data`);
				}
				continue;
			}
			violations.push(`${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`);
		}
		if (Object.hasOwn(node, "description") && typeof node.description !== "string") violations.push(`${path}.description must be a string`);
		if (Object.hasOwn(node, "title") && typeof node.title !== "string") violations.push(`${path}.title must be a string`);
		const hasType = Object.hasOwn(node, "type");
		const hasOneOf = Object.hasOwn(node, "oneOf");
		if (hasType && hasOneOf) {
			violations.push(`${path} cannot declare both type and oneOf`);
			continue;
		}
		if (!hasType && !hasOneOf) {
			for (const key of ONE_OF_SIBLING_KEYWORDS) if (Object.hasOwn(node, key)) violations.push(`${path}.${key} requires type or oneOf`);
			continue;
		}
		if (hasOneOf) {
			const oneOf = node.oneOf;
			tasks.push({
				kind: "one-of-tail",
				node,
				path
			});
			if (!isPlainJsonArray(oneOf) || oneOf.length < 2) violations.push(`${path}.oneOf must be an array of at least two schemas`);
			else for (let index = oneOf.length - 1; index >= 0; index--) tasks.push({
				kind: "enter",
				node: oneOf[index],
				path: `${path}.oneOf[${index}]`
			});
			continue;
		}
		const type = node.type;
		if (typeof type !== "string" || !SCHEMA_TYPES.includes(type)) {
			violations.push(Array.isArray(type) ? `${path}.type must be a single type string (type arrays are not supported)` : `${path}.type must be one of ${SCHEMA_TYPES.join("/")}`);
			continue;
		}
		const schemaType = type;
		for (const [key, types] of Object.entries({
			properties: ["object"],
			required: ["object"],
			additionalProperties: ["object"],
			items: ["array"],
			enum: [
				"string",
				"number",
				"integer",
				"boolean",
				"null"
			],
			const: [
				"string",
				"number",
				"integer",
				"boolean",
				"null"
			]
		})) if (Object.hasOwn(node, key) && !types.includes(schemaType)) violations.push(`${path}.${key} is not supported on type "${schemaType}"`);
		switch (schemaType) {
			case "object": {
				const properties = Object.hasOwn(node, "properties") ? node.properties : void 0;
				tasks.push({
					kind: "object-tail",
					node,
					path,
					properties
				});
				if (Object.hasOwn(node, "properties")) if (!isJsonSchemaRecord(properties)) violations.push(`${path}.properties must be an object of schemas`);
				else {
					const entries = Object.entries(properties);
					for (let index = entries.length - 1; index >= 0; index--) {
						const entry = entries[index];
						/* v8 ignore next -- the loop is bounded by the captured entry count. */
						if (entry === void 0) continue;
						tasks.push({
							kind: "enter",
							node: entry[1],
							path: `${path}.properties.${entry[0]}`
						});
					}
				}
				break;
			}
			case "array":
				if (Object.hasOwn(node, "items")) tasks.push({
					kind: "enter",
					node: node.items,
					path: `${path}.items`
				});
				break;
			case "string":
			case "number":
			case "integer":
			case "boolean":
			case "null": {
				const hasEnum = Object.hasOwn(node, "enum");
				const allowed = hasEnum ? node.enum : void 0;
				const enumValid = isPlainJsonArray(allowed) && allowed.length > 0 && allowed.every((entry) => scalarMatches(schemaType, entry));
				if (hasEnum && !enumValid) violations.push(`${path}.enum must be a non-empty array of ${schemaType} values`);
				const hasConst = Object.hasOwn(node, "const");
				const declaredConst = hasConst ? node.const : void 0;
				const constValid = scalarMatches(schemaType, declaredConst);
				if (hasConst) {
					if (!constValid) violations.push(`${path}.const must be a ${schemaType} value`);
					else if (enumValid && !allowed.includes(declaredConst)) violations.push(`${path}.const must be one of ${path}.enum when both are declared`);
				}
				break;
			}
			/* v8 ignore next -- schemaType was narrowed from the closed SCHEMA_TYPES table above. */
			default: assertNever(schemaType, "JsonSchemaType");
		}
	}
}
/**
* Assert that an arbitrary raw schema uses only the enforced subset.
* Annotation-only schemas are accepted as the standard unconstrained-JSON
* form; callers that require an object root use {@link assertObjectJsonSchema}.
* @param schema - untrusted raw JSON Schema.
* @returns Assertion that the schema belongs to the supported subset.
*/
function assertSupportedJsonSchema(schema) {
	const violations = [];
	checkSchemaNode(schema, "schema", violations, /* @__PURE__ */ new Set());
	if (violations.length > 0) throw new JsonSchemaError(violations);
}
/** Safely test the lossless JSON boundary when a getter may throw. */
function safelyIsJsonValue(value) {
	try {
		return isJsonValue(value);
	} catch {
		return false;
	}
}
/** Root-aware diagnostic path for the parameter validator's empty sentinel. */
function diagnosticPath(path) {
	return path === "" ? "arguments" : path;
}
/** Append one object property without a leading dot at an implicit root. */
function propertyPath(path, key) {
	return path === "" ? key : `${path}.${key}`;
}
/** The generic exception-containment diagnostic owned by one valid schema node. */
function losslessValueViolation(path) {
	return [`"${diagnosticPath(path)}" must be a lossless JSON value`];
}
/** Append diagnostics without spreading a potentially wide child result as call arguments. */
function appendViolations(target, source) {
	for (const violation of source) target.push(violation);
}
/** Initialize one validation frame with empty aggregation state. */
function valueFrame(node, value, path) {
	return {
		node,
		value,
		path,
		catches: false,
		phase: "start",
		children: [],
		childIndex: 0,
		violations: [],
		tailViolations: [],
		matches: 0
	};
}
/** Validate one scalar node after its primitive type check. */
function checkScalarValue(node, value, path) {
	const allowed = Object.hasOwn(node, "enum") ? node.enum : void 0;
	if (allowed !== void 0 && !allowed.includes(value)) return [`"${diagnosticPath(path)}" must be one of ${JSON.stringify(allowed)}`];
	if (Object.hasOwn(node, "const") && value !== node.const) return [`"${diagnosticPath(path)}" must be ${JSON.stringify(node.const)}`];
	return [];
}
/** Validate one trusted schema/value pair with explicit frames rather than recursive calls. */
function checkValue(schema, value, path) {
	const frames = [valueFrame(schema, value, path)];
	let rootResult;
	const receive = (result) => {
		const parent = frames.at(-1);
		if (parent === void 0) {
			rootResult = result;
			return;
		}
		if (parent.kind === "oneOf") {
			if (result.length === 0) parent.matches++;
		} else appendViolations(parent.violations, result);
	};
	const finish = (result) => {
		frames.pop();
		receive(result);
	};
	while (frames.length > 0) {
		const frame = frames.at(-1);
		/* v8 ignore next -- the loop condition guarantees a current frame. */
		if (frame === void 0) break;
		try {
			if (frame.phase === "children") {
				if (frame.childIndex < frame.children.length) {
					const child = frame.children[frame.childIndex];
					/* v8 ignore next -- childIndex is bounded by children.length. */
					if (child === void 0) throw new Error("missing schema-value child frame");
					frame.childIndex++;
					frames.push(valueFrame(child.node, child.value, child.path));
					continue;
				}
				if (frame.kind === "oneOf") {
					finish(frame.matches === 1 ? [] : [`"${diagnosticPath(frame.path)}" must match exactly one oneOf branch (matched ${frame.matches})`]);
					continue;
				}
				appendViolations(frame.violations, frame.tailViolations);
				if (frame.violations.length > 0) finish(frame.violations);
				else if (frame.kind === "object") finish(safelyIsJsonValue(frame.value) ? [] : [`"${diagnosticPath(frame.path)}" must be a lossless JSON object`]);
				else finish(safelyIsJsonValue(frame.value) ? [] : [`"${diagnosticPath(frame.path)}" must be a dense lossless JSON array`]);
				continue;
			}
			const nodeType = Object.hasOwn(frame.node, "type") ? frame.node.type : void 0;
			frame.catches = !(nodeType !== void 0 && !SCHEMA_TYPES.includes(nodeType));
			const oneOf = Object.hasOwn(frame.node, "oneOf") ? frame.node.oneOf : void 0;
			if (oneOf !== void 0) {
				frame.kind = "oneOf";
				frame.children = Array.from(oneOf, (branch) => ({
					node: branch,
					value: frame.value,
					path: frame.path
				}));
				frame.childIndex = 0;
				frame.matches = 0;
				frame.phase = "children";
				continue;
			}
			if (nodeType === void 0) {
				finish(safelyIsJsonValue(frame.value) ? [] : losslessValueViolation(frame.path));
				continue;
			}
			switch (nodeType) {
				case "object": {
					if (!isPlainJsonRecord(frame.value)) {
						finish([`"${diagnosticPath(frame.path)}" must be an object`]);
						break;
					}
					const properties = Object.hasOwn(frame.node, "properties") ? frame.node.properties ?? {} : {};
					const violations = [];
					const required = Object.hasOwn(frame.node, "required") ? frame.node.required ?? [] : [];
					for (const key of required) if (!Object.hasOwn(frame.value, key) || frame.value[key] === void 0) violations.push(`missing required property "${propertyPath(frame.path, key)}"`);
					const children = [];
					for (const [key, child] of Object.entries(properties)) {
						if (!Object.hasOwn(frame.value, key) || frame.value[key] === void 0) continue;
						children.push({
							node: child,
							value: frame.value[key],
							path: propertyPath(frame.path, key)
						});
					}
					const tailViolations = [];
					if (Object.hasOwn(frame.node, "additionalProperties") && frame.node.additionalProperties === false) {
						for (const key of Object.keys(frame.value)) if (!Object.hasOwn(properties, key)) tailViolations.push(`"${propertyPath(frame.path, key)}" is not a declared property (additionalProperties: false)`);
					}
					frame.kind = "object";
					frame.children = children;
					frame.childIndex = 0;
					frame.violations = violations;
					frame.tailViolations = tailViolations;
					frame.phase = "children";
					break;
				}
				case "array": {
					if (!Array.isArray(frame.value)) {
						finish([`"${diagnosticPath(frame.path)}" must be an array`]);
						break;
					}
					const items = Object.hasOwn(frame.node, "items") ? frame.node.items : void 0;
					const children = items === void 0 ? [] : frame.value.flatMap((entry, index) => [{
						node: items,
						value: entry,
						path: `${frame.path}[${index}]`
					}]);
					frame.kind = "array";
					frame.children = children;
					frame.childIndex = 0;
					frame.violations = [];
					frame.phase = "children";
					break;
				}
				case "string":
					finish(typeof frame.value === "string" ? checkScalarValue(frame.node, frame.value, frame.path) : [`"${diagnosticPath(frame.path)}" must be a string`]);
					break;
				case "number":
					finish(typeof frame.value !== "number" ? [`"${diagnosticPath(frame.path)}" must be a number`] : !isJsonNumber(frame.value) ? [`"${diagnosticPath(frame.path)}" must be a finite JSON number`] : checkScalarValue(frame.node, frame.value, frame.path));
					break;
				case "integer":
					finish(!isJsonNumber(frame.value) || !Number.isInteger(frame.value) ? [`"${diagnosticPath(frame.path)}" must be an integer`] : checkScalarValue(frame.node, frame.value, frame.path));
					break;
				case "boolean":
					finish(typeof frame.value === "boolean" ? checkScalarValue(frame.node, frame.value, frame.path) : [`"${diagnosticPath(frame.path)}" must be a boolean`]);
					break;
				case "null":
					finish(frame.value === null ? checkScalarValue(frame.node, frame.value, frame.path) : [`"${diagnosticPath(frame.path)}" must be null`]);
					break;
				default: finish(assertNever(nodeType, "JsonSchemaType"));
			}
		} catch (error) {
			let failed = frames.pop();
			while (failed !== void 0 && !failed.catches) failed = frames.pop();
			if (failed === void 0) throw error;
			receive(losslessValueViolation(failed.path));
		}
	}
	/* v8 ignore next -- every root frame finishes or throws. */
	return rootResult ?? losslessValueViolation(path);
}
/**
* Validate a candidate value against an asserted raw schema. The function is
* total for arbitrary values and returns path-qualified violations.
* @param schema - a schema accepted by {@link assertSupportedJsonSchema}.
* @param value - the candidate JSON value.
* @param path - root label used in diagnostics.
* @returns All violations in walk order; empty means valid.
*/
function validateJsonSchemaValue(schema, value, path = "value") {
	return checkValue(schema, value, path);
}
/** Tool definitions and invocation data shared by registries and executors. @module */
/** Reserved model-facing program transport name. */
const RUN_CODE_NAME = "run_code";
/** Failure to determine a tool's step-time availability. */
var ToolActivationError = class extends HarnessError {
	/**
	* Preserve a condition failure without treating it as normal unavailability.
	* @param name - tool whose condition rejected.
	* @param cause - underlying condition failure.
	*/
	constructor(name, cause) {
		super(`cannot resolve availability of tool "${name}"`, "TOOL_ACTIVATION_FAILED", { cause });
		this.name = "ToolActivationError";
	}
};
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-tools@0.2.2-alpha.3_db698fec014e3667df9194d0bfe272ee/node_modules/@deepseek-ai/dsh-tools/lib/index.js
/** Unified JSON-value schema DSL, inference, compilation, and tool definition helpers. @module dsh-tools/schema */
const ANNOTATION_KEYS = [
	"description",
	"title",
	"default",
	"examples"
];
/** Throw one author-schema violation through the shared schema error type. */
function authorError(message) {
	throw new JsonSchemaError([message]);
}
/** Copy own annotation fields for validation by the raw-schema boundary. */
function copyAnnotations(source, target) {
	if (Object.hasOwn(source, "description")) target.description = source.description;
	if (Object.hasOwn(source, "title")) target.title = source.title;
	if (Object.hasOwn(source, "default")) target.default = source.default;
	if (Object.hasOwn(source, "examples")) target.examples = source.examples;
}
/** Reject author-only keys outside one node's declared vocabulary. */
function assertAuthorKeys(source, path, allowed) {
	for (const key of Object.keys(source)) if (!allowed.includes(key)) authorError(`${path}.${key} is not supported by the value schema DSL`);
}
/** Install a compiled node without giving `__proto__` assignment semantics. */
function assignCompiledNode(destination, node) {
	switch (destination.kind) {
		case "root":
			destination.holder.value = node;
			break;
		case "property":
			Object.defineProperty(destination.target, destination.key, {
				value: node,
				enumerable: true,
				configurable: true,
				writable: true
			});
			break;
		case "item":
			destination.target.items = node;
			break;
		case "one-of": destination.target[destination.index] = node;
	}
}
/** Install a compiled property map at its root or containing object node. */
function assignCompiledPropertyMap(destination, compiled) {
	if (destination.kind === "root") destination.holder.value = compiled;
	else destination.target.properties = compiled.properties;
}
/** Execute an author-schema compilation task graph without recursive descent. */
function runSchemaCompiler(initial) {
	const seen = /* @__PURE__ */ new Set();
	const tasks = [initial];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (task.kind === "leave") {
			seen.delete(task.input);
			continue;
		}
		if (task.kind === "property-map-tail") {
			if (task.required.length > 0) {
				task.compiled.required = task.required;
				if (task.destination.kind === "object") task.destination.target.required = task.required;
			}
			continue;
		}
		if (task.kind === "property") {
			if (!isJsonSchemaRecord(task.property)) authorError(`${task.path} must be a value schema object`);
			if (Object.hasOwn(task.property, "required") && task.property.required !== true) authorError(`${task.path}.required must be true when present`);
			if (Object.hasOwn(task.property, "required") && task.property.required === true) task.required.push(task.key);
			tasks.push({
				kind: "value",
				input: task.property,
				path: task.path,
				allowRequired: true,
				destination: {
					kind: "property",
					target: task.properties,
					key: task.key
				}
			});
			continue;
		}
		if (task.kind === "property-map") {
			if (!isJsonSchemaRecord(task.input)) authorError(`${task.path} must be an object of value schemas`);
			if (seen.has(task.input)) authorError(`${task.path} is circular`);
			seen.add(task.input);
			const compiled = { properties: {} };
			const required = [];
			assignCompiledPropertyMap(task.destination, compiled);
			tasks.push({
				kind: "leave",
				input: task.input
			});
			tasks.push({
				kind: "property-map-tail",
				compiled,
				required,
				destination: task.destination
			});
			const entries = Object.entries(task.input);
			for (let index = entries.length - 1; index >= 0; index--) {
				const entry = entries[index];
				/* v8 ignore next -- the loop is bounded by the captured entry count. */
				if (entry === void 0) continue;
				tasks.push({
					kind: "property",
					property: entry[1],
					path: `${task.path}.${entry[0]}`,
					key: entry[0],
					properties: compiled.properties,
					required
				});
			}
			continue;
		}
		const { input, path } = task;
		if (!isJsonSchemaRecord(input)) authorError(`${path} must be a value schema object`);
		if (seen.has(input)) authorError(`${path} is circular`);
		seen.add(input);
		const authorKeys = [...ANNOTATION_KEYS, ...task.allowRequired ? ["required"] : []];
		const node = {};
		assignCompiledNode(task.destination, node);
		tasks.push({
			kind: "leave",
			input
		});
		if (Object.hasOwn(input, "oneOf")) {
			assertAuthorKeys(input, path, [
				...authorKeys,
				"oneOf",
				"type"
			]);
			if (Object.hasOwn(input, "type")) authorError(`${path} cannot declare both type and oneOf`);
			if (!isPlainJsonArray(input.oneOf)) authorError(`${path}.oneOf must be an array of at least two value schemas`);
			const branches = [];
			node.oneOf = branches;
			copyAnnotations(input, node);
			for (let index = input.oneOf.length - 1; index >= 0; index--) tasks.push({
				kind: "value",
				input: input.oneOf[index],
				path: `${path}.oneOf[${index}]`,
				allowRequired: false,
				destination: {
					kind: "one-of",
					target: branches,
					index
				}
			});
			continue;
		}
		const inputType = Object.hasOwn(input, "type") ? input.type : void 0;
		switch (inputType) {
			case "json":
				assertAuthorKeys(input, path, [...authorKeys, "type"]);
				copyAnnotations(input, node);
				break;
			case "object":
				assertAuthorKeys(input, path, [
					...authorKeys,
					"type",
					"properties",
					"additionalProperties"
				]);
				if (!Object.hasOwn(input, "additionalProperties") || typeof input.additionalProperties !== "boolean") authorError(`${path}.additionalProperties must be explicitly true or false`);
				node.type = "object";
				copyAnnotations(input, node);
				node.additionalProperties = input.additionalProperties;
				if (Object.hasOwn(input, "properties")) tasks.push({
					kind: "property-map",
					input: input.properties,
					path: `${path}.properties`,
					destination: {
						kind: "object",
						target: node
					}
				});
				break;
			case "array":
				assertAuthorKeys(input, path, [
					...authorKeys,
					"type",
					"items"
				]);
				node.type = "array";
				copyAnnotations(input, node);
				if (Object.hasOwn(input, "items")) tasks.push({
					kind: "value",
					input: input.items,
					path: `${path}.items`,
					allowRequired: false,
					destination: {
						kind: "item",
						target: node
					}
				});
				break;
			case "string":
			case "number":
			case "integer":
			case "boolean":
			case "null":
				assertAuthorKeys(input, path, [
					...authorKeys,
					"type",
					"enum",
					"const"
				]);
				node.type = inputType;
				copyAnnotations(input, node);
				if (Object.hasOwn(input, "enum")) {
					if (!isPlainJsonArray(input.enum)) authorError(`${path}.enum must be a non-empty array of scalar values`);
					node.enum = Array.from(input.enum, (entry) => entry);
				}
				if (Object.hasOwn(input, "const")) node.const = input.const;
				break;
			default: authorError(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`);
		}
	}
}
/** Compile one implicit property map, collecting per-property requiredness. */
function compilePropertyMap(input, path) {
	const holder = {};
	runSchemaCompiler({
		kind: "property-map",
		input,
		path,
		destination: {
			kind: "root",
			holder
		}
	});
	/* v8 ignore next -- the root task assigns before scheduling any descendants. */
	return holder.value ?? authorError(`${path} did not compile`);
}
/** Compile one author node without applying any consumer root restriction. */
function compileValueSchema(input, path) {
	const holder = {};
	runSchemaCompiler({
		kind: "value",
		input,
		path,
		allowRequired: false,
		destination: {
			kind: "root",
			holder
		}
	});
	/* v8 ignore next -- the root task assigns before scheduling any descendants. */
	return holder.value ?? authorError(`${path} did not compile`);
}
/**
* Compile one author-facing value schema to the enforced raw JSON Schema
* subset. The author-only `json` node becomes an annotation-only schema.
* @param spec - schema for any JSON-value root.
* @returns The asserted raw schema projection.
*/
function valueSchemaSpecToJsonSchema(spec) {
	const schema = compileValueSchema(spec, "schema");
	assertSupportedJsonSchema(schema);
	return schema;
}
/**
* Compile the implicit open parameter object into raw JSON Schema.
* @param spec - per-property parameter definitions.
* @returns An object-rooted raw schema with no implicit-root openness override.
*/
function parameterSchemaSpecToJsonSchema(spec) {
	const compiled = compilePropertyMap(spec, "parameters");
	const schema = {
		type: "object",
		properties: compiled.properties,
		...compiled.required === void 0 ? {} : { required: compiled.required }
	};
	assertSupportedJsonSchema(schema);
	return schema;
}
/** Invalid model-generated arguments for a typed tool. */
var ToolArgsError = class extends HarnessError {
	/** Individual violations in schema-walk order. */
	violations;
	constructor(violations) {
		super(`invalid arguments: ${violations.join("; ")}`, "INVALID_ARGS");
		this.name = "ToolArgsError";
		this.violations = violations;
	}
};
/**
* Define a first-party tool with inferred arguments and strict execution
* validation. Replay-only presenters validate softly and fall back to generic
* rendering for obsolete logged arguments.
* @param options - typed definition and optional finalizer and presenters.
* @returns A registry-ready definition.
*/
function defineTool(options) {
	const userExecute = options.execute;
	const userFinalizeContent = options.finalizeContent;
	const userProjectContent = options.projectContent;
	const userRender = options.output.render;
	const userPresentationMeta = options.output.presentationMeta;
	const userPresentCall = options.presentCall;
	const userPresentResult = options.presentResult;
	const userIsConcurrencySafe = options.isConcurrencySafe;
	if (options.timeoutMs !== void 0 && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`);
	const parameters = parameterSchemaSpecToJsonSchema(options.parameters);
	const outputSchema = valueSchemaSpecToJsonSchema(options.output.schema);
	const validate = (args) => validateJsonSchemaValue(parameters, args, "");
	const tool = {
		name: options.name,
		description: options.description,
		parameters,
		output: {
			schema: outputSchema,
			render(args, value) {
				return userRender(args, value);
			},
			...userPresentationMeta !== void 0 ? { presentationMeta(args, value) {
				return userPresentationMeta(args, value);
			} } : {}
		},
		...options.deferLoading === true ? { deferLoading: options.deferLoading } : {},
		...options.timeoutMs !== void 0 ? { timeoutMs: options.timeoutMs } : {},
		async execute(args, exec) {
			const violations = validate(args);
			if (violations.length > 0) throw new ToolArgsError(violations);
			return userExecute(args, exec);
		}
	};
	if (userProjectContent) tool.projectContent = (exec, result) => userProjectContent(exec, result);
	if (userFinalizeContent) tool.finalizeContent = (exec, result) => userFinalizeContent(exec, result);
	if (userPresentCall) tool.presentCall = (args) => {
		if (validate(args).length > 0) return void 0;
		return userPresentCall(args);
	};
	if (userPresentResult) tool.presentResult = (args, result) => {
		if (validate(args).length > 0) return void 0;
		return userPresentResult(args, result);
	};
	if (userIsConcurrencySafe) tool.isConcurrencySafe = (args) => {
		if (validate(args).length > 0) return false;
		return userIsConcurrencySafe(args);
	};
	return tool;
}
/**
* Omit execution and presentation callbacks from a tool definition.
* @param definition - visible capability or executor-owned transport.
* @param detachParameters - copy parameters for a caller-owned inspection result.
* @returns the model-facing schema fields.
*/
function projectToolSchema(definition, detachParameters) {
	const { name, description, parameters, deferLoading } = definition;
	const detached = detachParameters ? snapshotJsonValue(parameters) : parameters;
	if (detached === void 0) throw new Error(`tool "${name}" parameters must be lossless JSON before schema projection`);
	return {
		name,
		description,
		parameters: detached,
		...deferLoading === true ? { deferLoading } : {}
	};
}
/** Tool definitions and scoped dispatch to plugin-owned executors. @module */
/** One scope's complete tool-registry contribution. */
var ToolLayer = class {
	tools;
	restrictions = new AnonymousEntries();
	constructor(scope) {
		this.tools = new NamedEntries((name) => /* @__PURE__ */ new Error(scope === void 0 ? `tool "${name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)` : `tool "${name}" is already registered in this scope`));
	}
	/** Whether every contribution table in this aggregate layer is empty. */
	isEmpty() {
		return this.tools.isEmpty() && this.restrictions.isEmpty();
	}
	/** Whether every compiled restriction in this layer admits a global tool name. */
	admits(name) {
		for (const filter of this.restrictions.values()) if (filter.allow !== void 0 && !filter.allow.has(name) || filter.deny !== void 0 && filter.deny.has(name)) return false;
		return true;
	}
};
var GuardLayer = class {
	guards = new AnonymousEntries();
	isEmpty() {
		return this.guards.isEmpty();
	}
};
/** Concrete tool registry and scoped executor dispatcher. */
var ToolsService = class extends Service {
	static inject = ["systemPrompt"];
	static Config = z.object({
		mode: z.never().description("Removed. Mount a native or PTC tool executor instead."),
		maxParallelSubCalls: z.never().description("Moved to the PTC tool executor configuration.")
	});
	layers = new ScopedLayers((scope) => new ToolLayer(scope), () => {
		this.ctx.emit("tools/change");
	});
	scoped = /* @__PURE__ */ new WeakMap();
	root;
	guards = new ScopedLayers(() => new GuardLayer(), () => {});
	constructor(ctx) {
		super(ctx, "tools");
		ctx.systemPrompt.tools(({ scope, toolSet }) => {
			const description = this.selectExecutor(scope).describe(this.definitions(scope, toolSet));
			return {
				...description,
				knownNames: description.knownNames ?? [...this.view(scope).knownNames]
			};
		});
	}
	/**
	* Register globally or in the calling agent scope. Scoped tools shadow
	* globals; duplicates within one layer and the reserved `run_code` name fail.
	* @param definition - tool schema, execution, and optional finalization/presentation callbacks.
	* @param options - optional step-time activation condition.
	* @returns the exact disposer that unregisters the tool.
	*/
	register(definition, options = {}) {
		const name = definition.name;
		const output = definition.output;
		if (output === void 0 || typeof output !== "object" || typeof output.render !== "function" || output.presentationMeta !== void 0 && typeof output.presentationMeta !== "function") throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
		assertSupportedJsonSchema(output.schema);
		const timeoutMs = definition.timeoutMs;
		if (timeoutMs !== void 0 && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`);
		if (name === "run_code") throw new Error(`tool name "${RUN_CODE_NAME}" is reserved for the PTC mode presentation transport and cannot be registered or shadowed`);
		return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, {
			definition,
			when: options.when
		}), { label: "tools.register()" });
	}
	/**
	* Restrict global tools for the calling agent scope. Empty filters, unknown
	* names, scope-local names, and reserved transport names fail. Restrictions
	* intersect; scoped registrations remain visible.
	* @param filter - global-tool mask: `allow` (keep only) and/or `deny` (remove).
	* @returns the exact disposer that lifts this restriction.
	*/
	restrict(filter) {
		const scope = scopeOf(this.ctx);
		if (scope === void 0) throw new Error("tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead");
		const allow = filter.allow;
		const deny = filter.deny;
		if (allow === void 0 && deny === void 0) throw new Error("tools.restrict({}) is a no-op: pass `allow` and/or `deny` (an empty filter is almost always a materialized-empty-config bug)");
		const compiled = {
			...allow !== void 0 ? { allow: new Set(allow) } : {},
			...deny !== void 0 ? { deny: new Set(deny) } : {}
		};
		if ([...allow ?? [], ...deny ?? []].includes("run_code")) throw new Error(`tools.restrict() cannot name reserved PTC mode presentation transport "${RUN_CODE_NAME}"; restrict end-capability tools instead`);
		const known = this.view(scope).restrictableNames;
		const unknown = [...allow ?? [], ...deny ?? []].filter((name) => !known.has(name));
		if (unknown.length > 0) throw new Error(`tools.restrict() names unknown global tool${unknown.length > 1 ? "s" : ""} ${unknown.map((n) => `"${n}"`).join(", ")}; known global tools: ${[...known].sort().join(", ") || "(none)"}`);
		return this.layers.effect(this.ctx, (layer) => layer.restrictions.append(compiled), { label: "tools.restrict()" });
	}
	/**
	* Resolve visible tools and pre-restriction names. Restrictions across the
	* scope chain intersect over inherited global and ancestor tools; the viewing
	* scope's own registrations remain exempt. Nearer registrations shadow
	* farther ones. Pre-restriction names support restriction and prompt-order validation.
	* @param scope - the viewing scope (the agent), or undefined for the global view.
	* @returns the complete derived view for that scope.
	*/
	view(scope) {
		const layers = this.layers.chainLayers(scope);
		const own = this.layers.peek(scope);
		const inherited = new Map(this.layers.global.tools.entries());
		for (const layer of layers) {
			if (layer === own) continue;
			for (const [name, registration] of layer.tools.entries()) inherited.set(name, registration);
		}
		const visible = /* @__PURE__ */ new Map();
		const registrations = /* @__PURE__ */ new Map();
		const knownNames = /* @__PURE__ */ new Set();
		const restrictableNames = /* @__PURE__ */ new Set();
		for (const [name, registration] of inherited) {
			knownNames.add(name);
			restrictableNames.add(name);
			if (layers.every((layer) => layer.admits(name))) {
				visible.set(name, registration.definition);
				registrations.set(name, registration);
			}
		}
		if (own !== void 0) for (const [name, registration] of own.tools.entries()) {
			knownNames.add(name);
			visible.set(name, registration.definition);
			registrations.set(name, registration);
		}
		return {
			visible,
			registrations,
			knownNames,
			restrictableNames
		};
	}
	/**
	* Look up a tool as one scope sees it (scoped
	* shadows global; a restricted-away global reads as absent). Presenters pass
	* the calling agent so the rendered card matches the definition that
	* actually executed.
	* @param name - the tool name as registered.
	* @param scope - the viewing scope (the agent); omitted = the global view.
	* @param toolSet - step admission; omit only to inspect registered definitions.
	* @returns the definition the scope resolves, or undefined when none is visible.
	*/
	get(name, scope, toolSet) {
		return toolSet === void 0 ? this.view(scope).visible.get(name) : toolSet.view(scope).get(name);
	}
	/**
	* Resolve the definition a call may execute. With a step's admitted set, the
	* set decides; without one, conditional registrations are unavailable.
	* @param name - the tool name as registered.
	* @param scope - the calling agent; omitted = the global view.
	* @param toolSet - step admission, or omitted for a call outside a model step.
	* @returns the executable definition, or undefined when the call must fail as `UNKNOWN_TOOL`.
	*/
	executable(name, scope, toolSet) {
		if (toolSet !== void 0) return toolSet.view(scope).get(name);
		const view = this.view(scope);
		return view.registrations.get(name)?.when === void 0 ? view.visible.get(name) : void 0;
	}
	/**
	* Resolve conditions once for this step without changing shared registrations.
	* Cancellation or a rejected condition publishes no partial selection. Removed
	* registrations cannot be restored by a late condition result.
	* @param context - preparing agent, captured model selection, and cancellation.
	* @returns the complete selection; the caller disposes it after its tool batch settles.
	*/
	async resolve(context) {
		const { agent, signal } = context;
		signal.throwIfAborted();
		const view = this.view(agent);
		const admitted = /* @__PURE__ */ new Map();
		for (const [name, definition] of view.visible) {
			const registration = view.registrations.get(name);
			let enabled;
			try {
				enabled = registration?.when === void 0 || await registration.when(context);
			} catch (cause) {
				signal.throwIfAborted();
				throw new ToolActivationError(name, cause);
			}
			signal.throwIfAborted();
			if (enabled) admitted.set(name, definition);
		}
		let closed = false;
		return Object.freeze({
			dispose: () => {
				closed = true;
			},
			view: (scope) => {
				const visible = /* @__PURE__ */ new Map();
				if (closed || scope !== agent) return visible;
				const current = this.view(agent);
				for (const [name, definition] of admitted) if (current.visible.get(name) === definition && current.registrations.get(name) === view.registrations.get(name)) visible.set(name, definition);
				return visible;
			}
		});
	}
	/**
	* Read the visible capability definitions for descriptions and program bindings.
	* @param scope - viewing Agent or preset; omitted selects the global view.
	* @param toolSet - step admission; omit only to inspect registered definitions.
	* @returns definitions after scoped shadowing and restrictions, limited to the step's admission when given.
	*/
	definitions(scope, toolSet) {
		return toolSet === void 0 ? [...this.view(scope).visible.values()] : [...toolSet.view(scope).values()];
	}
	/**
	* Project visible definitions onto the allowlisted model-facing schema fields,
	* excluding execution and presentation callbacks.
	* @param scope - the viewing scope (the agent); omitted = the global view.
	* @param toolSet - step admission, or omitted for registered-definition inspection.
	* @returns one deep-cloned schema per visible tool.
	*/
	schemas(scope, toolSet) {
		return this.definitions(scope, toolSet).map((definition) => projectToolSchema(definition, true));
	}
	/**
	* Provide the executor for the calling scope; an unscoped contribution is the deployment default.
	* Rendering any executor-owned section requires the viewing scope's selection to remain available.
	* @param executor - initialized provider owned by the contributing plugin.
	* @returns the effect disposer. Unloading leaves the selection unavailable until it is replaced.
	*/
	setExecutor(executor) {
		const scope = scopeOf(this.ctx);
		if ((scope === void 0 ? this.root : this.scoped.get(scope))?.executor !== void 0) throw new Error("Only one tool executor may be registered in each scope");
		const record = { executor };
		return this.ctx.effect(function* () {
			for (const section of executor.sections ?? []) yield this.ctx.systemPrompt.section({
				name: section.name,
				order: section.order,
				...section.interpolate === void 0 ? {} : { interpolate: section.interpolate },
				text: ({ scope, toolSet }) => {
					if (this.selectExecutor(scope) !== executor) return "";
					return typeof section.text === "function" ? section.text(this.definitions(scope, toolSet)) : section.text;
				}
			});
			if (scope === void 0) this.root = record;
			else this.scoped.set(scope, record);
			yield () => {
				record.executor = void 0;
			};
		}.bind(this), "tools.setExecutor()");
	}
	/**
	* Resolve the nearest scoped provider, or the deployment default.
	* @param scope - Agent or preset scope; omitted selects only the root contribution.
	* @returns the selected executor; throws when it is missing or unloaded.
	*/
	selectExecutor(scope) {
		let record;
		for (const key of scopeChainOf(scope)) {
			record = this.scoped.get(key);
			if (record !== void 0) break;
		}
		record ??= this.root;
		const executor = record?.executor;
		if (executor === void 0) throw new ToolExecutorUnavailableError();
		return executor;
	}
	/**
	* Delegate a raw call batch to its Agent's provider or the deployment default.
	* Select at dispatch; accepted batches settle through that provider even if it unloads.
	* @param input - original calls, optional owning Agent, and optional logging step.
	* @returns the selected executor's settled batch; unavailable selections reject.
	*/
	async execute(input) {
		return this.selectExecutor(input.agent).execute(input);
	}
	/**
	* Register a monotonic denial in the calling scope.
	* @param guard - evaluated after extensible pre-execute policy by the shared pipeline.
	* @returns the effect disposer that removes this guard.
	*/
	guard(guard) {
		return this.guards.effect(this.ctx, (layer) => layer.guards.append(guard), { label: "tools.guard()" });
	}
	/**
	* Check global and inherited guards after pre-execute policy and approval resolve.
	* @param exec - invocation whose guards are checked before dispatch.
	* @returns the first denial reason, or undefined when no guard denies.
	*/
	checkGuards(exec) {
		for (const layer of [this.guards.global, ...this.guards.chainLayers(exec.agent)]) for (const guard of layer.guards.values()) {
			const reason = guard(exec);
			if (reason !== void 0) return reason;
		}
	}
};
//#endregion
//#region src/tools.ts
function asJson(value) {
	return value;
}
const MAX_WAIT_MS = 36e5;
function clampTimeout(ms, fallback = 18e4) {
	if (ms === void 0) return fallback;
	if (!Number.isFinite(ms) || ms <= 0) throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(ms)}`);
	return Math.min(ms, MAX_WAIT_MS);
}
function clampLimit(limit, fallback, max) {
	if (limit === void 0) return fallback;
	if (!Number.isInteger(limit) || limit < 1) throw new Error(`invalid limit: expected a positive integer, got ${JSON.stringify(limit)}`);
	return Math.min(limit, max);
}
/** 结构取活 agent（ctx.agents 的返回类型按 dsh-agent 的 Agent 形状；这里用结构面）。 */
function liveAgent(env, sessionId) {
	return env.ctx.agents.get(sessionId);
}
function liveAgents(env) {
	return env.ctx.agents.list();
}
/** 等待结果里的状态附注行（wait / send / create 三处渲染共用）。 */
function waitNotes(reply) {
	const notes = [];
	if (reply.timedOut === true) notes.push("[wait timed out]");
	if (reply.stale === true) notes.push("[stale] pre-existing reply — nothing new arrived during the wait");
	if (reply.aborted === true) notes.push("[wait aborted]");
	return notes;
}
/** 渲染等待结果为 JSON 友好值。 */
function renderWait(wait) {
	const row = wait.message;
	return {
		message: row === null ? null : {
			seq: row.seq,
			role: row.role,
			...row.text !== void 0 ? { text: row.text } : {},
			...row.reasoning !== void 0 ? { reasoning: row.reasoning } : {},
			images: row.images,
			toolCalls: row.toolCalls ?? []
		},
		seq: wait.seq,
		turnEnded: wait.turnEnded,
		timedOut: wait.timedOut,
		...wait.stale === true ? { stale: true } : {},
		aborted: wait.aborted,
		waitedMs: wait.waitedMs
	};
}
async function maybeWait(env, session, baselineSeq, args, signal) {
	if (args.waitForReply !== true) return void 0;
	return renderWait(await waitForReply({
		session,
		baselineSeq,
		timeoutMs: clampTimeout(args.timeoutMs),
		signal,
		requireTurnEnd: false
	}));
}
function registerCreate(env) {
	env.ctx.tools.register(defineTool({
		name: "session_bridge_create",
		description: "Create a NEW main session (a top-level session that also appears in the DSH session list) and optionally send its first prompt. The session runs in the target workspace: pass workspaceId or cwd to target another workspace (cross-workspace), otherwise the caller's current workspace is used. Provider/model default to the current conversation; titles are only a bridge-side label (the real session title is generated automatically). Returns the new session id; with waitForReply=true it blocks until the first assistant reply completes and returns it.",
		parameters: {
			workspaceId: {
				type: "string",
				description: "Target workspace id (from session_bridge_find). Takes precedence over cwd."
			},
			cwd: {
				type: "string",
				description: "Target working directory for the new session (absolute path or any spelling)."
			},
			title: {
				type: "string",
				description: "Optional bridge-side label remembered for find-by-name; does not rename the real session."
			},
			prompt: {
				type: "string",
				description: "Optional first prompt sent right after creation."
			},
			agentPreset: {
				type: "string",
				description: "Optional agent preset id for composition."
			},
			provider: {
				type: "string",
				description: "LLM provider override (default: inherit from the current conversation)."
			},
			model: {
				type: "string",
				description: "LLM model override (default: inherit from the current conversation)."
			},
			reasoningEffort: {
				type: "string",
				description: "Reasoning effort override for the new session."
			},
			waitForReply: {
				type: "boolean",
				description: "When true and prompt is given, wait for the first assistant reply (default false)."
			},
			timeoutMs: {
				type: "number",
				description: "Wait timeout in milliseconds (default 180000, max 3600000)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => {
				const v = value;
				const lines = [`created main session ${String(v.sessionId)}`];
				if (typeof v.cwd === "string") lines.push(`cwd: ${v.cwd}`);
				if (typeof v.title === "string") lines.push(`title: ${v.title}`);
				const reply = v.reply;
				if (typeof v.sinceSeq === "number") lines.push(`sinceSeq: ${String(v.sinceSeq)} (pass to session_bridge_wait)`);
				if (reply !== void 0) {
					lines.push(`reply: ${String(reply.message?.text ?? "(no text)")}`);
					lines.push(...waitNotes(reply));
				}
				return [{
					type: "text",
					text: lines.join("\n")
				}];
			}
		},
		async execute(args, exec) {
			const caller = exec.agent;
			const created = await createBridgeSession(env.ctx, env.registry, {
				...caller === void 0 ? {} : { caller: {
					ctx: caller.ctx,
					session: caller.session
				} },
				callerCwd: caller?.session.header.cwd,
				...typeof args.workspaceId === "string" ? { workspaceId: args.workspaceId } : {},
				...typeof args.cwd === "string" ? { cwd: args.cwd } : {},
				...typeof args.title === "string" ? { title: args.title } : {},
				...typeof args.prompt === "string" ? { prompt: args.prompt } : {},
				...typeof args.agentPreset === "string" ? { agentPreset: args.agentPreset } : {},
				...typeof args.provider === "string" ? { provider: args.provider } : {},
				...typeof args.model === "string" ? { model: args.model } : {},
				...typeof args.reasoningEffort === "string" ? { reasoningEffort: args.reasoningEffort } : {}
			});
			let reply;
			if (args.waitForReply === true && created.baselineSeq !== void 0) reply = await maybeWait(env, created.agent.session, created.baselineSeq, args, exec.signal);
			return asJson({
				sessionId: created.sessionId,
				cwd: created.cwd,
				...created.workspaceId === void 0 ? {} : { workspaceId: created.workspaceId },
				...typeof args.title === "string" && args.title.trim() !== "" ? { title: args.title.trim() } : {},
				...reply === void 0 && created.baselineSeq !== void 0 ? { sinceSeq: created.baselineSeq } : {},
				...reply === void 0 ? {} : { reply }
			});
		}
	}));
}
function registerSend(env) {
	env.ctx.tools.register(defineTool({
		name: "session_bridge_send",
		description: "Send a message to any session (by id) and let it start working. If the session is not currently live (offline/persisted), call session_bridge_resume first. mode=queue appends a normal turn; mode=steer injects a step that interrupts the running turn. With waitForReply=true the tool blocks until that session produces its next assistant reply (turn complete), useful for reply-driven orchestration across sessions.",
		parameters: {
			sessionId: {
				type: "string",
				required: true,
				description: "Target session id (from session_bridge_find / session_bridge_create)."
			},
			message: {
				type: "string",
				required: true,
				description: "Message text to send as a user turn."
			},
			mode: {
				type: "string",
				enum: ["queue", "steer"],
				description: "queue (default) appends a turn; steer interrupts the running turn."
			},
			waitForReply: {
				type: "boolean",
				description: "When true, wait for the next assistant reply after sending (default false)."
			},
			timeoutMs: {
				type: "number",
				description: "Wait timeout in milliseconds (default 180000, max 3600000)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => {
				const v = value;
				const reply = v.reply;
				const lines = ["sent to " + String(v.sessionId)];
				if (typeof v.sinceSeq === "number") lines.push("sinceSeq: " + String(v.sinceSeq) + " (pass to session_bridge_wait)");
				if (reply !== null && reply !== void 0) {
					lines.push("reply: " + String(reply.message?.text ?? "(no text)"));
					lines.push(...waitNotes(reply));
				}
				return [{
					type: "text",
					text: lines.join("\n")
				}];
			}
		},
		async execute(args, exec) {
			if (typeof args.sessionId !== "string" || args.sessionId.trim() === "") throw new Error("invalid sessionId: expected a non-empty string");
			if (typeof args.message !== "string" || args.message.trim() === "") throw new Error("invalid message: expected a non-empty string");
			const agent = liveAgent(env, args.sessionId);
			if (agent === void 0) throw new Error("session " + JSON.stringify(args.sessionId) + " is not live — call session_bridge_resume first to bring it online (or session_bridge_find to locate it)");
			const baseline = maxSeq(sessionEvents(agent.session));
			if (args.mode === "steer") agent.steer(userMessage(args.message.trim()));
			else agent.followup(userMessage(args.message.trim()));
			const headerCwd = agent.session.header.cwd;
			const sendWorkspaceId = await attachSessionToWorkspace(env.ctx, args.sessionId, headerCwd) ?? workspaceByPath(env.ctx, headerCwd);
			env.registry.touch(args.sessionId, {
				...headerCwd === void 0 ? {} : { cwd: headerCwd },
				...sendWorkspaceId === void 0 ? {} : { workspaceId: sendWorkspaceId }
			});
			const reply = await maybeWait(env, agent.session, baseline, args, exec.signal);
			return asJson({
				accepted: true,
				sessionId: args.sessionId,
				...reply === void 0 ? { sinceSeq: baseline } : { reply }
			});
		}
	}));
}
function registerResume(env) {
	env.ctx.tools.register(defineTool({
		name: "session_bridge_resume",
		description: "Bring an existing persisted (offline) session back online so session_bridge_send / session_bridge_wait / session_bridge_read can operate on it. Resumes by session id; the session becomes live again (same as opening it). If already live this is a no-op. Provider/model default to the session previous config.",
		parameters: {
			sessionId: {
				type: "string",
				required: true,
				description: "Session id to resume (persisted log must exist)."
			},
			provider: {
				type: "string",
				description: "Optional provider override."
			},
			model: {
				type: "string",
				description: "Optional model override."
			},
			reasoningEffort: {
				type: "string",
				description: "Optional reasoning effort override."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => {
				const v = value;
				return [{
					type: "text",
					text: v.alreadyLive === true ? "session " + String(v.sessionId) + " is already live" : "resumed session " + String(v.sessionId) + (typeof v.cwd === "string" ? " (cwd: " + v.cwd + ")" : "")
				}];
			}
		},
		async execute(args) {
			if (typeof args.sessionId !== "string" || args.sessionId.trim() === "") throw new Error("invalid sessionId: expected a non-empty string");
			const existing = liveAgent(env, args.sessionId);
			if (existing !== void 0) {
				env.registry.touch(args.sessionId);
				return asJson({
					sessionId: args.sessionId,
					alreadyLive: true,
					...existing.session.header.cwd === void 0 ? {} : { cwd: existing.session.header.cwd },
					title: titleOf(sessionEvents(existing.session)) ?? null,
					running: existing.status === "running"
				});
			}
			let headers = [];
			try {
				headers = (await env.ctx.sessionPersistence.list()).map((rec) => ({
					id: rec.header.id,
					...rec.header.cwd === void 0 ? {} : { cwd: rec.header.cwd },
					createdAt: rec.header.createdAt
				}));
			} catch (error) {
				throw new Error("session persistence unavailable: " + (error instanceof Error ? error.message : String(error)));
			}
			const header = headers.find((h) => h.id === args.sessionId);
			if (header === void 0) throw new Error("session " + JSON.stringify(args.sessionId) + " is unknown (no live agent and no persisted log) — use session_bridge_find to locate existing sessions");
			const agents = env.ctx.agents;
			const agentOptions = {};
			if (typeof args.provider === "string" && args.provider !== "") agentOptions.provider = args.provider;
			if (typeof args.model === "string" && args.model !== "") agentOptions.model = args.model;
			if (typeof args.reasoningEffort === "string" && args.reasoningEffort !== "") agentOptions.reasoningEffort = args.reasoningEffort;
			const handle = await agents.resume({
				resumeSessionId: args.sessionId,
				...Object.keys(agentOptions).length > 0 ? { agentOptions } : {}
			});
			const headerCwd = header.cwd;
			const resumeWorkspaceId = await attachSessionToWorkspace(env.ctx, args.sessionId, headerCwd) ?? workspaceByPath(env.ctx, headerCwd);
			env.registry.record({
				sessionId: args.sessionId,
				...headerCwd === void 0 ? {} : { cwd: headerCwd },
				...resumeWorkspaceId === void 0 ? {} : { workspaceId: resumeWorkspaceId },
				source: "resume"
			});
			return asJson({
				sessionId: args.sessionId,
				resumed: true,
				...headerCwd === void 0 ? {} : { cwd: headerCwd },
				title: titleOf(sessionEvents(handle.agent.session)) ?? null
			});
		}
	}));
}
function registerWait(env) {
	env.ctx.tools.register(defineTool({
		name: "session_bridge_wait",
		description: "Wait for a session next assistant output: blocks (polling the session log) until a NEW assistant output appears after sinceSeq (default: the latest seq at call time). waitFor=reply returns as soon as a new assistant TEXT reply is readable; waitFor=segment returns as soon as any new COMPLETED output segment appears (an assistant/message step — text, reasoning, or tool-call turn), i.e. it does NOT wait for the whole turn, so you can observe the chain-of-thought/output paragraph by paragraph as it is produced. If no new output arrives within the budget, the latest PRE-EXISTING reply/segment is returned with stale=true (so an already-landed reply is never lost as \"(no text)\"). Returns the output summary, or timedOut/aborted when the deadline or caller cancellation ends the wait. Use it to consume output produced asynchronously by another session (e.g. a session you sent a message to, or one working on its own); to read a reply that may already exist, pass the sinceSeq anchor returned by send/create.",
		parameters: {
			sessionId: {
				type: "string",
				required: true,
				description: "Session id to wait on."
			},
			sinceSeq: {
				type: "number",
				description: "Only replies after this event seq count (default: latest seq at call time; -1 = count every event, the anchor returned by create for a brand-new session)."
			},
			timeoutMs: {
				type: "number",
				description: "Wait budget in milliseconds (default 180000, max 3600000); timed out waits return the partial result instead of failing."
			},
			requireTurnEnd: {
				type: "boolean",
				description: "When true, wait for the reply turn/end to settle before returning (default false; false returns as soon as the reply text is readable)."
			},
			waitFor: {
				type: "string",
				enum: ["reply", "segment"],
				description: "reply (default) waits for a new assistant TEXT reply; segment waits for any new completed output segment (an assistant/message step, incl. reasoning/tool turns) and returns it immediately, without waiting for the whole turn."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => {
				const reply = value.reply;
				if (reply === null || reply === void 0) return [{
					type: "text",
					text: "no reply observed"
				}];
				const message = reply.message;
				const lines = [message === null ? "no new reply within " + String(reply.waitedMs ?? "?") + "ms (no assistant text in this session)" : "reply seq " + String(reply.seq) + ": " + String(message.text ?? "(no text)")];
				if (typeof reply.turnEnded === "boolean") lines.push("turnEnded: " + String(reply.turnEnded));
				lines.push(...waitNotes(reply));
				return [{
					type: "text",
					text: lines.join("\n")
				}];
			}
		},
		async execute(args, exec) {
			if (typeof args.sessionId !== "string" || args.sessionId.trim() === "") throw new Error("invalid sessionId: expected a non-empty string");
			const agent = liveAgent(env, args.sessionId);
			if (agent === void 0) throw new Error("session " + JSON.stringify(args.sessionId) + " is not live — call session_bridge_resume first (waiting requires a live session)");
			const baseline = typeof args.sinceSeq === "number" && Number.isInteger(args.sinceSeq) && args.sinceSeq >= -1 ? args.sinceSeq : maxSeq(sessionEvents(agent.session));
			const result = await waitForReply({
				session: agent.session,
				baselineSeq: baseline,
				timeoutMs: clampTimeout(args.timeoutMs),
				signal: exec.signal,
				requireTurnEnd: args.requireTurnEnd === true,
				...args.waitFor === "segment" ? { waitForSegment: true } : {}
			});
			env.registry.touch(args.sessionId);
			return asJson({
				sessionId: args.sessionId,
				sinceSeq: baseline,
				reply: renderWait(result),
				running: agent.status === "running"
			});
		}
	}));
}
function registerSegments(env) {
	env.ctx.tools.register(defineTool({
		name: "session_bridge_segments",
		description: "Read the completed output segments of a session incrementally - each finished assistant step (one assistant/message paragraph), without waiting for the whole turn. Pass sinceSeq to page forward. Use this to watch a session produce its chain-of-thought / output paragraph by paragraph as each step finishes.",
		parameters: {
			sessionId: {
				type: "string",
				required: true,
				description: "Session id to read segments from (live or offline)."
			},
			sinceSeq: {
				type: "number",
				description: "Only return completed segments after this event seq (paging cursor)."
			},
			limit: {
				type: "number",
				description: "Maximum number of segments to return (default 10, max 50)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => {
				const segs = value.segments ?? [];
				if (segs.length === 0) return [{
					type: "text",
					text: "(no completed segments)"
				}];
				return [{
					type: "text",
					text: segs.map((sg) => {
						const head = "seg #" + String(sg.seq) + " (turn " + String(sg.turn) + " step " + String(sg.step) + ")";
						const text = typeof sg.text === "string" ? sg.text : "";
						const reason = typeof sg.reasoning === "string" && sg.reasoning !== "" ? " [reasoning " + sg.reasoning.length + " chars]" : "";
						return head + (Array.isArray(sg.toolCalls) && sg.toolCalls.length > 0 ? " [tools: " + sg.toolCalls.join(",") + "]" : "") + reason + ": " + text.slice(0, 160);
					}).join("\n")
				}];
			}
		},
		async execute(args) {
			const agent = liveAgent(env, args.sessionId);
			let events;
			let live;
			if (agent !== void 0) {
				events = sessionEvents(agent.session);
				live = true;
			} else try {
				events = (await inspectPersistedSession(env.ctx, args.sessionId)).events;
				live = false;
			} catch (error) {
				throw new Error(String(error));
			}
			const sinceSeq = typeof args.sinceSeq === "number" && Number.isInteger(args.sinceSeq) && args.sinceSeq >= 0 ? args.sinceSeq : 0;
			clampLimit(args.limit, 10, 50);
			const segs = segmentsSince(events, sinceSeq);
			env.registry.touch(args.sessionId);
			const nextCursorSeq = segs.length === 0 ? sinceSeq : segs[segs.length - 1]?.seq ?? sinceSeq;
			return asJson({
				sessionId: args.sessionId,
				live,
				nextCursorSeq,
				segments: segs.map((sg) => ({
					seq: sg.seq,
					time: sg.time,
					turn: sg.turn,
					step: sg.step,
					openTurn: sg.openTurn,
					...sg.text === void 0 ? {} : { text: sg.text },
					...sg.reasoning === void 0 ? {} : { reasoning: sg.reasoning },
					...sg.toolCalls.length > 0 ? { toolCalls: sg.toolCalls } : {}
				}))
			});
		}
	}));
}
function registerRead(env) {
	env.ctx.tools.register(defineTool({
		name: "session_bridge_read",
		description: "Read messages from any session — live or persisted (offline) — folding its event log into user/assistant text rows. By default returns the latest 20 messages; use limit for more (max 100) and sinceSeq to page forward from an event seq. role filters user/assistant rows; includeReasoning=false drops reasoning blocks.",
		parameters: {
			sessionId: {
				type: "string",
				required: true,
				description: "Session id to read (any session, even offline)."
			},
			sinceSeq: {
				type: "number",
				description: "Only return messages with seq greater than this value (paging)."
			},
			limit: {
				type: "number",
				description: "Number of most recent messages to return (default 20, max 100)."
			},
			role: {
				type: "string",
				enum: [
					"user",
					"assistant",
					"both"
				],
				description: "role filter (default both)."
			},
			includeReasoning: {
				type: "boolean",
				description: "Include assistant reasoning blocks (default true)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => {
				const messages = value.messages ?? [];
				if (messages.length === 0) return [{
					type: "text",
					text: "(no messages)"
				}];
				return [{
					type: "text",
					text: messages.map((m) => {
						const head = m.role === "user" ? "user" : "assistant";
						const text = typeof m.text === "string" ? m.text : "(no text)";
						return head + " #" + String(m.seq) + ": " + text;
					}).join("\n")
				}];
			}
		},
		async execute(args) {
			if (typeof args.sessionId !== "string" || args.sessionId.trim() === "") throw new Error("invalid sessionId: expected a non-empty string");
			const agent = liveAgent(env, args.sessionId);
			let events;
			let live;
			let cwd;
			if (agent !== void 0) {
				events = sessionEvents(agent.session);
				live = true;
				cwd = agent.session.header.cwd;
			} else {
				let inspection;
				try {
					inspection = await inspectPersistedSession(env.ctx, args.sessionId);
				} catch (error) {
					throw new Error("cannot read session " + JSON.stringify(args.sessionId) + ": " + (error instanceof Error ? error.message : String(error)));
				}
				events = inspection.events;
				live = false;
				cwd = inspection.meta.cwd;
			}
			let rows = foldMessages(events);
			if (args.role === "user") rows = rows.filter((r) => r.role === "user");
			if (args.role === "assistant") rows = rows.filter((r) => r.role === "assistant");
			if (args.includeReasoning === false) rows = rows.map((r) => ({
				...r,
				reasoning: void 0
			}));
			const sinceSeq = typeof args.sinceSeq === "number" && Number.isInteger(args.sinceSeq) && args.sinceSeq >= 0 ? args.sinceSeq : void 0;
			if (sinceSeq !== void 0) rows = rows.filter((r) => r.seq > sinceSeq);
			const limit = clampLimit(args.limit, 20, 100);
			rows = rows.slice(-limit);
			const workspaceId = workspaceByPath(env.ctx, cwd);
			env.registry.touch(args.sessionId, {
				...cwd === void 0 ? {} : { cwd },
				...workspaceId === void 0 ? {} : { workspaceId }
			});
			return asJson({
				sessionId: args.sessionId,
				live,
				...cwd === void 0 ? {} : { cwd },
				...workspaceId === void 0 ? {} : { workspaceId },
				title: titleOf(events) ?? null,
				messages: rows.map((r) => ({
					seq: r.seq,
					time: r.time,
					role: r.role,
					...r.text === void 0 ? {} : { text: r.text },
					...r.reasoning === void 0 ? {} : { reasoning: r.reasoning },
					images: r.images,
					...r.toolCalls === void 0 ? {} : { toolCalls: r.toolCalls }
				})),
				nextSeq: maxSeq(events),
				totalEvents: events.length
			});
		}
	}));
}
function registerFind(env) {
	env.ctx.tools.register(defineTool({
		name: "session_bridge_find",
		description: "Find sessions by name (title), session id, workspace, or directory — across ALL workspaces. Live agents are always current; persisted (offline) sessions come from the durable session store. A plain query matches session id / title / cwd as a case-insensitive substring. Offline titles are resolved lazily from the session log (bounded); bridge-registered titles (from session_bridge_create title) are matched as aliases and used as a fallback. Returns metadata + live/running state, ready to pass to create/send/resume/wait/read.",
		parameters: {
			query: {
				type: "string",
				description: "Substring matched against session id, title, and cwd (case-insensitive)."
			},
			sessionId: {
				type: "string",
				description: "Only sessions whose id contains this substring."
			},
			title: {
				type: "string",
				description: "Only sessions whose title contains this substring (offline titles resolved lazily)."
			},
			workspaceId: {
				type: "string",
				description: "Only sessions in this workspace id."
			},
			cwd: {
				type: "string",
				description: "Only sessions whose cwd contains this substring (path or basename)."
			},
			liveOnly: {
				type: "boolean",
				description: "When true, only live sessions are returned (default false)."
			},
			limit: {
				type: "number",
				description: "Maximum items (default 10, max 50)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => {
				const items = value.items ?? [];
				if (items.length === 0) return [{
					type: "text",
					text: "(no sessions found)"
				}];
				return [{
					type: "text",
					text: items.map((item) => {
						const id = String(item.sessionId);
						const title = typeof item.title === "string" ? item.title : "(untitled)";
						const state = item.live === true ? item.running === true ? "running" : "idle" : "offline";
						const cwd = typeof item.cwd === "string" ? item.cwd : "";
						return state + " " + id + " (" + title + ")" + (cwd === "" ? "" : " @ " + cwd);
					}).join("\n")
				}];
			}
		},
		async execute(args) {
			const limit = clampLimit(args.limit, 10, 50);
			const wsById = workspaceBySession(env.ctx);
			const items = [];
			for (const agent of liveAgents(env)) {
				const headerCwd = agent.session.header.cwd;
				const wsId = wsById.get(agent.id) ?? workspaceByPath(env.ctx, headerCwd);
				items.push({
					sessionId: agent.id,
					title: titleOf(sessionEvents(agent.session)),
					...headerCwd === void 0 ? {} : { cwd: headerCwd },
					...wsId === void 0 ? {} : { workspaceId: wsId },
					live: true,
					running: agent.status === "running",
					...agent.session.header.parentSession === void 0 ? {} : { parentSession: agent.session.header.parentSession },
					...agent.session.header.origin === void 0 ? {} : { origin: agent.session.header.origin },
					createdAt: agent.session.header.createdAt,
					...agent.session.header.agentPreset === void 0 ? {} : { agentPreset: agent.session.header.agentPreset }
				});
			}
			if (args.liveOnly !== true) try {
				const persistence = env.ctx.sessionPersistence;
				for (const rec of await persistence.list()) {
					const header = rec.header;
					if (items.some((item) => item.sessionId === header.id)) continue;
					items.push({
						sessionId: header.id,
						...header.cwd === void 0 ? {} : { cwd: header.cwd },
						...wsById.get(header.id) === void 0 ? {} : { workspaceId: wsById.get(header.id) },
						live: false,
						...header.parentSession === void 0 ? {} : { parentSession: header.parentSession },
						...header.origin === void 0 ? {} : { origin: header.origin },
						createdAt: header.createdAt,
						...header.agentPreset === void 0 ? {} : { agentPreset: header.agentPreset }
					});
				}
			} catch (error) {
				console.warn("[dsh-session-bridge] offline listing failed:", error instanceof Error ? error.message : String(error));
			}
			let registryRecords = [];
			try {
				registryRecords = await env.registry.all();
			} catch {
				registryRecords = [];
			}
			const bridgeTitles = /* @__PURE__ */ new Map();
			for (const item of items) {
				const rec = registryRecords.find((r) => r.sessionId === item.sessionId);
				if (rec?.title !== void 0) {
					if (item.title === void 0) item.title = rec.title;
					bridgeTitles.set(item.sessionId, rec.title);
				}
			}
			const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
			const idFilter = typeof args.sessionId === "string" ? args.sessionId.trim().toLowerCase() : "";
			const titleFilter = typeof args.title === "string" ? args.title.trim().toLowerCase() : "";
			const wsFilter = typeof args.workspaceId === "string" ? args.workspaceId.trim() : "";
			const cwdFilter = typeof args.cwd === "string" ? args.cwd.trim().toLowerCase() : "";
			if (titleFilter !== "" || query !== "" && items.some((item) => !item.live)) {
				let inspected = 0;
				for (const item of items) {
					if (inspected >= 30) break;
					if (item.live || item.title !== void 0) continue;
					try {
						item.title = titleOf((await inspectPersistedSession(env.ctx, item.sessionId)).events);
						inspected += 1;
					} catch {
						inspected += 1;
					}
				}
			}
			const filtered = items.filter((item) => {
				if (idFilter !== "" && !item.sessionId.toLowerCase().includes(idFilter)) return false;
				if (titleFilter !== "") {
					if (!((item.title ?? "") + " " + (bridgeTitles.get(item.sessionId) ?? "")).toLowerCase().includes(titleFilter)) return false;
				}
				if (wsFilter !== "" && item.workspaceId !== wsFilter) return false;
				if (cwdFilter !== "" && !(item.cwd ?? "").toLowerCase().includes(cwdFilter)) return false;
				if (query !== "") {
					if (!(item.sessionId.toLowerCase() + " " + (item.title ?? "").toLowerCase() + " " + (item.cwd ?? "").toLowerCase() + " " + (bridgeTitles.get(item.sessionId) ?? "").toLowerCase()).includes(query)) return false;
				}
				return true;
			});
			filtered.sort((a, b) => {
				if (a.live !== b.live) return a.live ? -1 : 1;
				return (b.createdAt ?? 0) - (a.createdAt ?? 0);
			});
			return asJson({
				items: filtered.slice(0, limit).map((item) => ({
					sessionId: item.sessionId,
					...item.title === void 0 ? {} : { title: item.title },
					...item.cwd === void 0 ? {} : { cwd: item.cwd },
					...item.workspaceId === void 0 ? {} : { workspaceId: item.workspaceId },
					live: item.live,
					...item.running === void 0 ? {} : { running: item.running },
					...item.parentSession === void 0 ? {} : { parentSession: item.parentSession },
					...item.origin === void 0 ? {} : { origin: item.origin },
					...item.createdAt === void 0 ? {} : { createdAt: item.createdAt },
					...item.updatedAt === void 0 ? {} : { updatedAt: item.updatedAt },
					...item.agentPreset === void 0 ? {} : { agentPreset: item.agentPreset }
				})),
				total: filtered.length,
				truncated: filtered.length > limit
			});
		}
	}));
}
function registerBridgeTools(env) {
	registerCreate(env);
	registerSend(env);
	registerResume(env);
	registerWait(env);
	registerSegments(env);
	registerRead(env);
	registerFind(env);
	registerStatus(env);
	registerCancel(env);
	registerMonitor(env);
	registerArchive(env);
}
/** 校验并规范化 coRules 参数为 CoTRule[]；非法项抛清晰错误。 */
function parseCoRules(raw) {
	return raw.map((rule, index) => {
		return {
			match: rule.match === "contains" || rule.match === "not-contains" ? rule.match : (() => {
				throw new Error("coRules[" + index + "].match must be \"contains\" or \"not-contains\"");
			})(),
			field: rule.field === "reasoning" || rule.field === "text" || rule.field === "both" ? rule.field : (() => {
				throw new Error("coRules[" + index + "].field must be \"reasoning\", \"text\" or \"both\"");
			})(),
			action: rule.action === "steer" || rule.action === "cancel" ? rule.action : (() => {
				throw new Error("coRules[" + index + "].action must be \"steer\" or \"cancel\"");
			})(),
			value: typeof rule.value === "string" && rule.value.trim() !== "" ? rule.value.trim() : (() => {
				throw new Error("coRules[" + index + "].value must be a non-empty string");
			})(),
			...typeof rule.message === "string" && rule.message.trim() !== "" ? { message: rule.message.trim() } : {}
		};
	});
}
function renderMonitorState(entry, policy) {
	const lines = [];
	lines.push(`monitoring ${entry.config.sessionId}${entry.config.label === void 0 ? "" : " (\"" + entry.config.label + "\")"}`);
	lines.push(`interval: ${entry.config.intervalMs}ms | stalled: ${String(entry.config.stalledMs ?? 6e4)}ms | maxStuck: ${String(entry.config.maxStuckCycles ?? 3)}`);
	lines.push(`cycles: ${entry.cycles} | stuck: ${entry.stuckCount} | lastAction: ${entry.lastAction}`);
	const cotCount = (entry.config.coTRules ?? []).length;
	if (cotCount > 0) lines.push(`coRules: ${cotCount} rule(s) (minHits ${String(entry.config.cotMinHits ?? 1)})`);
	if (entry.config.loopGuard === false) lines.push("loopGuard: off (this monitor only)");
	else if (policy !== void 0 && !policy.enabled()) lines.push("loopGuard: off (plugin switch — /cot-loop on, or Settings → Plugins → dsh-session-bridge)");
	else {
		const loopState = entry.loop;
		const transfers = loopState === void 0 ? [] : loopState.transfers;
		const depth = entry.config.loopTransferDepth ?? 0;
		const path = transfers.length === 0 ? "" : " (" + transfers.map((t) => t.from + " → " + t.to).join(", ") + ")";
		lines.push(`loopGuard: on field=${entry.config.loopField ?? "reasoning"} ${String(entry.config.loopMinCycles ?? 2)}x${String(entry.config.loopMinRepeats ?? 3)} conf>=${String(entry.config.loopMinConfidence ?? .6)} descendants=${entry.config.loopDescendants ?? "report"}${depth === 0 ? "" : " depth=" + String(depth)} | transfers: ${transfers.length}${path}, subagent cancels: ${String(loopState === void 0 ? 0 : loopState.subagentCancels)}`);
	}
	if (entry.lastNote !== "") lines.push(`note: ${entry.lastNote}`);
	if (entry.done) lines.push("done: yes");
	return lines;
}
function registerMonitor(env) {
	env.ctx.tools.register(defineTool({
		name: "session_bridge_monitor_start",
		description: "Start a background watchdog on a main session: poll its progress at an interval, and automatically schedule — steer the session when it stalls (or, with useLlm, when it drifts off-track), cancel it when it stays stuck past maxStuckCycles, and stop when a done keyword appears while idle. It can also enforce chain-of-thought rules via coRules: e.g. coRules=[{match:\"not-contains\",field:\"reasoning\",value:\"I'm\",action:\"cancel\"}] stops the session the moment its live reasoning stops containing I'm (evaluated on each poll while running). This is the \"monitor worker\" that watches a main task thread and corrects/stops it. Uses session_bridge_status-style facts; pass sessionId of a live session. Returns the watchdog state. It also detects chain-of-thought LOOPS by default — the same content repeated over and over (e.g. \"写。好。Go。写。好。Go。写。好。Go。\"). A stall check cannot catch this (every cycle lands new events, so the target never looks stalled), so on a loop the watchdog interrupts the session and TRANSFERS the task to a new session, which receives a handoff prompt (original session id, task, recent context, and the descendant list) and is watched by default. Subagents: still-running descendants are left running and listed in the handoff (default loopDescendants=\"report\" — never cancelled), loopDescendants=\"stop\" cancels them before transferring, \"ignore\" drops them. A subagent session that loops is only cancelled, never transferred (that would break the execution tree). Knobs: loopGuard, loopField (reasoning|text|both), loopMinCycles, loopMinRepeats, loopMinConfidence, loopMinHits, loopCooldownMs, loopMaxTransfers (default 3, also the transfer-depth cap), loopTransfer, loopAutoMonitor, loopDescendants, loopHandoffPrompt, loopTransferDepth. A PLUGIN-LEVEL switch (config field loopGuard, toggled with the /cot-loop slash command or Settings → Plugins → dsh-session-bridge) disables loop detection for every monitor at once; passing loopGuard=false here does the same for this monitor alone.",
		parameters: {
			sessionId: {
				type: "string",
				required: true,
				description: "Target main session id to watch (must be live)."
			},
			intervalMs: {
				type: "number",
				description: "Poll interval in ms (default 10000, min 5000)."
			},
			stalledMs: {
				type: "number",
				description: "Treat as stalled when no event for this many ms (default 60000)."
			},
			maxStuckCycles: {
				type: "number",
				description: "Cancel the session after this many consecutive stall ticks (default 3)."
			},
			doneKeywords: {
				type: "array",
				items: { type: "string" },
				description: "Any of these strings in the reply (while idle) marks the task done and stops the watchdog."
			},
			useLlm: {
				type: "boolean",
				description: "When true, use the LLM to also detect off-track (default false, rules only)."
			},
			onStallSteer: {
				type: "string",
				description: "Steer text injected on a stall/nudge (default: ask to summarize progress and continue)."
			},
			onOffTrackSteer: {
				type: "string",
				description: "Steer text injected when LLM judges the task off-track (default: ask to return to the original goal)."
			},
			label: {
				type: "string",
				description: "Optional human label for logs/display."
			},
			coRules: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						match: {
							type: "string",
							required: true,
							enum: ["contains", "not-contains"],
							description: "contains = must include value in the chosen field; not-contains = must NOT include it."
						},
						field: {
							type: "string",
							required: true,
							enum: [
								"reasoning",
								"text",
								"both"
							],
							description: "Match on reasoning (chain-of-thought), text (reply), or both (either)."
						},
						value: {
							type: "string",
							required: true,
							description: "The substring to match (non-empty)."
						},
						action: {
							type: "string",
							required: true,
							enum: ["steer", "cancel"],
							description: "steer injects a guiding message; cancel terminates the session."
						},
						message: {
							type: "string",
							description: "Custom steer text (default is a guidance prompt)."
						}
					}
				},
				description: "Chain-of-thought rules: when a rule stays matched for cotMinHits consecutive polls (default 1), trigger its action. Example: [{match:\"not-contains\",field:\"reasoning\",value:\"I'm\",action:\"cancel\"}] stops the session the moment its live reasoning no longer contains I'm."
			},
			cotMinHits: {
				type: "number",
				description: "How many consecutive matched polls before a CoT rule fires (default 1 = immediately)."
			},
			loopGuard: {
				type: "boolean",
				description: "Chain-of-thought LOOP detection with automatic task transfer: false disables it (default true)."
			},
			loopField: {
				type: "string",
				enum: [
					"reasoning",
					"text",
					"both"
				],
				description: "Which field to scan for loops (default reasoning = live chain-of-thought)."
			},
			loopMinCycles: {
				type: "number",
				description: "Minimum number of repeated cycles (default 2)."
			},
			loopMinRepeats: {
				type: "number",
				description: "Minimum repeats of the unit (default 3); the effective floor is max(loopMinCycles, loopMinRepeats)."
			},
			loopMinConfidence: {
				type: "number",
				description: "Confidence threshold 0..1 (default 0.6)."
			},
			loopMinHits: {
				type: "number",
				description: "Consecutive polls with the same loop signature before firing (default 1 = first hit)."
			},
			loopCooldownMs: {
				type: "number",
				description: "Cooldown in ms before the same signature may fire again (default max(intervalMs*2, 30000))."
			},
			loopMaxTransfers: {
				type: "number",
				description: "Max task transfers (default 3); also the transfer-depth cap."
			},
			loopTransfer: {
				type: "boolean",
				description: "When false a detected loop only cancels the session (default true = transfer the task to a new session)."
			},
			loopAutoMonitor: {
				type: "boolean",
				description: "When false the newly created successor session is not watched (default true)."
			},
			loopDescendants: {
				type: "string",
				enum: [
					"report",
					"stop",
					"ignore"
				],
				description: "Subagent policy: report (default) lists running subagents in the handoff and leaves them running; stop cancels them before transferring; ignore drops them entirely."
			},
			loopHandoffPrompt: {
				type: "string",
				description: "Custom handoff prompt template. Placeholders: {{sessionId}} {{cwd}} {{reason}} {{task}} {{evidence}} {{descendants}}."
			},
			loopTransferDepth: {
				type: "number",
				description: "Current transfer depth (internal; the watchdog passes depth+1 to the successor session)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => {
				const entry = value.monitor;
				if (entry === null || entry === void 0) return [{
					type: "text",
					text: "monitor not started"
				}];
				return [{
					type: "text",
					text: renderMonitorState(entry, env.policy).join("\n")
				}];
			}
		},
		async execute(args) {
			if (typeof args.sessionId !== "string" || args.sessionId.trim() === "") throw new Error("invalid sessionId: expected a non-empty string");
			const config = {
				sessionId: args.sessionId.trim(),
				intervalMs: typeof args.intervalMs === "number" && args.intervalMs >= 5e3 ? Math.floor(args.intervalMs) : 1e4,
				...typeof args.stalledMs === "number" && args.stalledMs > 0 ? { stalledMs: Math.floor(args.stalledMs) } : {},
				...typeof args.maxStuckCycles === "number" && args.maxStuckCycles >= 1 ? { maxStuckCycles: Math.floor(args.maxStuckCycles) } : {},
				doneKeywords: Array.isArray(args.doneKeywords) ? args.doneKeywords.filter((k) => typeof k === "string" && k.trim() !== "") : [],
				...args.useLlm === true ? { useLlm: true } : {},
				...typeof args.onStallSteer === "string" && args.onStallSteer.trim() !== "" ? { onStallSteer: args.onStallSteer.trim() } : {},
				...typeof args.onOffTrackSteer === "string" && args.onOffTrackSteer.trim() !== "" ? { onOffTrackSteer: args.onOffTrackSteer.trim() } : {},
				...typeof args.label === "string" && args.label.trim() !== "" ? { label: args.label.trim() } : {},
				...Array.isArray(args.coRules) && args.coRules.length > 0 ? { coTRules: parseCoRules(args.coRules) } : {},
				...typeof args.cotMinHits === "number" && Number.isInteger(args.cotMinHits) && args.cotMinHits >= 1 ? { cotMinHits: Math.floor(args.cotMinHits) } : {},
				...args.loopGuard === false ? { loopGuard: false } : {},
				...args.loopField === "reasoning" || args.loopField === "text" || args.loopField === "both" ? { loopField: args.loopField } : {},
				...typeof args.loopMinCycles === "number" ? { loopMinCycles: Math.floor(args.loopMinCycles) } : {},
				...typeof args.loopMinRepeats === "number" ? { loopMinRepeats: Math.floor(args.loopMinRepeats) } : {},
				...typeof args.loopMinConfidence === "number" ? { loopMinConfidence: args.loopMinConfidence } : {},
				...typeof args.loopMinHits === "number" ? { loopMinHits: Math.floor(args.loopMinHits) } : {},
				...typeof args.loopCooldownMs === "number" ? { loopCooldownMs: Math.floor(args.loopCooldownMs) } : {},
				...typeof args.loopMaxTransfers === "number" ? { loopMaxTransfers: Math.floor(args.loopMaxTransfers) } : {},
				...args.loopTransfer === false ? { loopTransfer: false } : {},
				...args.loopAutoMonitor === false ? { loopAutoMonitor: false } : {},
				...args.loopDescendants === "report" || args.loopDescendants === "stop" || args.loopDescendants === "ignore" ? { loopDescendants: args.loopDescendants } : {},
				...typeof args.loopHandoffPrompt === "string" && args.loopHandoffPrompt.trim() !== "" ? { loopHandoffPrompt: args.loopHandoffPrompt } : {},
				...typeof args.loopTransferDepth === "number" ? { loopTransferDepth: Math.floor(args.loopTransferDepth) } : {}
			};
			const entry = env.monitor.start(config);
			env.registry.touch(args.sessionId);
			return asJson({
				sessionId: args.sessionId,
				monitor: {
					...entry,
					config: { ...entry.config }
				}
			});
		}
	}));
	env.ctx.tools.register(defineTool({
		name: "session_bridge_monitor_stop",
		description: "Stop the background watchdog on a session (keep the session itself running). Returns whether a watchdog was active and stopped.",
		parameters: { sessionId: {
			type: "string",
			required: true,
			description: "Target session id."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => {
				const v = value;
				return [{
					type: "text",
					text: (v.wasActive === true ? "stopped monitor " : "no active monitor ") + String(v.sessionId)
				}];
			}
		},
		async execute(args) {
			if (typeof args.sessionId !== "string" || args.sessionId.trim() === "") throw new Error("invalid sessionId: expected a non-empty string");
			const wasActive = env.monitor.stop(args.sessionId.trim());
			return asJson({
				sessionId: args.sessionId,
				wasActive
			});
		}
	}));
	env.ctx.tools.register(defineTool({
		name: "session_bridge_monitor_list",
		description: "List all active watchdogs started via session_bridge_monitor_start, with their poll interval, stall threshold, stuck count, last action, and done status.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => {
				const entries = value.monitors ?? [];
				if (entries.length === 0) return [{
					type: "text",
					text: "(no active monitors)"
				}];
				return [{
					type: "text",
					text: entries.map((e) => renderMonitorState(e, env.policy).join("\n")).join("\n---\n")
				}];
			}
		},
		async execute() {
			return asJson({ monitors: env.monitor.list().map((e) => ({
				...e,
				config: { ...e.config }
			})) });
		}
	}));
}
/** 按 reasoning 选项裁剪快照里的思维链字段（避免入 token 时有 diff 语义差）。 */
function pruneReasoning(snapshot, mode) {
	if (mode === "tail") return snapshot;
	const rest = { ...snapshot };
	delete rest.reasoningTail;
	if (mode === "none") {
		delete rest.lastReasoning;
		delete rest.liveReasoning;
	} else if (mode === "last") delete rest.liveReasoning;
	else delete rest.lastReasoning;
	return rest;
}
/**
* 渲染监控快照为一行摘要：运行态 + openTurn + 卡住/待处理 + 最新回复(+ 思维链预览)。
* 卡住判定走 core.isStalled（唯一真源）：只有 running 会话才可能被标 [STALLED] ——
* 空闲/已收尾的会话"很久没事件"是正常状态，不是卡住（与监控 watchdog 一致）。
*/
function renderStatus(snapshot, stalledMsThreshold) {
	const lines = [];
	const runLabel = snapshot.running === "running" ? "running" : "idle";
	lines.push(`${runLabel} ${snapshot.sessionId}${snapshot.title === void 0 ? "" : ` ("${snapshot.title}")`}`);
	if (snapshot.openTurn) lines.push(`openTurn: yes (turn #${snapshot.lastTurn})`);
	else lines.push(`openTurn: no (last turn #${snapshot.lastTurn})`);
	if (snapshot.stalledMs !== null) {
		const stalled = isStalled(snapshot.running, snapshot.stalledMs, stalledMsThreshold);
		lines.push(`lastActivity: now-${snapshot.stalledMs}ms${stalled ? " [STALLED]" : ""}`);
	}
	if (snapshot.pendingWork) lines.push(`pendingWork: ${snapshot.nextTurnCount} turn + ${snapshot.nextStepCount} step`);
	if (snapshot.lastAssistantText !== void 0) lines.push(`lastReply: ${snapshot.lastAssistantText}`);
	if (snapshot.reasoningTail !== void 0 && snapshot.reasoningTail !== "") {
		const preview = snapshot.reasoningTail.length > 160 ? snapshot.reasoningTail.slice(0, 160) + "…" : snapshot.reasoningTail;
		lines.push(`reasoning: ${preview}`);
	}
	return lines;
}
function registerStatus(env) {
	env.ctx.tools.register(defineTool({
		name: "session_bridge_status",
		description: "Inspect a session's live progress for monitoring/scheduling. Returns running/idle, whether a turn is open, last turn number, time since the last event (for stall detection), pending queued work, and the latest text reply. It also surfaces the session's chain-of-thought: lastReasoning is the most recent finalized reasoning block, liveReasoning is the in-flight reasoning streamed for the current handled turn (reasoning-delta), and reasoningTail is a compact merged preview. reasoning=none drops all three to keep tokens small. When stalledMsThreshold is given, marks a RUNNING session as stalled once the time since the last event exceeds it (idle sessions are never flagged — a quiet finished session is not stuck). Pass sessionId of a live session (use session_bridge_find to locate; session_bridge_resume to bring an offline one online). Use this as the \"observe\" step of a monitor→decide→steer/cancel loop.",
		parameters: {
			sessionId: {
				type: "string",
				required: true,
				description: "Session id to inspect (must be live)."
			},
			stalledMsThreshold: {
				type: "number",
				description: "Mark a RUNNING session STALLED when time since the last event exceeds this many ms (default 60000); idle sessions are never marked."
			},
			recent: {
				type: "number",
				description: "Number of recent messages to include in the snapshot (default 8, max 20)."
			},
			reasoning: {
				type: "string",
				enum: [
					"none",
					"last",
					"live",
					"tail"
				],
				description: "Which chain-of-thought fields to include: tail (default) returns lastReasoning/liveReasoning/reasoningTail; last only the finalized reasoning; live only the in-flight reasoning; none drops all reasoning fields."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => {
				const v = value;
				const snapshot = v.snapshot;
				if (snapshot === null || snapshot === void 0) return [{
					type: "text",
					text: "session unavailable"
				}];
				return [{
					type: "text",
					text: renderStatus(snapshot, typeof v.stalledMsThreshold === "number" ? v.stalledMsThreshold : 6e4).join("\n")
				}];
			}
		},
		async execute(args) {
			if (typeof args.sessionId !== "string" || args.sessionId.trim() === "") throw new Error("invalid sessionId: expected a non-empty string");
			const agent = liveAgent(env, args.sessionId);
			if (agent === void 0) throw new Error("session " + JSON.stringify(args.sessionId) + " is not live — call session_bridge_resume first (status requires a live session)");
			const threshold = typeof args.stalledMsThreshold === "number" && Number.isFinite(args.stalledMsThreshold) && args.stalledMsThreshold >= 0 ? args.stalledMsThreshold : 6e4;
			const reasoningMode = args.reasoning === "none" || args.reasoning === "last" || args.reasoning === "live" ? args.reasoning : "tail";
			const snapshot = pruneReasoning(statusSnapshot(env.ctx, agent), reasoningMode);
			const shown = typeof args.recent === "number" && Number.isInteger(args.recent) && args.recent >= 0 ? Math.min(args.recent, 20) : 8;
			const envCwd = agent.session.header.cwd;
			env.registry.touch(args.sessionId, {
				...envCwd === void 0 ? {} : { cwd: envCwd },
				...workspaceByPath(env.ctx, envCwd) === void 0 ? {} : { workspaceId: workspaceByPath(env.ctx, envCwd) }
			});
			return asJson({
				sessionId: args.sessionId,
				stalledMsThreshold: threshold,
				snapshot: {
					...snapshot,
					recent: snapshot.recent.slice(-shown).map((row) => ({ ...row }))
				}
			});
		}
	}));
}
function registerCancel(env) {
	env.ctx.tools.register(defineTool({
		name: "session_bridge_cancel",
		description: "Stop a running session: abort the active turn (and if keepInbox is false, also clear queued/steering work). Mirrors the agent cancel primitive. Use this as the \"stop\" step of a monitor→decide loop when a task has gone wrong, is stuck, or should be terminated. Returns the session state after cancellation. To resume later use session_bridge_resume; to re-queue work use session_bridge_send.",
		parameters: {
			sessionId: {
				type: "string",
				required: true,
				description: "Session id to cancel (must be live)."
			},
			keepInbox: {
				type: "boolean",
				description: "Preserve queued/steering input instead of clearing it (default false, i.e. clear pending work)."
			},
			cause: {
				type: "string",
				description: "Optional stable reason recorded for the cancellation."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => {
				const v = value;
				return [{
					type: "text",
					text: "cancelled " + String(v.sessionId) + " (running: " + String(v.running) + (v.keepInbox === true ? ", inbox kept" : ", inbox cleared") + ")"
				}];
			}
		},
		async execute(args) {
			if (typeof args.sessionId !== "string" || args.sessionId.trim() === "") throw new Error("invalid sessionId: expected a non-empty string");
			const agent = liveAgent(env, args.sessionId);
			if (agent === void 0) throw new Error("session " + JSON.stringify(args.sessionId) + " is not live — call session_bridge_resume first (cancel requires a live session)");
			const cause = typeof args.cause === "string" && args.cause.trim() !== "" ? {
				kind: "hook",
				reason: args.cause.trim()
			} : { kind: "user" };
			agent.cancel(cause, { keepInbox: args.keepInbox === true });
			const snapshot = statusSnapshot(env.ctx, agent);
			const envCwd = agent.session.header.cwd;
			env.registry.touch(args.sessionId, {
				...envCwd === void 0 ? {} : { cwd: envCwd },
				...workspaceByPath(env.ctx, envCwd) === void 0 ? {} : { workspaceId: workspaceByPath(env.ctx, envCwd) }
			});
			return asJson({
				sessionId: args.sessionId,
				running: agent.status,
				keepInbox: args.keepInbox === true,
				snapshot
			});
		}
	}));
}
/**
* 紧凑渲染归档集合：归档集合会无限增长（真实宿主里已有 200+ 个），而每次
* archive/unarchive 都把整集合回显到工具结果里，会把真正的结果埋进数千 token
* 的 id 列表里（实测单次约 4k token）。这里只回显最新的一段，`total` 始终给出
* 准确规模；需要完整列表时用 `session_bridge_archived`（可传 limit）。
*/
function renderArchived(ids) {
	const total = "total archived: " + String(ids.length);
	if (ids.length === 0) return total + " (empty)";
	const shown = ids.slice(-20);
	const omitted = ids.length - shown.length;
	return total + "\nmost recent: " + shown.join(", ") + (omitted > 0 ? " … (+" + String(omitted) + " earlier omitted)" : "");
}
function registerArchive(env) {
	env.ctx.tools.register(defineTool({
		name: "session_bridge_archive",
		description: "Archive one session: add it to the workspace registry's global archive set so it is hidden from every grouping surface in the UI (Un/grouped, workspaces) while its session history and workspace position are preserved. Mirrors the workspace controller archiveSession. The session must exist (live or in session persistence) and, without stopActivity, must be inactive — otherwise the archive is refused with \"the session is active\". Returns the affected session id and the resulting archive size (the newest ids only; use session_bridge_archived for a listing).",
		parameters: {
			sessionId: {
				type: "string",
				required: true,
				description: "Session id to archive."
			},
			stopActivity: {
				type: "boolean",
				description: "When true, stop the session's running work (turn, subagents, jobs, schedules) instead of refusing the archive because work is active (default false). The archive is written first and the stops are requested afterwards, exactly like the UI archive action."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => {
				const v = value;
				const note = v.stopActivity === true ? " (stopped running work)" : "";
				return [{
					type: "text",
					text: "archived " + String(v.sessionId) + note + "\n" + renderArchived(v.archivedSessionIds ?? [])
				}];
			}
		},
		async execute(args) {
			if (typeof args.sessionId !== "string" || args.sessionId.trim() === "") throw new Error("invalid sessionId: expected a non-empty string");
			const sessionId = args.sessionId.trim();
			const stopActivity = args.stopActivity === true;
			try {
				await env.ctx.workspaceRegistry.archiveSession(sessionId, stopActivity ? { stopActivity: true } : void 0);
			} catch (error) {
				const hint = stopActivity ? "" : " (pass stopActivity: true to archive it anyway and stop its running work)";
				throw new Error("cannot archive session " + JSON.stringify(sessionId) + ": " + (error instanceof Error ? error.message : String(error)) + hint);
			}
			const archived = env.ctx.workspaceRegistry.archivedSessionIds.map(String);
			return asJson({
				sessionId,
				stopActivity,
				archivedSessionIds: archived,
				totalArchived: archived.length
			});
		}
	}));
	env.ctx.tools.register(defineTool({
		name: "session_bridge_unarchive",
		description: "Unarchive one session: drop it from the workspace registry's global archive set so it is visible again on every grouping surface at its recorded position (its workspace accounting is never touched by archiving, so the slot is still there). Mirrors the workspace controller unarchiveSession. An unknown or not-archived id is an idempotent no-op. Returns the affected session id and the resulting archive size (the newest ids only; use session_bridge_archived for a listing).",
		parameters: { sessionId: {
			type: "string",
			required: true,
			description: "Session id to unarchive."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => {
				const v = value;
				return [{
					type: "text",
					text: "unarchived " + String(v.sessionId) + "\n" + renderArchived(v.archivedSessionIds ?? [])
				}];
			}
		},
		async execute(args) {
			if (typeof args.sessionId !== "string" || args.sessionId.trim() === "") throw new Error("invalid sessionId: expected a non-empty string");
			const sessionId = args.sessionId.trim();
			try {
				await env.ctx.workspaceRegistry.unarchiveSession(sessionId);
			} catch (error) {
				throw new Error("cannot unarchive session " + JSON.stringify(sessionId) + ": " + (error instanceof Error ? error.message : String(error)));
			}
			const archived = env.ctx.workspaceRegistry.archivedSessionIds.map(String);
			return asJson({
				sessionId,
				archivedSessionIds: archived,
				totalArchived: archived.length
			});
		}
	}));
	env.ctx.tools.register(defineTool({
		name: "session_bridge_archived",
		description: "List the session ids currently in the workspace registry archive set (hidden from groupings). Optionally resolve titles from the session log. The newest `limit` ids are returned (default 50, max 500) because the archive set grows without bound; `total` always reports the real size. Read-only.",
		parameters: {
			resolveTitles: {
				type: "boolean",
				description: "When true, resolve each archived session's title from its log (default false). Titles are resolved only for the returned ids."
			},
			limit: {
				type: "number",
				description: "Maximum ids to return, taken from the newest end of the archive set (default 50, max 500)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => {
				const v = value;
				const items = v.items ?? [];
				if (items.length === 0) return [{
					type: "text",
					text: "(no archived sessions)"
				}];
				const total = typeof v.total === "number" ? v.total : items.length;
				const lines = items.map((i) => i.sessionId + (i.title === void 0 ? "" : " (\"" + i.title + "\")"));
				if (items.length < total) lines.unshift(String(total) + " archived; newest " + String(items.length) + ":");
				return [{
					type: "text",
					text: lines.join("\n")
				}];
			}
		},
		async execute(args) {
			const limit = clampLimit(args.limit, 50, 500);
			const all = env.ctx.workspaceRegistry.archivedSessionIds.map(String);
			const archived = all.slice(-limit);
			if (args.resolveTitles !== true || archived.length === 0) return asJson({
				items: archivedEntries(archived, /* @__PURE__ */ new Map()),
				returned: archived.length,
				total: all.length
			});
			const titles = /* @__PURE__ */ new Map();
			try {
				const records = await env.registry.all();
				for (const rec of records) if (rec.title !== void 0) titles.set(rec.sessionId, rec.title);
			} catch {}
			for (const sessionId of archived) {
				if (titles.get(sessionId) !== void 0) continue;
				try {
					const inspection = await inspectPersistedSession(env.ctx, sessionId);
					titles.set(sessionId, titleOf(inspection.events));
				} catch {}
			}
			return asJson({
				items: archivedEntries(archived, titles),
				returned: archived.length,
				total: all.length
			});
		}
	}));
}
//#endregion
//#region src/config.ts
/**
* 插件配置（volatile）—— 思维链循环自动中断的开关与全局默认值。
*
* 两种开启方式共用这一份配置：
*  1. 命令 `/cot-loop on|off|status|...`：host 侧写回 profile patch，立即生效；
*  2. 设置 → Plugins 页该插件的表单：dsh-settings 扫描 Config 里标了 volatile 的字段
*     自动渲染控件，改完同样写回 profile patch。
*
* 字段标 volatile 后由 Loader 解析成**稳定引用**（读 `.get()`）：运行中的守护每次 tick
* 都读同一个引用，所以开/关不需要重启或热重载插件。
*/
/** 循环检测看哪一段内容。 */
const LOOP_FIELD_VALUES = [
	"reasoning",
	"text",
	"both"
];
/** 转移时对仍在运行的子代理的处置。 */
const LOOP_DESCENDANTS_VALUES = [
	"report",
	"stop",
	"ignore"
];
/**
* 标记一个字段为 volatile（Loader 把它解析成稳定引用，设置页把它渲染成可热改的控件）。
*
* 运行时 schemastery 有 `.volatile()`，但随包发布的类型定义里没有它，所以这里做一次
* 结构探测；旧版本上没有该方法时退化成普通字段（设置页不显示该项，功能不受影响）。
*/
function volatile(schema) {
	const candidate = schema;
	return typeof candidate.volatile === "function" ? candidate.volatile() : schema;
}
/** Cordis config schema：由 profile 的 entry 配置或设置页表单填充。 */
const Config = z.object({
	loopGuard: volatile(z.boolean().default(true).description("思维链循环自动中断总开关：关掉后任何监控都不再做循环检测。")),
	loopField: volatile(z.string().default("reasoning").description("循环检测看哪一段：reasoning（思考阶段，默认）/ text（最终回复）/ both。")),
	loopMinCycles: volatile(z.number().step(1).min(1).default(2).description("最小周期数：同一个单元要重复多少轮才算循环。")),
	loopMinRepeats: volatile(z.number().step(1).min(2).default(3).description("最小重复次数（有效下限取它与 loopMinCycles 的较大者）。")),
	loopMinConfidence: volatile(z.number().min(0).max(1).default(.6).description("最小置信度：判定循环所需的把握程度。")),
	loopMinHits: volatile(z.number().step(1).min(1).default(1).description("连续命中几次才动手（1 = 首次命中即中断并转移）。")),
	loopCooldownMs: volatile(z.number().step(1).min(0).default(6e4).description("两次循环处置之间的冷却时间（毫秒）。")),
	loopMaxTransfers: volatile(z.number().step(1).min(0).default(3).description("同一个任务最多转移几次（0 = 只中断不转移）。")),
	loopDescendants: volatile(z.string().default("report").description("转移时如何处理仍在运行的子代理：report（只写进交接说明）/ stop（先停掉）/ ignore（不提）。"))
});
function isVolatileRef(value) {
	return typeof value === "object" && value !== null && typeof value.get === "function";
}
/** 读一个配置值：兼容 Loader 的 volatile 引用与测试里直接传进来的裸值。 */
function readValue(value) {
	if (value === void 0) return void 0;
	if (isVolatileRef(value)) return value.get();
	return value;
}
function readEnum(value, allowed, fallback) {
	const raw = readValue(value);
	return typeof raw === "string" && allowed.includes(raw) ? raw : fallback;
}
function readNumber(value, fallback, min, max, integer = true) {
	const raw = readValue(value);
	if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
	const clamped = Math.min(max, Math.max(min, raw));
	return integer ? Math.round(clamped) : clamped;
}
/** 从插件的 Config 构造循环策略；config 缺失时全部走内置默认值。 */
function createLoopPolicy(config) {
	const bag = config ?? {};
	let override;
	return {
		enabled() {
			if (override !== void 0) return override;
			const raw = readValue(bag.loopGuard);
			return raw === void 0 ? true : raw !== false;
		},
		override: () => override,
		setOverride(next) {
			override = next;
		},
		defaults() {
			return {
				field: readEnum(bag.loopField, LOOP_FIELD_VALUES, "reasoning"),
				minCycles: readNumber(bag.loopMinCycles, 2, 1, 64),
				minRepeats: readNumber(bag.loopMinRepeats, 3, 2, 64),
				minConfidence: readNumber(bag.loopMinConfidence, .6, 0, 1, false),
				minHits: readNumber(bag.loopMinHits, 1, 1, 64),
				cooldownMs: readNumber(bag.loopCooldownMs, 6e4, 0, 864e5),
				maxTransfers: readNumber(bag.loopMaxTransfers, 3, 0, 64),
				descendants: readEnum(bag.loopDescendants, LOOP_DESCENDANTS_VALUES, "report")
			};
		},
		hasConfig() {
			return readValue(bag.loopGuard) !== void 0;
		}
	};
}
//#endregion
//#region src/commands.ts
/** 本插件在 profile patch 里的 entry id（设置页表单、命令写回都按它定位）。 */
const ENTRY_ID = "dsh-session-bridge";
/** 命令名（小写，注册到 `ctx.commands`）。 */
const COMMAND_NAME = "cot-loop";
/** 通过 cordis 的可选注入拿一个服务；服务不存在时回调不执行（不抛错、不阻塞插件）。 */
function injectService(ctx, names, callback) {
	const candidate = ctx;
	if (typeof candidate.inject !== "function") return;
	try {
		candidate.inject(names, callback);
	} catch {}
}
/**
* 构造"写回插件配置"的函数：定位本插件的 profile entry，把 patch 合并进它的 config。
* 拿不到 configEditor 时返回 ok=false，调用方退化到内存开关。
*/
function createConfigWriter(ctx) {
	let editor;
	injectService(ctx, ["configEditor"], (child) => {
		const candidate = child.configEditor;
		if (candidate !== void 0 && typeof candidate.edit === "function" && typeof candidate.entries === "function") editor = candidate;
	});
	return async (patch) => {
		if (editor === void 0) return {
			ok: false,
			message: "当前宿主没有 configEditor 服务"
		};
		let entry;
		try {
			entry = editor.entries().find((row) => row?.options?.id === "dsh-session-bridge" || row?.options?.name === "dsh-session-bridge");
		} catch (error) {
			return {
				ok: false,
				message: "读取 profile entry 失败：" + messageOf(error)
			};
		}
		if (entry === void 0) return {
			ok: false,
			message: "profile 里找不到 entry「" + ENTRY_ID + "」"
		};
		try {
			await editor.edit(entry, (current) => ({
				...current ?? {},
				...patch
			}));
		} catch (error) {
			return {
				ok: false,
				message: "写入配置失败：" + messageOf(error)
			};
		}
		return {
			ok: true,
			message: "已写入 profile patch：" + Object.keys(patch).join(", ")
		};
	};
}
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
function clampNumber(raw, fallback, min, max, integer) {
	const value = Number(raw);
	if (!Number.isFinite(value)) return void 0;
	const clamped = Math.min(max, Math.max(min, value));
	return integer ? Math.round(clamped) : clamped;
}
/** 状态摘要（命令无参数或 `status` 时输出）。 */
function loopCommandStatus(deps) {
	const defaults = deps.policy.defaults();
	const source = deps.policy.override() === void 0 ? "插件配置" : "内存覆盖（本次运行）";
	return [
		"思维链循环自动中断：" + (deps.policy.enabled() ? "开启" : "关闭") + "（来源：" + source + "）",
		"检测参数：field=" + defaults.field + " " + String(defaults.minCycles) + "x" + String(defaults.minRepeats) + " hits=" + String(defaults.minHits) + " confidence=" + defaults.minConfidence.toFixed(2) + " cooldown=" + String(defaults.cooldownMs) + "ms",
		"转移：maxTransfers=" + String(defaults.maxTransfers) + " descendants=" + defaults.descendants,
		"设置页：设置 → Plugins → " + ENTRY_ID + "（开关 loopGuard，与本命令同一份配置）",
		"用法：/cot-loop on | off | status | field <reasoning|text|both> | descendants <report|stop|ignore> | max-transfers <n> | help"
	].join("\n");
}
const HELP_TEXT = [
	"/cot-loop on|off — 开关思维链循环自动中断（写回插件配置，立即生效）",
	"/cot-loop status — 显示当前开关与检测参数",
	"/cot-loop field reasoning|text|both — 循环检测看哪一段（默认 reasoning 思考阶段）",
	"/cot-loop descendants report|stop|ignore — 转移时如何处理子代理",
	"/cot-loop max-transfers <n> — 同一任务最多转移几次（0 = 只中断不转移）",
	"/cot-loop min-cycles <n> / min-repeats <n> / min-hits <n> — 检测门槛",
	"/cot-loop cooldown <ms> / confidence <0-1> — 冷却与置信度",
	"/cot-loop reset — 丢弃内存覆盖，回到插件配置的值",
	"参数类改动从下一个 monitor_start 起生效；开关（on/off）对已运行的守护立即生效。"
].join("\n");
async function applyPatch(deps, patch, label, live) {
	const written = await deps.writeConfig(patch);
	if (written.ok) return {
		kind: "success",
		text: label + "（已写入插件配置，" + (live ? "立即生效" : "下一个监控生效") + "）\n" + written.message
	};
	return {
		kind: "success",
		text: label + "（未能写入配置：" + written.message + "）\n" + (live ? "已改为本次运行的内存开关，重启后失效。" : "本次运行未改变（参数类改动需要写回配置）。")
	};
}
/**
* 解析并执行一条 `/cot-loop` 输入。
* 纯函数形态（只依赖注入进来的 policy 与写回函数），便于直接单测。
*/
async function runLoopCommand(rawInput, deps) {
	const parts = String(rawInput ?? "").trim().split(/\s+/).filter((part) => part !== "");
	const head = (parts[0] ?? "status").toLowerCase();
	const arg = parts[1];
	switch (head) {
		case "status": return {
			kind: "success",
			text: loopCommandStatus(deps)
		};
		case "help": return {
			kind: "success",
			text: HELP_TEXT
		};
		case "on":
		case "off": {
			const enabled = head === "on";
			const written = await deps.writeConfig({ loopGuard: enabled });
			if (written.ok) {
				deps.policy.setOverride(void 0);
				return {
					kind: "success",
					text: "思维链循环自动中断已" + (enabled ? "开启" : "关闭") + "（已写入插件配置，立即生效）\n" + written.message
				};
			}
			deps.policy.setOverride(enabled);
			return {
				kind: "success",
				text: "思维链循环自动中断已" + (enabled ? "开启" : "关闭") + "（本次运行的内存开关：" + written.message + "）\n重启后失效；要持久化请在设置 → Plugins → dsh-session-bridge 里改 loopGuard，或写进 profile 的 cordis.patch.yml。"
			};
		}
		case "reset":
			deps.policy.setOverride(void 0);
			return {
				kind: "success",
				text: "已丢弃内存覆盖，当前值来自插件配置：" + (deps.policy.enabled() ? "开启" : "关闭")
			};
		case "field": {
			if (arg === void 0) return {
				kind: "error",
				text: "用法：/cot-loop field <reasoning|text|both>"
			};
			const value = arg.toLowerCase();
			if (!LOOP_FIELD_VALUES.includes(value)) return {
				kind: "error",
				text: "未知字段「" + arg + "」，可选：" + LOOP_FIELD_VALUES.join(" / ")
			};
			return applyPatch(deps, { loopField: value }, "检测字段已设为 " + value, false);
		}
		case "descendants": {
			if (arg === void 0) return {
				kind: "error",
				text: "用法：/cot-loop descendants <report|stop|ignore>"
			};
			const value = arg.toLowerCase();
			if (!LOOP_DESCENDANTS_VALUES.includes(value)) return {
				kind: "error",
				text: "未知策略「" + arg + "」，可选：" + LOOP_DESCENDANTS_VALUES.join(" / ")
			};
			return applyPatch(deps, { loopDescendants: value }, "子代理策略已设为 " + value, false);
		}
		case "max-transfers": {
			const value = arg === void 0 ? void 0 : clampNumber(arg, 0, 0, 64, true);
			if (value === void 0) return {
				kind: "error",
				text: "用法：/cot-loop max-transfers <0-64>"
			};
			return applyPatch(deps, { loopMaxTransfers: value }, "最大转移次数已设为 " + String(value), false);
		}
		case "min-cycles": {
			const value = arg === void 0 ? void 0 : clampNumber(arg, 2, 1, 64, true);
			if (value === void 0) return {
				kind: "error",
				text: "用法：/cot-loop min-cycles <1-64>"
			};
			return applyPatch(deps, { loopMinCycles: value }, "最小周期数已设为 " + String(value), false);
		}
		case "min-repeats": {
			const value = arg === void 0 ? void 0 : clampNumber(arg, 3, 2, 64, true);
			if (value === void 0) return {
				kind: "error",
				text: "用法：/cot-loop min-repeats <2-64>"
			};
			return applyPatch(deps, { loopMinRepeats: value }, "最小重复次数已设为 " + String(value), false);
		}
		case "min-hits": {
			const value = arg === void 0 ? void 0 : clampNumber(arg, 1, 1, 64, true);
			if (value === void 0) return {
				kind: "error",
				text: "用法：/cot-loop min-hits <1-64>"
			};
			return applyPatch(deps, { loopMinHits: value }, "触发前命中次数已设为 " + String(value), false);
		}
		case "cooldown": {
			const value = arg === void 0 ? void 0 : clampNumber(arg, 6e4, 0, 864e5, true);
			if (value === void 0) return {
				kind: "error",
				text: "用法：/cot-loop cooldown <毫秒>"
			};
			return applyPatch(deps, { loopCooldownMs: value }, "冷却时间已设为 " + String(value) + "ms", false);
		}
		case "confidence": {
			const value = arg === void 0 ? void 0 : clampNumber(arg, .6, 0, 1, false);
			if (value === void 0) return {
				kind: "error",
				text: "用法：/cot-loop confidence <0-1>"
			};
			return applyPatch(deps, { loopMinConfidence: value }, "置信度阈值已设为 " + value.toFixed(2), false);
		}
		default: return {
			kind: "error",
			text: "未知子命令「" + head + "」。" + HELP_TEXT
		};
	}
}
/** 把 `/cot-loop` 注册进宿主命令面；没有 commands 服务时静默跳过。 */
function registerLoopCommands(ctx, deps) {
	injectService(ctx, ["commands"], (child) => {
		const service = child.commands;
		if (service === void 0 || typeof service.register !== "function") return;
		service.register({
			name: COMMAND_NAME,
			description: "思维链循环自动中断：开关、状态与调参（与设置页共用同一份配置）",
			input: { hint: "on | off | status | field <reasoning|text|both> | descendants <report|stop|ignore> | max-transfers <n> | help" },
			handler: (payload) => runLoopCommand(String(payload?.rawInput ?? ""), deps)
		});
	});
}
//#endregion
//#region src/index.ts
/** Plugin identity for cordis rows. */
const name = "dsh-session-bridge";
/** Services required before mounting. */
const inject = [
	"sessions",
	"agents",
	"sessionPersistence",
	"workspaceRegistry",
	"agentPresets",
	"tools",
	"timer"
];
/** Host plugin body. */
function apply(ctx, config) {
	const registry = new BridgeRegistry();
	registry.load().catch((error) => {
		console.warn("[dsh-session-bridge] registry load failed:", error instanceof Error ? error.message : String(error));
	});
	const policy = createLoopPolicy(config);
	const monitor = new SessionMonitor(ctx, registry, void 0, policy);
	registerBridgeTools({
		ctx,
		registry,
		monitor,
		policy
	});
	registerLoopCommands(ctx, {
		policy,
		writeConfig: createConfigWriter(ctx)
	});
	ctx.effect(() => () => monitor.dispose());
}
//#endregion
export { Config, apply, inject, name };

//# sourceMappingURL=index.js.map