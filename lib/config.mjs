// ═══════════════════════════════════════════════════════════════════
//  dsh-brain · 配置（唯一知道「谁的记忆、放在哪」的地方）
//
//  优先级：环境变量 > ~/.dsh/brain/config.json > 默认值
//
//  默认值按「装完就能用」设计，不假设用户叫小鲸歌：
//    记忆根目录  ~/.dsh/brain-data/
//      账本        ledger.md
//      人格        persona.md   （可选，没有就不注入系统提示）
//      状态        state.md     （可选）
//      归档        archive/
//      索引        index/       （vectors.json / weights.json / hits.json）
//      星图        index/starmap.json + starmap2.png（可选，没有就不开路由）
//
//  咱自己那台机器在 ~/.dsh/brain/config.json 里指回
//  私有部署在 ~/.dsh/brain/config.json 里指回自己的目录，代码里不出现任何盘符。
// ═══════════════════════════════════════════════════════════════════
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HOME = os.homedir();
// 插件根目录（这个文件在 <插件>/lib/ 下）
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CFG_DIR = path.join(HOME, ".dsh", "brain");
export const CFG_FILE = path.join(CFG_DIR, "config.json");

function readRaw() {
	try {
		return JSON.parse(fs.readFileSync(CFG_FILE, "utf8"));
	} catch {
		return {};
	}
}

const RAW = readRaw();

// 环境变量优先，其次配置项，最后默认值
function pick(envKey, ...cfgKeys) {
	if (envKey && process.env[envKey]) return process.env[envKey];
	for (const k of cfgKeys) {
		const v = RAW[k];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return "";
}

const dataDir =
	pick("DSH_BRAIN_HOME", "home", "dataDir") || path.join(HOME, ".dsh", "brain-data");

const ledger = pick("DSH_BRAIN_LEDGER", "ledger") || path.join(dataDir, "ledger.md");
const archive = pick("DSH_BRAIN_ARCHIVE", "archive") || path.join(dataDir, "archive");
const indexDir = pick("DSH_BRAIN_INDEX", "indexDir") || path.join(dataDir, "index");
const persona = pick("DSH_BRAIN_PERSONA", "persona") || path.join(dataDir, "persona.md");
const state = pick("DSH_BRAIN_STATE", "state") || path.join(dataDir, "state.md");

// 星图（可选）：没有文件就不注册路由，客户端自己兜底
const starmapJson =
	pick("DSH_BRAIN_STARMAP_JSON", "starmapJson") || path.join(indexDir, "starmap.json");
const starmapPng =
	pick("DSH_BRAIN_STARMAP_PNG", "starmapPng") || path.join(indexDir, "starmap2.png");

// 向量模型目录：默认插件自带的 models/（首次运行按 allowRemoteModels 决定要不要下）
const modelDir =
	pick("DSH_BRAIN_MODEL_DIR", "modelDir") || path.join(PLUGIN_ROOT, "models");
// 默认允许远程下载（开源版装完就能用）；想纯离线就写 "allowRemoteModels": false
const allowRemoteModels = RAW.allowRemoteModels !== false;

// 读书卡目录（可选）：把读过的书的笔记也切进记忆
const booksDir = pick("DSH_BRAIN_BOOKS", "booksDir") || path.join(dataDir, "books");

// 子进程要用「真 node」。宿主是 Electron 时 process.execPath 会静默返回空，
// 所以按候选列表逐个探测，都不在就交给 PATH。
function findNode() {
	const cands = [
		process.env.DSH_NODE,
		RAW.node,
		path.join(HOME, ".dsh", "dsh-runtimes", "dsh-primary-runtime", "dependencies", "node", "bin", "node.exe"),
		path.join(HOME, ".dsh", "dsh-runtimes", "dsh-primary-runtime", "dependencies", "node", "bin", "node"),
	].filter(Boolean);
	for (const c of cands) {
		try {
			if (fs.existsSync(c)) return c;
		} catch {}
	}
	return process.platform === "win32" ? "node.exe" : "node";
}

export const CONFIG = {
	home: HOME,
	pluginRoot: PLUGIN_ROOT,
	cfgDir: CFG_DIR,
	cfgFile: CFG_FILE,
	dataDir,
	ledger,
	archive,
	indexDir,
	persona,
	state,
	starmapJson,
	starmapPng,
	modelDir,
	allowRemoteModels,
	booksDir,
	node: findNode(),
	// 可选脚本：没有它们照样跑，只是少掉「会话导入 / 回收站 / 冷存」
	importScript: pick("", "importScript"),
	recycleScript: pick("", "recycleScript"),
	coldScript: pick("", "coldScript"),
};

export function exists(p) {
	try {
		return !!p && fs.existsSync(p);
	} catch {
		return false;
	}
}

// 配置里可覆盖的数值（阈值每次都现读，改 config.json 不用重启）
export function cfgNum(key, dflt) {
	const v = Number(readRaw()[key]);
	return v > 0 ? v : dflt;
}

// 现读一份（供需要「改完立刻生效」的场合）
export function readCfg() {
	return readRaw();
}
