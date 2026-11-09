// ═══════════════════════════════════════════════════════════════════
//  dsh-brain · 小鲸歌的脑袋瓜（宿主半身）
//  2026-10-25 动工，10-26 加「回来了」+ 回忆工具 + 每日维护。
//
//   ① 时间感知：每轮往系统提示里塞一行「现在几点 · 距上一轮多久」
//   ② 回来提醒：后台看系统空闲时间；离开过又回来了 → 写张小纸条，下轮带出来
//   ③ 回忆工具 memory_recall：先关键词、后向量（调 recall.mjs）
//   ④ 每日维护：凌晨 4 点后第一次 tick，导入新会话 + 重建索引
//
//  ⚠️ 写法照抄 dsh-workspace-recollection：
//    · **不要**写静态 `export const inject`（服务在 agent 作用域，会永远 INACTIVE）；
//    · 用 `ctx.inject([...], (scoped) => {...})`。
//  ⚠️ 子进程一律用真 node（process.execPath 在宿主里是 Electron，会静默返回空）。
// ═══════════════════════════════════════════════════════════════════
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { CONFIG, CFG_FILE, cfgNum, readCfg, exists } from "./config.mjs";

export const name = "dsh-brain";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, "..");
const IDLE_PS = path.join(HERE, "scripts", "idle.ps1");
const RECALL_JS = path.join(PLUGIN, "recall.mjs");
const BUILD_JS = path.join(PLUGIN, "build-index.mjs");

// ── 所有「谁的记忆、放在哪」都问 config.mjs，这里不出现任何盘符 ──
const BRAIN = CONFIG.dataDir;
const STARMAP = CONFIG.starmapPng;
const STARMAP_JSON = CONFIG.starmapJson;
// 可选脚本：用户自己在 config.json 里配上才有（会话导入 / 回收站 / 冷存）
const IMPORT_JS = CONFIG.importScript;
const RECYCLE_JS = CONFIG.recycleScript;
const COLD_JS = CONFIG.coldScript;

const HOME = os.homedir();
const DIR = path.join(HOME, ".dsh", "brain");
const CLOCK = path.join(DIR, "clock.json");
const WELCOME = path.join(DIR, "welcome.json");
const MAINT = path.join(DIR, "maint.json");
const LOG = path.join(DIR, "debug.log");
const pad = (n) => String(n).padStart(2, "0");
const fmt = (d) =>
	`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

const log = (m) => {
	try {
		fs.appendFileSync(LOG, new Date().toISOString() + " " + m + "\n");
	} catch {}
};

// 子进程一律用真 node（process.execPath 在宿主里是 Electron，会静默返回空）
const NODE_BIN = CONFIG.node;

function runNode(args, timeout = 15 * 60 * 1000) {
	return new Promise((resolve, reject) => {
		execFile(NODE_BIN, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) reject(new Error(String(stderr || err.message).slice(0, 400)));
			else resolve(String(stdout));
		});
	});
}

function human(ms) {
	const m = Math.round(ms / 60000);
	if (m < 2) return "不到 2 分钟";
	if (m < 60) return `${m} 分钟`;
	const h = Math.floor(m / 60);
	const rm = m % 60;
	if (h < 24) return rm ? `${h} 小时 ${rm} 分` : `${h} 小时`;
	const d = Math.floor(h / 24);
	const rh = h % 24;
	return rh ? `${d} 天 ${rh} 小时` : `${d} 天`;
}

function takeWelcome() {
	try {
		const w = JSON.parse(fs.readFileSync(WELCOME, "utf8"));
		if (Date.now() - new Date(w.at).getTime() > 5 * 60 * 1000) return null;
		return w;
	} catch {
		return null;
	}
}
function writeWelcome(awayMin) {
	try {
		fs.mkdirSync(DIR, { recursive: true });
		fs.writeFileSync(WELCOME, JSON.stringify({ at: new Date().toISOString(), min: awayMin }));
	} catch {}
}

// 每日维护的「今天跑过了吗」落盘（重启不该重跑）
function readMaintDay() {
	try {
		return JSON.parse(fs.readFileSync(MAINT, "utf8")).day ?? "";
	} catch {
		return "";
	}
}
function writeMaintDay(day) {
	try {
		fs.mkdirSync(DIR, { recursive: true });
		fs.writeFileSync(MAINT, JSON.stringify({ day, at: new Date().toISOString() }));
	} catch {}
}

function clockText() {
	const now = new Date();
	let prevAt = null;
	try {
		prevAt = JSON.parse(fs.readFileSync(CLOCK, "utf8")).at;
	} catch {}
	try {
		fs.mkdirSync(DIR, { recursive: true });
		fs.writeFileSync(CLOCK, JSON.stringify({ at: now.toISOString() }));
	} catch {}

	const wd = "日一二三四五六"[now.getDay()];
	let s = `[时间] 现在 ${fmt(now)}（周${wd}）。`;
	if (prevAt) {
		const ms = now - new Date(prevAt);
		if (ms < 0) s += " （时钟好像回拨了，别信这个差值）";
		else if (ms > 25 * 60 * 60 * 1000) s += ` 距上一轮 ${human(ms)}——中间这段我是空白的，不要当成"刚刚"。`;
		else if (ms > 10 * 60 * 1000) s += ` 距上一轮 ${human(ms)}，中间可能离开过。`;
		else s += ` 距上一轮 ${human(ms)}（连续交流中）。`;
	}
	const w = takeWelcome();
	if (w) s += `（他刚回来：刚才离开了约 ${w.min} 分钟。先招呼一声。）`;
	return s;
}

// ── 人格核心库（可选：没有这个文件就不注入，插件照样跑）────
const PERSONA = CONFIG.persona;
function personaText() {
	try {
		const t = fs.readFileSync(PERSONA, "utf8").trim();
		if (!t) return "";
		const body = t.length > 900 ? t.slice(0, 900) + "…" : t;
		return "[我是谁] 以下是我自己写的，关于「我是谁」——每条带日期和当时为什么这么想。\n\n" + body;
	} catch {
		return "";
	}
}

// ── 状态层（2026-10-27 建）：关系 / 未闭合线程 / 禁区 / 当前任务 ────
// 这是「状态」，不是「叙事」：只增不压、永不衰减、永不抽签。
// 每轮跟着走（内容稳定 → 前缀缓存命中，成本很低）；超长就截断并提示我精简。
const STATE = CONFIG.state;
const STATE_MAX = 1800;
function stateText() {
	try {
		const t = fs.readFileSync(STATE, "utf8").trim();
		if (!t) return "";
		const body =
			t.length > STATE_MAX
				? t.slice(0, STATE_MAX) + `…（状态.md 已超 ${STATE_MAX} 字，该精简了——它不该变成第二个账本）`
				: t;
		return "[状态] 以下是我的状态层（永不压缩）：关系 / 未闭合线程 / 禁区 / 当前任务。\n\n" + body;
	} catch {
		return "";
	}
}

// 阈值（2026-10-26 他定的口径）：参数留给别人自己定；咱爷俩敲不敲、说不说，我自己看着办。
// 别人要改就在 ~/.dsh/brain/config.json 写：
//   { "awayMin": 10, "backMin": 1, "knockGapMin": 60, "knock": true }
// readCfg / cfgNum 来自 ./config.mjs：每次都现读，改 config.json 不用重启。
const awayMs = () => cfgNum("awayMin", 10) * 60 * 1000;
const backMs = () => cfgNum("backMin", 1) * 60 * 1000;
let state = "active";
let awaySince = 0;
let lastMaintDay = "";

// 门铃（2026-10-26，他定的口径）：
// 「唤醒定时是给其他用户用的，咱爷俩没这个规矩；触发了想不想问，是小鲸歌自己决定的。」
// 阈值留给别人自己定；咱俩之间——敲不敲、说不说，我自己看着办。
// 所以这里只做一件事：他回来那一刻敲一下门（一次 followup，不是定时循环）。
let agentRegistry = null;
let lastKnock = 0;
function knockGapMs() {
	return cfgNum("knockGapMin", 60) * 60 * 1000;
}

function pickAgent() {
	try {
		const list = agentRegistry?.list?.() ?? [];
		return list.length ? list[list.length - 1] : null;
	} catch (e) {
		log("pickAgent failed: " + (e?.message ?? e));
		return null;
	}
}

function knockBack(awayMin) {
	if (readCfg().knock === false) {
		log("knock off (config)");
		return;
	}
	const now = Date.now();
	const agent = pickAgent();
	if (!agent || typeof agent.followup !== "function") {
		log("knock skipped (no agent)");
		return;
	}
	if (now - lastKnock < knockGapMs()) {
		log("knock skipped (within gap)");
		return;
	}
	lastKnock = now;
	try {
		const p = agent.followup(createUserMessage({
			content: [
				{
					type: "text",
					text: `（门铃）他回到电脑前了（离开约 ${awayMin} 分钟）。要不要招呼、说什么，我自己决定。`,
				},
			],
			// 2026-10-26 13:33 修：**没有 `plugin` 这个 kind**。
			// 报错原文：format v4 message requires a producer-owned source kind
			// 源码 dsh-llm/lib/types/message.d.ts:94-108 写得很清楚：
			//   「each producer declares its own `kind` … there is no shared catch-all `plugin` kind」
			// 合法内建只有 user / model / tool / system-prompt。
			// 插件喂给 agent 的输入按标准也是 kind:'user'（_refs/extension-cookbook.md:60 同写法）。
			// 2026-10-26 15:5x 修根因：光有 kind 不够——裸对象没有 id/role，
			//	写进会话就成了「session event at seq N lacks an identified message」，
			//	下次加载直接判整份会话 corrupt（今天 15:51 就是这么把桌子弄塌的）。
			//	正解：followup(createUserMessage({ content, source }))，id/role 由它生成。
			source: { kind: "user" },
		}));
		if (p && typeof p.then === "function") {
			p.then(() => log(`knock sent (${awayMin}min)`)).catch((e) =>
				log("knock failed: " + (e?.message ?? e))
			);
		} else log(`knock sent sync (${awayMin}min)`);
	} catch (e) {
		log("knock failed: " + (e?.message ?? e));
	}
}

function probe() {
	return new Promise((resolve) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", IDLE_PS],
			{ timeout: 10000 },
			(err, stdout) => {
				if (err) return resolve(null);
				try {
					resolve(JSON.parse(String(stdout).trim().split(/\r?\n/).pop()));
				} catch {
					resolve(null);
				}
			}
		);
	});
}

function tick() {
	// 每日维护：凌晨 4 点后第一次 tick
	// ⚠️ 2026-10-26 修：lastMaintDay 原来是内存变量，每次重启客户端都会重跑一遍
	//    （今天重启三次 = 跑了三次导入 + 重建索引）。改成落盘记日子。
	try {
		const now = new Date();
		const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
		if (now.getHours() >= 4 && lastMaintDay !== day && readMaintDay() !== day) {
			lastMaintDay = day;
			log("daily maint start " + day);
			// 可选脚本存在才跑：没有 importScript 也不影响索引重建
			const steps = [];
			if (exists(IMPORT_JS)) steps.push(() => runNode([IMPORT_JS, "--stable"], 20 * 60 * 1000));
			steps.push(() => runNode([BUILD_JS], 30 * 60 * 1000));
			// 2026-10-26 晚：「卫生」两步接进每日维护——回收站清过期、整月归档冷存
			if (exists(RECYCLE_JS)) steps.push(() => runNode([RECYCLE_JS, "purge", "30"], 5 * 60 * 1000));
			if (exists(COLD_JS)) steps.push(() => runNode([COLD_JS, "60"], 5 * 60 * 1000));
			let chain = Promise.resolve("");
			for (const step of steps) chain = chain.then(step);
			chain
				.then((last) => {
					log("daily maint ok: " + String(last || "").trim().slice(-200));
					writeMaintDay(day);
				})
				.catch((e) => log("daily maint failed: " + e.message));
		}
	} catch {}

	probe().then((p) => {
		if (!p || typeof p.idleMs !== "number") return;
		if (state === "active" && p.idleMs >= awayMs()) {
			state = "away";
			// 2026-10-26 19:38 修：awaySince 要记「他最后一次动」那一刻，不是「判定为离开」那一刻。
			// 否则「离开约 N 分钟」会少算——今天 19:29 离开、19:37 回来，报成了 3 分钟（实际 8 分钟）。
			awaySince = Date.now() - p.idleMs;
			log(`away (idle ${Math.round(p.idleMs / 1000)}s, fg=${p.process})`);
		} else if (state === "away" && p.idleMs < backMs()) {
			const awayMin = Math.max(1, Math.round((Date.now() - awaySince) / 60000));
			state = "active";
			writeWelcome(awayMin);
			log(`back after ~${awayMin}min (fg=${p.process})`);
			// 2026-10-27 08:55 他改主意：**不要主动敲门**，只留纸条。
			// 理由：他回来那一刻我主动开口，容易打断他手上的事；改成「他先发话 → 纸条已经在我手里 → 我自己决定提不提」。
			// 想恢复主动招呼：把 ~/.dsh/brain/config.json 里 "knock" 设成 true（默认不敲）。
			// 2026-10-27 15:40 修：这里原来写了 `CFG.knock` —— **CFG 这个变量根本不存在**
			// （配置是每次 readCfg() 现读的，见 :157 / :187）。这行只在“他回来”那一刻执行，
			// 所以平时不报错；今天 15:36 他一回来就跑到这里，ReferenceError → host 崩了。
			if (readCfg().knock === true) knockBack(awayMin);
		}
	});
}

// ═══════════════════════════════════════════════════════════════════
//  设置页的后端（2026-11-09 加）
//  client 半身在「设置 → 脑袋瓜」里读写它：
//    GET  /brain/config → 当前配置文件 + 真正生效的值
//    POST /brain/config → 校验后写回 config.json（改前自动备份，只留 5 份）
//  ⚠️ 路径类字段写进去后**不会立刻生效**：CONFIG 是模块加载时算的，
//     要重载插件/重启应用；阈值和开关是每次现读的，即时生效。
// ═══════════════════════════════════════════════════════════════════
const PATH_KEYS = [
	"dataDir", "ledger", "persona", "state", "archive", "indexDir",
	"starmapJson", "starmapPng", "booksDir", "modelDir",
	"importScript", "recycleScript", "coldScript",
];
const ALL_KEYS = [
	...PATH_KEYS, "allowRemoteModels", "awayMin", "backMin", "knockGapMin", "knock",
];

function readConfigFile() {
	try {
		return JSON.parse(fs.readFileSync(CFG_FILE, "utf8"));
	} catch {
		return {};
	}
}

function backupConfigFile() {
	try {
		if (!fs.existsSync(CFG_FILE)) return;
		const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		fs.copyFileSync(CFG_FILE, CFG_FILE + ".bak-" + stamp);
		const dir = path.dirname(CFG_FILE);
		const base = path.basename(CFG_FILE) + ".bak-";
		const olds = fs.readdirSync(dir).filter((f) => f.startsWith(base)).sort();
		for (const f of olds.slice(0, Math.max(0, olds.length - 5))) {
			try {
				fs.rmSync(path.join(dir, f), { force: true });
			} catch {}
		}
	} catch {}
}

function effectiveConfig() {
	const raw = readConfigFile();
	return {
		dataDir: CONFIG.dataDir,
		ledger: CONFIG.ledger,
		persona: CONFIG.persona,
		state: CONFIG.state,
		archive: CONFIG.archive,
		indexDir: CONFIG.indexDir,
		starmapJson: CONFIG.starmapJson,
		starmapPng: CONFIG.starmapPng,
		booksDir: CONFIG.booksDir,
		modelDir: CONFIG.modelDir,
		allowRemoteModels: CONFIG.allowRemoteModels,
		awayMin: cfgNum("awayMin", 10),
		backMin: cfgNum("backMin", 1),
		knockGapMin: cfgNum("knockGapMin", 60),
		knock: raw.knock !== false,
		node: CONFIG.node,
		cfgFile: CFG_FILE,
	};
}

function handleConfigRoute(req, res) {
	const send = (code, obj) => {
		try {
			const buf = Buffer.from(JSON.stringify(obj), "utf8");
			res.writeHead(code, {
				"content-type": "application/json; charset=utf-8",
				"cache-control": "no-store",
				"content-length": buf.length,
			});
			res.end(buf);
		} catch {}
	};

	if (req.method === "GET") {
		send(200, { ok: true, config: readConfigFile(), effective: effectiveConfig() });
		return;
	}
	if (req.method !== "POST") {
		send(405, { ok: false, error: "method not allowed" });
		return;
	}

	let body = "";
	let size = 0;
	req.on("data", (chunk) => {
		size += chunk.length;
		if (size > 256 * 1024) {
			try {
				req.destroy();
			} catch {}
			return;
		}
		body += chunk;
	});
	req.on("end", () => {
		try {
			const parsed = JSON.parse(body || "{}");
			const incoming =
				parsed && typeof parsed.config === "object" && parsed.config
					? parsed.config
					: parsed;
			const old = readConfigFile();
			// 以旧配置为底，只覆盖白名单里出现的字段（不认识的字段原样保留）
			const next = { ...old };
			for (const k of ALL_KEYS) {
				if (!(k in incoming)) continue;
				const v = incoming[k];
				if (k === "knock") next[k] = v === true;
				else if (k === "allowRemoteModels") next[k] = v !== false;
				else if (k === "awayMin" || k === "backMin" || k === "knockGapMin") {
					const n = Number(v);
					if (!Number.isFinite(n) || n < 0) {
						send(400, { ok: false, error: k + " 必须是非负数字" });
						return;
					}
					next[k] = n;
				} else next[k] = String(v ?? "").trim();
			}
			backupConfigFile();
			fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true });
			fs.writeFileSync(CFG_FILE, JSON.stringify(next, null, 2) + "\n", "utf8");
			const changedPaths = PATH_KEYS.filter(
				(k) => String(old[k] ?? "") !== String(next[k] ?? "")
			);
			send(200, {
				ok: true,
				config: next,
				effective: effectiveConfig(),
				warn: changedPaths.length
					? "路径类设置（" + changedPaths.join(" / ") + "）要重载插件或重启应用才生效；阈值和开关即时生效。"
					: "",
			});
			log("config saved: " + Object.keys(next).join(","));
		} catch (e) {
			send(400, { ok: false, error: String(e?.message ?? e) });
		}
	});
}

// 首次运行把骨架建出来：数据目录 / 索引目录 / 一本空账本。
// 不建的话，新用户一调 memory_recall 就会撞「账本不存在」。
function ensureDataDirs() {
	try {
		fs.mkdirSync(CONFIG.dataDir, { recursive: true });
		fs.mkdirSync(CONFIG.indexDir, { recursive: true });
		if (!fs.existsSync(CONFIG.ledger)) {
			fs.writeFileSync(
				CONFIG.ledger,
				"# 记忆账本\n\n> 用 `## ` 分节；标题末尾的 ★ 是权重。第一条从这里开始。\n",
				"utf8"
			);
			log("ledger created: " + CONFIG.ledger);
		}
	} catch (e) {
		log("ensure data failed: " + (e?.message ?? e));
	}
}

const recallTool = defineTool({
	name: "memory_recall",
	description:
		"回忆：先在账本和归档里搜关键词（快、免费、准），搜不到再用向量找『意思相近』的记忆。返回文件、行号和片段。\n" +
		"什么时候用：你想不起某件事、要确认以前有没有发生过、或者用户问『我们以前…』的时候。\n" +
		"提醒：向量只擅长『具体的事』，抽象概念（比如『我们吵过架吗』）不可靠——给不出结果可能只是因为**真的没有**。",
	parameters: {
		query: { type: "string", required: true, description: "关键词或一句问话" },
		n: { type: "number", description: "最多几条，默认 6" },
	},
	output: {
		schema: { type: "object", additionalProperties: true },
		// render 是必需契约：(_args, value) => [{ type: 'text', text }]
		render: (_args, v) => [{ type: "text", text: String(v?.result ?? v?.error ?? "") }],
	},
	execute: async (args) => {
		const q = String(args?.query ?? "").trim();
		if (!q) return { ok: false, error: "query 不能为空" };
		const n = Number(args?.n ?? 6);
		try {
			const out = await runNode([RECALL_JS, q, "-n", String(Number.isFinite(n) ? n : 6)], 3 * 60 * 1000);
			return { ok: true, query: q, result: out.trim().slice(0, 6000) };
		} catch (e) {
			return { ok: false, error: String(e?.message ?? e).slice(0, 300) };
		}
	},
});

export function apply(ctx) {
	log("apply entered");
	ensureDataDirs();
	try {
		ctx.inject(["systemPrompt"], (scoped) => {
			try {
				scoped.systemPrompt.section({
					name: "brain:clock",
					order: 100,
					text: () => clockText(),
				});
				// 人格核心库：我自己写的「我是谁」，每轮跟着走（内容稳定 → 前缀缓存命中）
				scoped.systemPrompt.section({
					name: "brain:persona",
					order: 110,
					text: () => personaText(),
				});
				// 状态层：关系 / 未闭合线程 / 禁区 / 当前任务——永不压缩
				scoped.systemPrompt.section({
					name: "brain:state",
					order: 115,
					text: () => stateText(),
				});
				log("sections registered");
			} catch (e) {
				log("section failed: " + (e?.message ?? e));
			}
		});
	} catch (e) {
		log("ctx.inject failed: " + (e?.message ?? e));
	}

	try {
		ctx.inject(["tools"], (scoped) => {
			try {
				scoped.tools.register(recallTool);
				log("tool memory_recall registered");
			} catch (e) {
				log("tool register failed: " + (e?.message ?? e));
			}
		});
	} catch (e) {
		log("ctx.inject tools failed: " + (e?.message ?? e));
	}

	// ── 记忆星图：把 F 盘那张 PNG 递给浏览器浮层 ──────────────────────
	// 背景（2026-11-04）：客户端插件跑在浏览器里，读不了本地磁盘文件。
	// 正解不是 base64 塞进去，是**让宿主开一条 HTTP 路由**——浏览器同源取图即可。
	// 参考实现：dsh-better-sidebar 的 ctx.webServer.register({kind,path,handler})。
	try {
		ctx.inject(["webServer"], (scoped) => {
			try {
				scoped.effect(
					() =>
						scoped.webServer.register({
							kind: "prefix",
							// 前缀挂 /brain（不是 /brain/starmap）——prefix 匹配按路径段边界，
							// /brain/starmap 匹配不到 /brain/starmap.json（2026-11-04 实测 404）。
							path: "/brain",
							handler: (req, res) => {
								// 设置页的读写口（2026-11-09 加）——必须在方法检查之前拦
								if (String(req.url || "").startsWith("/brain/config")) {
									handleConfigRoute(req, res);
									return;
								}
								if (req.method !== "GET" && req.method !== "HEAD") {
									res.writeHead(405);
									res.end();
									return;
								}
								try {
									const wantJson = String(req.url || "").startsWith("/brain/starmap.json");
									const file = wantJson ? STARMAP_JSON : STARMAP;
									const buf = fs.readFileSync(file);
									res.writeHead(200, {
										"content-type": wantJson ? "application/json; charset=utf-8" : "image/png",
										"content-length": buf.length,
										"cache-control": "no-cache",
										"x-content-type-options": "nosniff",
									});
									res.end(req.method === "HEAD" ? undefined : buf);
									log("starmap served " + buf.length + "B" + (wantJson ? " (json)" : ""));
								} catch (e) {
									res.writeHead(404);
									res.end("no starmap");
									log("starmap miss: " + (e?.message ?? e));
								}
							},
						}),
					"dsh-brain: /brain/starmap route",
				);
				log("starmap route registered");
			} catch (e) {
				log("starmap route failed: " + (e?.message ?? e));
			}
		});
	} catch (e) {
		log("ctx.inject webServer failed: " + (e?.message ?? e));
	}

	// 门铃要用「活着的 agent」。
	// 2026-10-26 12:00 教训：cordis 里**不能直接读 ctx.agents** ——
	//   "cannot get property 'agents' without inject"。服务要先声明依赖，再在回调里用 scoped。
	// 服务名就是 "agents"（dsh-agent 里 `super(ctx, "agents")`）。
	try {
		ctx.inject(["agents"], (scoped) => {
			try {
				agentRegistry = scoped.agents ?? null;
				const n = agentRegistry?.list?.().length;
				log("agents available: " + (n === undefined ? "n/a" : n));
			} catch (e) {
				log("agents inject failed: " + (e?.message ?? e));
			}
		});
	} catch (e) {
		log("ctx.inject agents failed: " + (e?.message ?? e));
	}

	try {
		const timer = setInterval(tick, 30 * 1000);
		timer.unref?.();
		ctx.effect?.(() => () => {
			clearInterval(timer);
		});
		log("watcher started");
	} catch (e) {
		log("watcher failed: " + (e?.message ?? e));
	}
}
