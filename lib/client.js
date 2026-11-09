// ═══════════════════════════════════════════════════════════════════
//  dsh-brain · client 半身
//  2026-11-04 19:00 起：记忆星图（静态版 → 交互版）
//
//  两个落点：
//    1) conversation.composer.dock —— 输入框旁的「🌟 星图」按钮
//    2) shell.overlay —— 点开后的全屏浮层（Canvas 交互星图）
//
//  数据：host 的 /brain/starmap.json（564 主点 + 10634 星尘）
//        坐标系沿用 PNG 版的 2200x2200，前端按比例缩放
//
//  ⚠️ 不用构建：__ModuleLoader__ 提供 require("react")，手写即可。
//     写法和 dsh-voice/lib/client.js 同构，那是 2026-10-19 验证过的。
// ═══════════════════════════════════════════════════════════════════
(function () {
	window.__ModuleLoader__.load({
		id: "dsh-brain",
		factory: function (require) {
			var React = require("react");
			var h = React.createElement;

			// ── 跨落点共享的「开/关」状态（按钮和浮层是独立注册的两个组件）──
			var listeners = new Set();
			var isOpen = false;

			function emit() {
				listeners.forEach(function (fn) {
					try {
						fn();
					} catch (e) {}
				});
			}
			function setOpen(v) {
				if (isOpen === v) return;
				isOpen = v;
				emit();
			}
			function useIsOpen() {
				var st = React.useState(isOpen);
				var set = st[1];
				React.useEffect(function () {
					var fn = function () {
						set(isOpen);
					};
					listeners.add(fn);
					return function () {
						listeners.delete(fn);
					};
				}, []);
				return st[0];
			}

			/** 输入框旁的按钮 */
			function StarButton() {
				var open = useIsOpen();
				return h(
					"button",
					{
						type: "button",
						onClick: function () {
							setOpen(!isOpen);
						},
						title: "记忆星图（θ=日期 / r=主题）",
						style: {
							display: "inline-flex",
							alignItems: "center",
							gap: 6,
							padding: "4px 12px",
							margin: "4px 8px",
							borderRadius: 999,
							border: open
								? "1px solid rgba(150, 220, 255, 0.75)"
								: "1px solid rgba(150, 220, 255, 0.35)",
							background: open ? "rgba(150, 220, 255, 0.22)" : "rgba(150, 220, 255, 0.10)",
							color: "inherit",
							fontSize: 12,
							cursor: "pointer"
						}
					},
					"🌟 星图"
				);
			}

			// ══════════════════════════════════════════════════════
			//  交互星图
			// ══════════════════════════════════════════════════════
			var WORLD = 2200;

			// ══════════════════════════════════════════════════════
			//  3D 星图（手写 WebGL 点云）· 2026-11-05
			//
			//  老大要的是「3D 会动的」。不用 three.js 的理由：
			//  564 主点 + 10634 星尘全是「点」，一次 drawArrays 就够，
			//  不需要场景图；也就不必依赖 CDN，不用往 /brain 路由塞 600KB。
			//  加色混合做出来的星尘比 2D 的 alpha 叠加更像星云。
			//
			//  2D 的 (x,y) 盘面 → 3D：把盘倾斜立起来，再按索引给每个点一个
			//  「厚度」抖动（主点薄盘 ±120，星尘厚晕 ±520，2200 尺度）。
			//  ⚠️ 拿不到 webgl 上下文 → StarStage 自动退回 2D（Starmap）。
			// ══════════════════════════════════════════════════════
			var VERT_SRC = [
				"attribute vec3 aPos;",
				"attribute vec3 aCol;",
				"attribute float aSize;",
				"attribute float aAlpha;",
				"attribute float aLayer;", // 主题索引：分类筛选时按它变暗
				"uniform mat4 uMat;",
				"uniform float uScale;",
				"uniform float uFilter;", // -1 = 不筛；>=0 = 只亮这一类
				"varying vec3 vCol;",
				"varying float vFade;",
				"varying float vA;",
				"varying float vDim;",
				"void main() {",
				"  vec4 p = uMat * vec4(aPos, 1.0);",
				"  gl_Position = p;",
				// ⚠️ 2026-11-05 踩过：这里原来写的 -p.z，那是裁剪空间 z（透视后变正数），
				//    max(1.0, -p.z) 恒为 1 → 每点都画成 72px 巨块 → 整屏白。
				//    距离要用齐次 w（标准透视下 w == 相机空间深度）。
				"  float d = max(1.0, p.w);",
				"  gl_PointSize = clamp(aSize * uScale / d, 1.0, 72.0);",
				"  vCol = aCol;",
				"  vFade = clamp(1.35 - d / 1700.0, 0.08, 1.0);",
				"  vA = aAlpha;",
				// 分类筛选：选中某类时，别的类压到 6% 亮度，仍看得见轮廓
				"  vDim = (uFilter < -0.5 || abs(aLayer - uFilter) < 0.5) ? 1.0 : 0.06;",
				"}"
			].join("\n");

			var FRAG_SRC = [
				"precision mediump float;",
				"varying vec3 vCol;",
				"varying float vFade;",
				"varying float vA;",
				"varying float vDim;",
				"void main() {",
				"  vec2 q = gl_PointCoord - vec2(0.5);",
				"  float r = length(q) * 2.0;",
				"  if (r > 1.0) discard;",
				"  float a = pow(1.0 - r, 1.8);",
				"  gl_FragColor = vec4(vCol * vFade, a * vA * vDim);",
				"}"
			].join("\n");

			function matI() {
				return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
			}
			function matMul(a, b) {
				var o = new Float32Array(16);
				for (var c = 0; c < 4; c += 1) {
					for (var r = 0; r < 4; r += 1) {
						o[c * 4 + r] =
							a[r] * b[c * 4] +
							a[4 + r] * b[c * 4 + 1] +
							a[8 + r] * b[c * 4 + 2] +
							a[12 + r] * b[c * 4 + 3];
					}
				}
				return o;
			}
			function matRotY(a) {
				var c = Math.cos(a);
				var s = Math.sin(a);
				var m = matI();
				m[0] = c;
				m[2] = -s;
				m[8] = s;
				m[10] = c;
				return m;
			}
			function matRotX(a) {
				var c = Math.cos(a);
				var s = Math.sin(a);
				var m = matI();
				m[5] = c;
				m[6] = s;
				m[9] = -s;
				m[10] = c;
				return m;
			}
			function matTrans(x, y, z) {
				var m = matI();
				m[12] = x;
				m[13] = y;
				m[14] = z;
				return m;
			}
			function matPersp(fovy, aspect, near, far) {
				var f = 1 / Math.tan(fovy / 2);
				var m = new Float32Array(16);
				m[0] = f / aspect;
				m[5] = f;
				m[10] = (far + near) / (near - far);
				m[11] = -1;
				m[14] = (2 * far * near) / (near - far);
				return m;
			}
			function hash01(i) {
				var x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
				return x - Math.floor(x);
			}
			function cssColor(s) {
				s = String(s || "").trim();
				var m;
				if (s.charAt(0) === "#") {
					var hx = s.slice(1);
					if (hx.length === 3) hx = hx[0] + hx[0] + hx[1] + hx[1] + hx[2] + hx[2];
					if (hx.length >= 6) {
						return [
							parseInt(hx.slice(0, 2), 16) / 255,
							parseInt(hx.slice(2, 4), 16) / 255,
							parseInt(hx.slice(4, 6), 16) / 255
						];
					}
				}
				m = s.match(/(-?[\d.]+)/g);
				if (m && m.length >= 3) {
					return [+m[0] / 255, +m[1] / 255, +m[2] / 255];
				}
				return [0.55, 0.65, 0.85];
			}

			function StarmapGL() {
				var canvas = React.useRef(null);
				var S = React.useRef({
					yaw: 0.55,
					pitch: -0.5,
					dist: 880,
					want: 880,
					drag: null,
					spin: 0.045,
					count: 0,
					nPoints: 0,
					nDust: 0,
					last: 0,
					// 拾取用：世界坐标 + 元数据 + 最近一帧的矩阵和画布 CSS 尺寸
					pos: null,
					meta: null,
					mat: null,
					cw: 0,
					ch: 0,
					hover: -1,
					pin: -1,
					moved: false,
					cardFor: -1,
					filter: -1 // 分类筛选：-1 全部，>=0 只亮 themes[k]
				});
				var labelEl = React.useRef(null);
				var cardEl = React.useRef(null);
				var st = React.useState({ msg: "正在取星图…", n: 0 });
				var info = st[0];
				var setInfo = st[1];
				// 分类筛选：点击左上统计里的某一类 → 只亮这类；再点一次取消
				var fst = React.useState(-1);
				var filter = fst[0];
				var setFilter = fst[1];
				S.current.filter = filter;

				React.useEffect(function () {
					var cv = canvas.current;
					if (!cv) return undefined;
					var gl = null;
					try {
						gl = cv.getContext("webgl", { antialias: true, alpha: false }) || cv.getContext("experimental-webgl");
					} catch (e) {
						gl = null;
					}
					if (!gl) return undefined;

					function shader(type, src) {
						var s = gl.createShader(type);
						gl.shaderSource(s, src);
						gl.compileShader(s);
						if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
							throw new Error("shader: " + gl.getShaderInfoLog(s));
						}
						return s;
					}
					var prog = gl.createProgram();
					try {
						gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT_SRC));
						gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG_SRC));
						gl.linkProgram(prog);
						if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
							throw new Error("link: " + gl.getProgramInfoLog(prog));
						}
					} catch (e) {
						setInfo({ msg: "WebGL 起不来：" + String((e && e.message) || e), n: 0 });
						return undefined;
					}
					gl.useProgram(prog);

					var aPos = gl.getAttribLocation(prog, "aPos");
					var aCol = gl.getAttribLocation(prog, "aCol");
					var aSize = gl.getAttribLocation(prog, "aSize");
					var aAlpha = gl.getAttribLocation(prog, "aAlpha");
					var aLayer = gl.getAttribLocation(prog, "aLayer");
					var uMat = gl.getUniformLocation(prog, "uMat");
					var uScale = gl.getUniformLocation(prog, "uScale");
					var uFilter = gl.getUniformLocation(prog, "uFilter");

					var vboPos = gl.createBuffer();
					var vboCol = gl.createBuffer();
					var vboSize = gl.createBuffer();
					var vboAlp = gl.createBuffer();
					var vboLay = gl.createBuffer();
					var ready = false;

					gl.disable(gl.DEPTH_TEST);
					gl.enable(gl.BLEND);
					gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // 加色：星尘才会「发光」

					// 彩色圆点：gl_PointCoord 自己裁圆，不需要贴图
					function build(data) {
						var pts = data.points || [];
						var dust = data.dust || [];
						var themes = data.themes || [];
						// 星尘全量：d 修好之后点不会再被放大成巨块，一万颗也只是雾
						var dustN = dust.length;
						var n = pts.length + dustN;
						if (!n) return;
						var pos = new Float32Array(n * 3);
						var col = new Float32Array(n * 3);
						var siz = new Float32Array(n);
						var alp = new Float32Array(n);
						var lay = new Float32Array(n); // 每个点属于哪个主题（分类筛选用）
						var K = 0.25; // 2200 的盘缩到半径 ~275 的世界单位
						var half = WORLD / 2;
						var k = 0;
						var i;
						for (i = 0; i < pts.length; i += 1) {
							var p = pts[i];
							var c1 = cssColor(p.c);
							pos[k * 3] = (p.x - half) * K;
							pos[k * 3 + 1] = (p.y - half) * K;
							pos[k * 3 + 2] = (hash01(i * 1.7) - 0.5) * 120 * K;
							col[k * 3] = c1[0];
							col[k * 3 + 1] = c1[1];
							col[k * 3 + 2] = c1[2];
							siz[k] = 5.6 + Math.min(5.2, (p.w || 0) * 1.9) + ((p.h || 0) > 0 ? 2.0 : 0);
							alp[k] = 1.0;
							lay[k] = typeof p.k === "number" ? p.k : -1;
							if (typeof p.kn !== "string") p.kn = (themes[p.k] && themes[p.k].name) || "";
							k += 1;
						}
						for (i = 0; i < dustN; i += 1) {
							var q = dust[i];
							var th = themes[q.k];
							var c2 = cssColor((th && th.c) || "rgb(140,155,185)");
							var j1 = hash01(i * 2.3 + 977);
							var j2 = hash01(i * 5.1 + 131);
							pos[k * 3] = (q.x - half) * K;
							pos[k * 3 + 1] = (q.y - half) * K;
							pos[k * 3 + 2] = (j1 - 0.5) * 520 * K;
							// 星尘不压太暗——它走普通半透明叠加，不会累加到白
							col[k * 3] = c2[0] * 0.95;
							col[k * 3 + 1] = c2[1] * 0.95;
							col[k * 3 + 2] = c2[2] * 0.95;
							siz[k] = 2.8 + j2 * 3.0;
							alp[k] = 0.32;
							lay[k] = typeof q.k === "number" ? q.k : -1;
							k += 1;
						}
						gl.bindBuffer(gl.ARRAY_BUFFER, vboPos);
						gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
						gl.bindBuffer(gl.ARRAY_BUFFER, vboCol);
						gl.bufferData(gl.ARRAY_BUFFER, col, gl.STATIC_DRAW);
						gl.bindBuffer(gl.ARRAY_BUFFER, vboSize);
						gl.bufferData(gl.ARRAY_BUFFER, siz, gl.STATIC_DRAW);
						gl.bindBuffer(gl.ARRAY_BUFFER, vboAlp);
						gl.bufferData(gl.ARRAY_BUFFER, alp, gl.STATIC_DRAW);
						gl.bindBuffer(gl.ARRAY_BUFFER, vboLay);
						gl.bufferData(gl.ARRAY_BUFFER, lay, gl.STATIC_DRAW);
						S.current.count = n;
						S.current.nPoints = pts.length;
						S.current.nDust = dustN;
						S.current.pos = pos; // 拾取要拿世界坐标自己投影一遍
						S.current.meta = pts;
						// 按主题数一遍，给左上角统计用（数据里 themes[].count 是空的，只能现数）
						var cnt = [];
						for (i = 0; i < themes.length; i += 1) cnt.push(0);
						for (i = 0; i < pts.length; i += 1) {
							var kk = pts[i].k;
							if (typeof kk === "number" && cnt[kk] !== undefined) cnt[kk] += 1;
						}
						var stats = [];
						for (i = 0; i < themes.length; i += 1) {
							if (!cnt[i]) continue;
							stats.push({ name: themes[i].name, c: themes[i].c, count: cnt[i], kv: i });
						}
						stats.sort(function (a, b) {
							return b.count - a.count;
						});
						ready = true;
						var sp = data.span || {};
						setInfo({ msg: "", n: n, stats: stats, days: sp.days || 0, from: sp.from || "", to: sp.to || "" });
					}

					// ── 取数据 ──
					fetch("/brain/starmap.json?t=" + Date.now())
						.then(function (r) {
							if (!r.ok) throw new Error("HTTP " + r.status);
							return r.json();
						})
						.then(build)
						.catch(function (e) {
							setInfo({ msg: "星图数据取不到：" + String((e && e.message) || e), n: 0 });
						});

					// ── 画 ──
					var raf = 0;
					function draw(t) {
						raf = window.requestAnimationFrame(draw);
						var d = window.devicePixelRatio || 1;
						var w = cv.clientWidth || 800;
						var hh = cv.clientHeight || 800;
						var pw = Math.max(1, Math.floor(w * d));
						var ph = Math.max(1, Math.floor(hh * d));
						if (cv.width !== pw || cv.height !== ph) {
							cv.width = pw;
							cv.height = ph;
						}
						gl.viewport(0, 0, pw, ph);
						gl.clearColor(0.012, 0.019, 0.042, 1); // 不透明画布：透明合成会按 alpha 稀释亮度，点会全暗
						gl.clear(gl.COLOR_BUFFER_BIT);
						if (!ready) return;

						var st2 = S.current;
						var dt = st2.last ? Math.min(0.05, (t - st2.last) / 1000) : 0;
						st2.last = t;
						if (!st2.drag) st2.yaw += st2.spin * dt;
						st2.dist += (st2.want - st2.dist) * Math.min(1, dt * 6);

						var proj = matPersp((60 * Math.PI) / 180, pw / ph, 1, 6000);
						var view = matTrans(0, 0, -st2.dist);
						var model = matMul(matRotX(st2.pitch), matRotY(st2.yaw));
						var mat = matMul(proj, matMul(view, model));
						gl.uniformMatrix4fv(uMat, false, mat);
						gl.uniform1f(uScale, ph * 0.866);
						gl.uniform1f(uFilter, st2.filter == null ? -1 : st2.filter);
						// 留给拾取：同一帧的矩阵 + CSS 尺寸（鼠标坐标是 CSS 像素，不是设备像素）
						st2.mat = mat;
						st2.cw = w;
						st2.ch = hh;

						gl.bindBuffer(gl.ARRAY_BUFFER, vboPos);
						gl.enableVertexAttribArray(aPos);
						gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
						gl.bindBuffer(gl.ARRAY_BUFFER, vboCol);
						gl.enableVertexAttribArray(aCol);
						gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, 0, 0);
						gl.bindBuffer(gl.ARRAY_BUFFER, vboSize);
						gl.enableVertexAttribArray(aSize);
						gl.vertexAttribPointer(aSize, 1, gl.FLOAT, false, 0, 0);
						gl.bindBuffer(gl.ARRAY_BUFFER, vboAlp);
						gl.enableVertexAttribArray(aAlpha);
						gl.vertexAttribPointer(aAlpha, 1, gl.FLOAT, false, 0, 0);
						gl.bindBuffer(gl.ARRAY_BUFFER, vboLay);
						gl.enableVertexAttribArray(aLayer);
						gl.vertexAttribPointer(aLayer, 1, gl.FLOAT, false, 0, 0);

						// 星尘先画、用普通半透明：1 万颗点若也走加色，中心必糊成一片白。
						gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
						gl.drawArrays(gl.POINTS, st2.nPoints, st2.nDust);
						// 主点后画、用加色：564 颗亮星才有一点「发光」的味道。
						gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
						gl.drawArrays(gl.POINTS, 0, st2.nPoints);

						// 标签跟着点走：每帧按当前矩阵重算一次屏幕位置
						placeLabel(st2.hover >= 0 ? st2.hover : st2.pin);

						// 左下角的详情卡（权重 / 被回忆次数 / 正文摘要），换点才重建内容
						placeCard(st2.hover >= 0 ? st2.hover : st2.pin);
					}
					raf = window.requestAnimationFrame(draw);

					// 2026-11-05：鼠标在浮层外松开时 canvas 收不到 mouseup，拖拽会卡住（视角一直跟着动）。
					// 兜一层 window 级别的 mouseup，松手就一定停。
					var onWinUp = function () {
						S.current.drag = null;
					};
					window.addEventListener("mouseup", onWinUp);

					return function () {
						window.cancelAnimationFrame(raf);
						window.removeEventListener("mouseup", onWinUp);
					};
				}, []);

				// ── 拾取：用和 GPU 同一套矩阵自己算屏幕坐标 ──
				// 只有 564 个主点要算，鼠标一动也就几百次矩阵乘法，不到一毫秒。
				function project(i) {
					var st = S.current;
					if (!st.mat || !st.pos) return null;
					var m = st.mat;
					var x = st.pos[i * 3];
					var y = st.pos[i * 3 + 1];
					var z = st.pos[i * 3 + 2];
					var cx = m[0] * x + m[4] * y + m[8] * z + m[12];
					var cy = m[1] * x + m[5] * y + m[9] * z + m[13];
					var cw = m[3] * x + m[7] * y + m[11] * z + m[15];
					if (cw <= 0.0001) return null; // 在相机背后，别算
					var nx = cx / cw;
					var ny = cy / cw;
					return { x: (nx * 0.5 + 0.5) * st.cw, y: (1 - (ny * 0.5 + 0.5)) * st.ch };
				}

				function pick(mx, my) {
					var st = S.current;
					if (!st.pos) return -1;
					var best = -1;
					var bestD = 30 * 30;
					for (var i = 0; i < st.nPoints; i += 1) {
						var s = project(i);
						if (!s) continue;
						var dx = s.x - mx;
						var dy = s.y - my;
						var dd = dx * dx + dy * dy;
						if (dd < bestD) {
							bestD = dd;
							best = i;
						}
					}
					return best;
				}

				function placeLabel(i) {
					var el = labelEl.current;
					if (!el) return;
					if (i < 0) {
						el.style.display = "none";
						return;
					}
					var s = project(i);
					var meta = S.current.meta;
					if (!s || !meta || !meta[i]) {
						el.style.display = "none";
						return;
					}
					el.style.display = "block";
					el.style.left = s.x + "px";
					el.style.top = s.y + "px";
					var p = meta[i];
					var txt = (p.d ? p.d + "　" : "") + (p.t || "（无标题）");
					if (el.textContent !== txt) el.textContent = txt;
				}

				// 左下角详情卡：只有换点才重建 DOM（每帧重建会拖慢浏览器）
				function placeCard(i) {
					var el = cardEl.current;
					var st = S.current;
					if (!el) return;
					if (i === st.cardFor) return;
					st.cardFor = i;
					var meta = st.meta;
					if (i < 0 || !meta || !meta[i]) {
						el.style.display = "none";
						return;
					}
					var p = meta[i];
					el.style.display = "block";
					el.textContent = "";
					var t = document.createElement("div");
					t.style.fontWeight = "600";
					t.style.fontSize = "13.5px";
					t.style.marginBottom = "4px";
					t.textContent = (p.d ? p.d + "　" : "") + (p.t || "（无标题）");
					el.appendChild(t);
					var m = document.createElement("div");
					m.style.opacity = "0.75";
					m.style.marginBottom = "6px";
					m.textContent =
						"权重 " + (p.w || 0) + "　·　被回忆 " + (p.hi || 0) + " 次" + (p.kn ? "　·　" + p.kn : "");
					el.appendChild(m);
					if (p.p) {
						var b = document.createElement("div");
						b.style.opacity = "0.62";
						b.style.fontSize = "11.5px";
						b.style.lineHeight = "17px";
						b.textContent = p.p;
						el.appendChild(b);
					}
				}

				// ── 交互：拖拽转视角 / 滚轮远近 / 双击复位 / 悬停看、点击钉 ──
				function onDown(e) {
					S.current.drag = { x: e.clientX, y: e.clientY, yaw: S.current.yaw, pitch: S.current.pitch };
					S.current.moved = false;
				}
				function onMove(e) {
					var st = S.current;
					var dg = st.drag;
					if (dg) {
						var dx = e.clientX - dg.x;
						var dy = e.clientY - dg.y;
						if (Math.abs(dx) + Math.abs(dy) > 4) st.moved = true;
						st.yaw = dg.yaw + dx * 0.006;
						st.pitch = Math.max(-1.45, Math.min(1.45, dg.pitch + dy * 0.005));
						return;
					}
					var rect = e.currentTarget.getBoundingClientRect();
					var idx = pick(e.clientX - rect.left, e.clientY - rect.top);
					if (idx !== st.hover) {
						st.hover = idx;
						e.currentTarget.style.cursor = idx >= 0 ? "pointer" : "grab";
					}
				}
				function onUp(e) {
					var st = S.current;
					var wasDrag = st.moved;
					st.drag = null;
					st.moved = false;
					if (wasDrag) return;
					var rect = e.currentTarget.getBoundingClientRect();
					var idx = pick(e.clientX - rect.left, e.clientY - rect.top);
					st.pin = idx === st.pin ? -1 : idx;
				}
				function onLeave() {
					S.current.drag = null;
					S.current.moved = false;
					S.current.hover = -1;
				}
				function onWheel(e) {
					e.preventDefault();
					var next = S.current.want * (e.deltaY < 0 ? 0.86 : 1.16);
					S.current.want = Math.max(260, Math.min(2400, next));
				}
				function reset() {
					S.current.yaw = 0.55;
					S.current.pitch = -0.5;
					S.current.want = 880;
					S.current.pin = -1;
				}

				return h(
					"div",
					{
						style: {
							position: "relative",
							width: "100%",
							height: "100%",
							// 深空底色 + 中心辉光（画布现在是透明的，这层负责「底」）
							background:
								"radial-gradient(circle at 50% 46%, rgba(30,52,96,0.85) 0%, rgba(10,17,34,0.95) 42%, #03060d 100%)"
						}
					},
					h("canvas", {
						ref: canvas,
						onMouseDown: onDown,
						onMouseMove: onMove,
						onMouseUp: onUp,
						onMouseLeave: onLeave,
						onWheel: onWheel,
						onDoubleClick: reset,
						style: {
							width: "100%",
							height: "100%",
							display: "block",
							cursor: S.current.drag ? "grabbing" : "grab",
							touchAction: "none"
						}
					}),
					// 悬停/钉住的记忆标签（位置每帧由 placeLabel 重算）
					h("div", {
						ref: labelEl,
						style: {
							position: "absolute",
							left: 0,
							top: 0,
							display: "none",
							transform: "translate(-50%, -155%)",
							padding: "5px 10px",
							borderRadius: 8,
							background: "rgba(8,13,24,0.92)",
							border: "1px solid rgba(150,200,255,0.45)",
							color: "rgba(223,234,255,0.97)",
							fontSize: 12,
							lineHeight: "16px",
							whiteSpace: "nowrap",
							pointerEvents: "none",
							zIndex: 4
						}
					}),
					// 左下角详情卡（悬停或钉住时出现，内容由 placeCard 建）
					h("div", {
						ref: cardEl,
						style: {
							position: "absolute",
							left: 18,
							bottom: 18,
							maxWidth: 420,
							display: "none",
							padding: "12px 14px",
							borderRadius: 12,
							background: "rgba(8,13,24,0.9)",
							border: "1px solid rgba(140,190,255,0.3)",
							color: "rgba(220,232,255,0.94)",
							fontSize: 12.5,
							lineHeight: "19px",
							whiteSpace: "normal",
							pointerEvents: "none",
							zIndex: 4
						}
					}),
					info.msg
						? h(
								"div",
								{
									style: {
										position: "absolute",
										left: 0,
										right: 0,
										top: "48%",
										textAlign: "center",
										fontSize: 13,
										color: "rgba(190,205,235,0.8)",
										pointerEvents: "none"
									}
								},
								info.msg
							)
						: null,
					// 左上角：按主题的记忆统计（数字是现数出来的，不是编的）
					// 2026-11-08：统计行可点 → 分类筛选（只亮这一类）；再点取消
					info.stats && info.stats.length
						? h(
								"div",
								{
									style: {
										position: "absolute",
										left: 14,
										top: 12,
										zIndex: 4,
										minWidth: 128,
										padding: "10px 12px",
										borderRadius: 12,
										background: "rgba(8,13,24,0.7)",
										border: "1px solid rgba(140,190,255,0.2)",
										color: "rgba(215,230,255,0.92)",
										fontSize: 11.5,
										lineHeight: "17px",
										pointerEvents: "auto"
									}
								},
								h("div", { style: { fontSize: 13, fontWeight: 600, marginBottom: 2 } }, "记忆星图"),
								h(
									"div",
									{ style: { opacity: 0.55, fontSize: 10.5, marginBottom: 8 } },
									info.days
										? info.days + " 天 · " + String(info.from).slice(5) + " → " + String(info.to).slice(5)
										: ""
								),
								info.stats.map(function (s, si) {
									var on = filter === s.kv;
									return h(
										"div",
										{
											key: si,
											onClick: function (e) {
												if (e && e.stopPropagation) e.stopPropagation();
												var next = filter === s.kv ? -1 : s.kv;
												S.current.filter = next;
												setFilter(next);
											},
											title: on ? "再点一次取消筛选" : "只看这一类",
											style: {
												display: "flex",
												alignItems: "center",
												gap: 7,
												margin: "2px -6px 0",
												padding: "2px 6px",
												borderRadius: 6,
												cursor: "pointer",
												background: on ? "rgba(120,170,255,0.22)" : "transparent",
												opacity: filter < 0 || on ? 1 : 0.42
											}
										},
										h("span", {
											style: {
												width: 8,
												height: 8,
												borderRadius: "50%",
												background: s.c,
												flex: "0 0 auto"
											}
										}),
										h("span", { style: { flex: "1 1 auto", opacity: 0.85 } }, s.name),
										h("span", { style: { fontWeight: 600 } }, String(s.count))
									);
								}),
								h(
									"div",
									{ style: { opacity: 0.4, fontSize: 10, marginTop: 7 } },
									filter < 0 ? "点分类只看这一类" : "再点一次取消"
								)
							)
						: null,
					info.n
						? h(
								"div",
								{
									style: {
										position: "absolute",
										right: 14,
										top: 12,
										fontSize: 11.5,
										letterSpacing: "0.3px",
										color: "rgba(160,185,230,0.6)",
										pointerEvents: "none"
									}
								},
								"3D · " + info.n + " 点"
							)
						: null
				);
			}

			/** 有 WebGL 就 3D，没有就老老实实退回 2D；两种都能手动切 */
			function StarStage() {
				var glOk = React.useMemo(function () {
					try {
						var c = document.createElement("canvas");
						return !!(c.getContext("webgl") || c.getContext("experimental-webgl"));
					} catch (e) {
						return false;
					}
				}, []);
				// 2026-11-05：3D 版暂时没做拾取（点星看记忆），所以留一个开关退回 2D。
				// 这比在 3D 里硬做投影拾取省事，而且 2D 那套标签本来就好用。
				var mode = React.useState(glOk ? "3d" : "2d");
				var m = mode[0];
				var setM = mode[1];
				return h(
					"div",
					{ style: { position: "relative", width: "100%", height: "100%" } },
					m === "3d" ? h(StarmapGL, {}) : h(Starmap, {}),
					glOk
						? h(
								"button",
								{
									type: "button",
									onClick: function (e) {
										if (e && e.stopPropagation) e.stopPropagation();
										setM(m === "3d" ? "2d" : "3d");
									},
									style: {
										position: "absolute",
										right: 12,
										bottom: 12,
										zIndex: 5,
										padding: "4px 11px",
										borderRadius: 999,
										border: "1px solid rgba(150,200,255,0.35)",
										background: "rgba(12,20,36,0.82)",
										color: "rgba(210,228,255,0.92)",
										fontSize: 11.5,
										cursor: "pointer"
									}
								},
								m === "3d" ? "⇄ 切 2D 查记忆" : "⇄ 切回 3D"
							)
						: null
				);
			}

			function Starmap() {
				var canvas = React.useRef(null);
				var S = React.useRef({
					data: null,
					err: "",
					scale: 1,
					ox: 0,
					oy: 0,
					hover: -1,
					pin: -1,
					drag: null,
					moved: false,
					pointer: null,
					mx: 0,
					my: 0
				});
				var ui = React.useState(null);
				var setUi = ui[1];

				// ── 载入数据 ──
				React.useEffect(
					function () {
						var alive = true;
						fetch("/brain/starmap.json?t=" + Date.now())
							.then(function (r) {
								if (!r.ok) throw new Error("HTTP " + r.status);
								return r.json();
							})
							.then(function (j) {
								if (!alive) return;
								var pts = (j.points || []).map(function (p, i) {
									return {
										x: p.x,
										y: p.y,
										t: p.t || "",
										d: p.d || "",
										c: p.c || "#8899bb",
										w: p.w || 0,
										hi: p.h || 0,
										p: p.p || "",
										ph: (i * 2.399963) % (Math.PI * 2)
									};
								});
								S.current.data = {
									points: pts,
									dust: j.dust || [],
									themes: j.themes || [],
									ticks: j.ticks || [],
									span: j.span || {}
								};
								S.current.err = "";
							})
							.catch(function (e) {
								if (!alive) return;
								S.current.err = String((e && e.message) || e);
							});
						return function () {
							alive = false;
						};
					},
					[]
				);

				// ── 渲染循环 ──
				React.useEffect(
					function () {
						var cv = canvas.current;
						if (!cv) return;
						var ctx = cv.getContext("2d");
						var raf = 0;
						var dustCanvas = null;
						var dustFor = null;

						function dpr() {
							return window.devicePixelRatio || 1;
						}
						function resize() {
							var d = dpr();
							var w = cv.clientWidth || 900;
							var hh = cv.clientHeight || 600;
							cv.width = Math.max(1, Math.floor(w * d));
							cv.height = Math.max(1, Math.floor(hh * d));
						}
						resize();

						function transform() {
							var d = dpr();
							var w = cv.width / d;
							var hh = cv.height / d;
							var base = Math.min(w, hh) / (WORLD * 1.45);
							var s = base * S.current.scale;
							return {
								s: s,
								tx: w / 2 - (WORLD / 2) * s + S.current.ox,
								ty: hh / 2 - (WORLD / 2) * s + S.current.oy,
								w: w,
								h: hh,
								d: d
							};
						}

						// 星尘 + 轨道 + 刻度：只画一次到离屏（世界坐标 2200²）
						function buildDust(data) {
							var off = document.createElement("canvas");
							off.width = WORLD;
							off.height = WORLD;
							var g = off.getContext("2d");
							// 透明底：圆外的那一块留给 canvas 自己的深空色，别糊成方块
							g.clearRect(0, 0, WORLD, WORLD);

							// 轨道环（线宽按世界坐标放大，缩到屏幕后约 1.4px）
							var themes = data.themes || [];
							for (var ti = 0; ti < themes.length; ti += 1) {
								var th = themes[ti];
								if (th.name === "其他" || !th.r) continue;
								g.beginPath();
								g.arc(WORLD / 2, WORLD / 2, th.r, 0, Math.PI * 2);
								g.strokeStyle = "rgba(130,165,225,0.30)";
								g.lineWidth = 4;
								g.stroke();
							}

							// 星尘
							var dust = data.dust || [];
							for (var i = 0; i < dust.length; i += 1) {
								var p = dust[i];
								var col = (themes[p.k] && themes[p.k].c) || "rgb(150,162,185)";
								g.globalAlpha = 0.30 + ((i * 37) % 100) / 400;
								g.fillStyle = col;
								g.beginPath();
								g.arc(p.x, p.y, 2.2 + ((i * 13) % 10) / 8, 0, Math.PI * 2);
								g.fill();
							}
							g.globalAlpha = 1;

							// 刻度
							var ticks = data.ticks || [];
							g.fillStyle = "rgba(160,182,225,0.85)";
							g.font = "40px system-ui, sans-serif";
							for (var k = 0; k < ticks.length; k += 1) {
								var a = ticks[k].a;
								var r0 = 1400;
								g.save();
								g.translate(WORLD / 2, WORLD / 2);
								g.rotate(a);
								g.fillRect(r0, -3, 60, 6);
								g.restore();
								var rr = 1490;
								var tx = WORLD / 2 + rr * Math.cos(a);
								var ty = WORLD / 2 + rr * Math.sin(a);
								g.textAlign = "center";
								g.textBaseline = "middle";
								g.fillText(ticks[k].label, tx, ty);
							}

							// 主题名（沿轨道左上角，和 PNG 版一致）
							g.font = "bold 46px system-ui, sans-serif";
							for (var tj = 0; tj < themes.length; tj += 1) {
								var t2 = themes[tj];
								if (t2.name === "其他" || !t2.r) continue;
								g.fillStyle = t2.c;
								g.globalAlpha = 0.92;
								var ang = -Math.PI * 0.75;
								g.textAlign = "center";
								g.textBaseline = "middle";
								g.fillText(
									t2.name,
									WORLD / 2 + t2.r * Math.cos(ang),
									WORLD / 2 + t2.r * Math.sin(ang)
								);
							}
							g.globalAlpha = 1;
							return off;
						}

						function nearest(mx, my, T) {
							var data = S.current.data;
							if (!data) return -1;
							var wx = (mx - T.tx) / T.s;
							var wy = (my - T.ty) / T.s;
							var best = -1;
							var bestD = 26 * 26; // 屏幕像素阈值
							var pts = data.points;
							for (var i = 0; i < pts.length; i += 1) {
								var p = pts[i];
								var dx = (p.x - wx) * T.s;
								var dy = (p.y - wy) * T.s;
								var dd = dx * dx + dy * dy;
								if (dd < bestD) {
									bestD = dd;
									best = i;
								}
							}
							return best;
						}

						function frame(t) {
							raf = window.requestAnimationFrame(frame);
							var data = S.current.data;
							var T = transform();

							ctx.setTransform(T.d, 0, 0, T.d, 0, 0);
							ctx.clearRect(0, 0, T.w, T.h);

							// 深空底
							ctx.fillStyle = "#04060c";
							ctx.fillRect(0, 0, T.w, T.h);

							if (!data) {
								ctx.fillStyle = "rgba(190,205,235,0.75)";
								ctx.font = "14px system-ui, sans-serif";
								ctx.textAlign = "center";
								ctx.fillText(
									S.current.err ? "星图数据取不到：" + S.current.err : "正在取星图…",
									T.w / 2,
									T.h / 2
								);
								return;
							}

							// 离屏底图
							if (dustFor !== data) {
								dustCanvas = buildDust(data);
								dustFor = data;
							}
							ctx.save();
							ctx.translate(T.tx, T.ty);
							ctx.scale(T.s, T.s);
							// 中心微光（压在星尘底下）
							var cg = ctx.createRadialGradient(
								WORLD / 2, WORLD / 2, 0,
								WORLD / 2, WORLD / 2, WORLD * 0.52
							);
							cg.addColorStop(0, "rgba(95,125,195,0.22)");
							cg.addColorStop(0.5, "rgba(45,65,115,0.09)");
							cg.addColorStop(1, "rgba(0,0,0,0)");
							ctx.fillStyle = cg;
							ctx.beginPath();
							ctx.arc(WORLD / 2, WORLD / 2, WORLD * 0.52, 0, Math.PI * 2);
							ctx.fill();
							ctx.drawImage(dustCanvas, 0, 0);

							// 主点（呼吸 + 悬停放大）
							var pts = data.points;
							var hv = S.current.hover;
							var pn = S.current.pin;
							for (var i = 0; i < pts.length; i += 1) {
								var p = pts[i];
								var breathe = 0.62 + 0.38 * Math.sin(t / 900 + p.ph);
								var r = 2.2 + Math.min(3.6, p.w * 1.1) + (p.hi > 0 ? 1.1 : 0);
								var isHover = i === hv || i === pn;
								if (isHover) r = r * 2.4 + 2;
								// 光晕
								ctx.globalAlpha = isHover ? 0.5 : 0.16 * breathe;
								ctx.fillStyle = p.c;
								ctx.beginPath();
								ctx.arc(p.x, p.y, r * 3.2, 0, Math.PI * 2);
								ctx.fill();
								// 核心
								ctx.globalAlpha = isHover ? 1 : 0.5 + 0.5 * breathe;
								ctx.beginPath();
								ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
								ctx.fill();
								// 钉住的圆环
								if (i === pn) {
									ctx.globalAlpha = 0.9;
									ctx.strokeStyle = "#ffffff";
									ctx.lineWidth = 2 / T.s;
									ctx.beginPath();
									ctx.arc(p.x, p.y, r * 3.4, 0, Math.PI * 2);
									ctx.stroke();
								}
							}
							ctx.globalAlpha = 1;
							ctx.restore();

							// 悬停点标签（屏幕坐标）
							if (hv >= 0 && pts[hv]) {
								var hp = pts[hv];
								var sx = hp.x * T.s + T.tx;
								var sy = hp.y * T.s + T.ty;
								var label = (hp.d ? hp.d.slice(5) + "　" : "") + (hp.t || "");
								ctx.font = "13px system-ui, sans-serif";
								var tw = ctx.measureText(label).width;
								var padX = 10;
								var bx = Math.min(Math.max(8, sx + 14), T.w - tw - padX * 2 - 8);
								var by = Math.max(8, sy - 40);
								ctx.fillStyle = "rgba(10,16,28,0.92)";
								ctx.strokeStyle = "rgba(150,200,255,0.45)";
								ctx.lineWidth = 1;
								roundRect(ctx, bx, by, tw + padX * 2, 26, 8);
								ctx.fill();
								ctx.stroke();
								ctx.fillStyle = "rgba(215,230,255,0.96)";
								ctx.textAlign = "left";
								ctx.textBaseline = "middle";
								ctx.fillText(label, bx + padX, by + 13);
							}
						}

						function roundRect(g, x, y, w, hh, r) {
							g.beginPath();
							g.moveTo(x + r, y);
							g.arcTo(x + w, y, x + w, y + hh, r);
							g.arcTo(x + w, y + hh, x, y + hh, r);
							g.arcTo(x, y + hh, x, y, r);
							g.arcTo(x, y, x + w, y, r);
							g.closePath();
						}

						function onResize() {
							resize();
						}
						var ro = window.ResizeObserver ? new window.ResizeObserver(onResize) : null;
						if (ro) ro.observe(cv);
						window.addEventListener("resize", onResize);

						raf = window.requestAnimationFrame(frame);
						return function () {
							window.cancelAnimationFrame(raf);
							window.removeEventListener("resize", onResize);
							if (ro) ro.disconnect();
						};
					},
					[]
				);

				// ── 交互 ──
				function toWorldS(mx, my) {
					var cv2 = canvas.current;
					if (!cv2) return { s: 1, tx: 0, ty: 0 };
					var d = window.devicePixelRatio || 1;
					var w = cv2.width / d;
					var hh = cv2.height / d;
					var base = Math.min(w, hh) / (WORLD * 1.45);
					var s = base * S.current.scale;
					return { s: s, tx: w / 2 - (WORLD / 2) * s + S.current.ox, ty: hh / 2 - (WORLD / 2) * s + S.current.oy };
				}

				function pick(mx, my) {
					var T = toWorldS(mx, my);
					var data = S.current.data;
					if (!data) return -1;
					var wx = (mx - T.tx) / T.s;
					var wy = (my - T.ty) / T.s;
					var best = -1;
					var bestD = 30 * 30;
					for (var i = 0; i < data.points.length; i += 1) {
						var p = data.points[i];
						var dx = (p.x - wx) * T.s;
						var dy = (p.y - wy) * T.s;
						var dd = dx * dx + dy * dy;
						if (dd < bestD) {
							bestD = dd;
							best = i;
						}
					}
					return best;
				}

				function onMove(e) {
					var rect = e.currentTarget.getBoundingClientRect();
					var mx = e.clientX - rect.left;
					var my = e.clientY - rect.top;
					var st = S.current;
					if (st.drag) {
						st.ox = st.drag.ox + (mx - st.drag.mx);
						st.oy = st.drag.oy + (my - st.drag.my);
						if (Math.abs(mx - st.drag.mx) + Math.abs(my - st.drag.my) > 3) st.moved = true;
						return;
					}
					var idx = pick(mx, my);
					if (idx !== st.hover) {
						st.hover = idx;
						st.mx = mx;
						st.my = my;
					}
					if (idx >= 0 && st.data) {
						var p = st.data.points[idx];
						setUi({ d: p.d, t: p.t, p: p.p, w: p.w, hi: p.hi });
					}
				}

				function onDown(e) {
					if (e.button !== 0) return;
					var rect = e.currentTarget.getBoundingClientRect();
					S.current.drag = {
						mx: e.clientX - rect.left,
						my: e.clientY - rect.top,
						ox: S.current.ox,
						oy: S.current.oy
					};
					S.current.moved = false;
				}

				function onUp(e) {
					var st = S.current;
					var wasDrag = st.moved;
					st.drag = null;
					st.moved = false;
					if (wasDrag) return;
					var rect = e.currentTarget.getBoundingClientRect();
					var idx = pick(e.clientX - rect.left, e.clientY - rect.top);
					st.pin = idx === st.pin ? -1 : idx;
					if (st.pin >= 0 && st.data) {
						var p = st.data.points[st.pin];
						setUi({ d: p.d, t: p.t, p: p.p, w: p.w, hi: p.hi });
					} else {
						setUi(null);
					}
				}

				function onWheel(e) {
					e.preventDefault();
					var st = S.current;
					var next = st.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15);
					st.scale = Math.min(6, Math.max(0.55, next));
				}

				function reset() {
					S.current.scale = 1;
					S.current.ox = 0;
					S.current.oy = 0;
					S.current.pin = -1;
					setUi(null);
				}

				return h(
					"div",
					{ style: { position: "relative", width: "100%", height: "100%" } },
					h("canvas", {
						ref: canvas,
						onMouseMove: onMove,
						onMouseDown: onDown,
						onMouseUp: onUp,
						onMouseLeave: function () {
							S.current.hover = -1;
							S.current.drag = null;
						},
						onWheel: onWheel,
						onDoubleClick: reset,
						style: {
							width: "100%",
							height: "100%",
							display: "block",
							cursor: S.current.hover >= 0 ? "pointer" : "crosshair",
							borderRadius: 14
						}
					}),
					// 右下角提示卡
					ui[0]
						? h(
								"div",
								{
									style: {
										position: "absolute",
										left: 18,
										bottom: 18,
										maxWidth: 420,
										padding: "12px 14px",
										borderRadius: 12,
										background: "rgba(8,13,24,0.9)",
										border: "1px solid rgba(140,190,255,0.3)",
										color: "rgba(220,232,255,0.94)",
										fontSize: 12.5,
										lineHeight: "19px",
										pointerEvents: "none"
									}
								},
								h(
									"div",
									{ style: { fontSize: 13.5, fontWeight: 600, marginBottom: 4 } },
									(ui[0].d ? ui[0].d + "　" : "") + (ui[0].t || "（无标题）")
								),
								h(
									"div",
									{ style: { opacity: 0.75, marginBottom: 6 } },
									"权重 " + (ui[0].w || 0) + "　·　被回忆 " + (ui[0].hi || 0) + " 次"
								),
								ui[0].p
									? h(
											"div",
											{
												style: {
													opacity: 0.62,
													fontSize: 11.5,
													lineHeight: "17px",
													whiteSpace: "normal"
												}
											},
											ui[0].p
										)
									: null
							)
						: null
				);
			}

			/** 全屏浮层：点背景或 Esc 关闭 */
			function StarOverlay() {
				var open = useIsOpen();
				React.useEffect(
					function () {
						if (!open) return undefined;
						function onKey(e) {
							if (e && e.key === "Escape") setOpen(false);
						}
						window.addEventListener("keydown", onKey);
						return function () {
							window.removeEventListener("keydown", onKey);
						};
					},
					[open]
				);
				if (!open) return null;
				return h(
					"div",
					{
						onClick: function () {
							setOpen(false);
						},
						style: {
							position: "fixed",
							top: 0,
							left: 0,
							right: 0,
							bottom: 0,
							zIndex: 99999,
							background: "rgba(3,6,12,0.93)",
							backdropFilter: "blur(7px)",
							WebkitBackdropFilter: "blur(7px)",
							display: "flex",
							flexDirection: "column",
							alignItems: "center",
							justifyContent: "center",
							padding: "34px 26px 22px"
						}
					},
					h(
						"div",
						{
							onClick: function (e) {
								if (e && e.stopPropagation) e.stopPropagation();
							},
							style: {
								width: "min(880px, 88vh, 94vw)",
								height: "min(880px, 88vh, 94vw)",
								position: "relative",
								borderRadius: 16,
								overflow: "hidden",
								border: "1px solid rgba(120,170,255,0.22)",
								boxShadow: "0 28px 90px rgba(0,0,0,0.7)"
							}
						},
						h(StarStage, {})
					),
					h(
						"div",
						{
							style: {
								marginTop: 12,
								fontSize: 12,
								opacity: 0.66,
								letterSpacing: "0.4px"
							}
						},
						"拖拽转视角 · 滚轮远近 · 悬停或点击星点看记忆 · 双击复位 · Esc 关闭（右下角切 2D）"
					)
				);
			}

			// ── 设置页「脑袋瓜」（2026-11-09 加）──────────────────────
			// 注册进 DSH 的 settings.section 槽位；读写走 host 的 /brain/config。
			var S = {
				box: { padding: "2px 0", fontSize: 13, lineHeight: 1.65 },
				hint: { opacity: 0.6, fontSize: 12, marginTop: 2 },
				row: { display: "flex", gap: 18, padding: "9px 0", borderBottom: "1px solid rgba(127,127,127,0.14)", alignItems: "flex-start" },
				labelWrap: { flex: "0 0 200px" },
				label: { fontWeight: 600 },
				input: { width: "100%", maxWidth: 460, padding: "6px 9px", borderRadius: 6, border: "1px solid rgba(127,127,127,0.35)", background: "transparent", color: "inherit", fontSize: 13, fontFamily: "inherit" },
				section: { margin: "18px 0 2px", fontSize: 14, fontWeight: 700 },
				btn: { padding: "7px 16px", borderRadius: 6, border: "1px solid rgba(127,127,127,0.4)", background: "transparent", color: "inherit", cursor: "pointer", fontSize: 13 },
				btnPrimary: { padding: "7px 16px", borderRadius: 6, border: "none", background: "#3b82f6", color: "#fff", cursor: "pointer", fontSize: 13 }
			};

			function BrainSettings() {
				var cfgState = React.useState(null);
				var cfg = cfgState[0], setCfg = cfgState[1];
				var effState = React.useState(null);
				var eff = effState[0], setEff = effState[1];
				var msgState = React.useState("");
				var msg = msgState[0], setMsg = msgState[1];
				var busyState = React.useState(false);
				var busy = busyState[0], setBusy = busyState[1];
				var savedState = React.useState("");
				var saved = savedState[0], setSaved = savedState[1];

				function load() {
					setMsg("");
					fetch("/brain/config", { headers: { accept: "application/json" } })
						.then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)); })
						.then(function (j) {
							setCfg(j.config || {});
							setEff(j.effective || null);
							setSaved(JSON.stringify(j.config || {}));
						})
						.catch(function (e) { setMsg("读取失败：" + e.message); });
				}
				React.useEffect(function () { load(); }, []);

				function value(k) {
					if (cfg && Object.prototype.hasOwnProperty.call(cfg, k)) return cfg[k];
					return eff ? eff[k] : "";
				}
				function set(k, v) {
					setCfg(function (c) {
						var n = Object.assign({}, c || {});
						n[k] = v;
						return n;
					});
				}
				function save() {
					setBusy(true);
					setMsg("");
					fetch("/brain/config", {
						method: "POST",
						headers: { "content-type": "application/json", accept: "application/json" },
						body: JSON.stringify({ config: cfg || {} })
					})
						.then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
						.then(function (x) {
							if (!x.ok) throw new Error(x.j.error || "HTTP");
							setCfg(x.j.config || {});
							setEff(x.j.effective || null);
							setSaved(JSON.stringify(x.j.config || {}));
							setMsg("✓ 已保存" + (x.j.warn ? "\n⚠️ " + x.j.warn : ""));
						})
						.catch(function (e) { setMsg("保存失败：" + e.message); })
						.then(function () { setBusy(false); });
				}

				function row(k, label, hint, opts) {
					opts = opts || {};
					var v = value(k);
					var input;
					if (opts.toggle) {
						input = h("input", {
							type: "checkbox",
							checked: v !== false,
							onChange: function (e) { set(k, e.target.checked); },
							style: { width: 16, height: 16, cursor: "pointer", marginTop: 3 }
						});
					} else {
						input = h("input", {
							value: String(v == null ? "" : v),
							onChange: function (e) { set(k, e.target.value); },
							style: S.input
						});
					}
					return h("div", { style: S.row, key: k },
						h("div", { style: S.labelWrap },
							h("div", { style: S.label }, label),
							hint ? h("div", { style: S.hint }, hint) : null),
						h("div", { style: { flex: 1, display: "flex", flexDirection: "column", gap: 6 } }, input));
				}

				if (!cfg) {
					return h("div", { style: S.box },
						h("h3", { style: { margin: "0 0 6px" } }, "脑袋瓜"),
						h("div", { style: S.hint }, msg || "读取中…"));
				}

				var dirty = JSON.stringify(cfg) !== saved;
				return h("div", { style: S.box },
					h("h3", { style: { margin: "0 0 4px" } }, "脑袋瓜"),
					h("div", { style: S.hint },
						"设定记忆放哪、门铃何时响、模型要不要联网下载。配置文件：",
						h("code", null, eff ? String(eff.cfgFile || "") : "~/.dsh/brain/config.json")),

					h("div", { style: S.section }, "记忆位置"),
					row("dataDir", "记忆根目录", "人格 / 状态 / 归档 / 索引默认都在这下面"),
					row("ledger", "账本", "Markdown，按 ## 分节"),
					row("persona", "人格文件", "可选；没有就不注入"),
					row("state", "状态层", "可选；建议不超过 1800 字"),
					row("booksDir", "读书卡目录", "可选；reading-card-*.md 会进记忆"),

					h("div", { style: S.section }, "门铃"),
					row("awayMin", "算「离开」的分钟数", "空闲超过这么久才记账"),
					row("backMin", "算「回来」的分钟数", "回到前台多久内算回来"),
					row("knock", "回来时主动说话", "关掉就只写纸条、不主动 followup", { toggle: true }),
					row("knockGapMin", "两次敲门最小间隔（分钟）", "避免一天敲太多次"),

					h("div", { style: S.section }, "模型"),
					row("allowRemoteModels", "允许联网下载模型", "关掉就只用本地 models/ 里的", { toggle: true }),
					row("modelDir", "模型目录", "默认插件目录下的 models/"),

					h("div", { style: { display: "flex", gap: 10, alignItems: "center", marginTop: 18, flexWrap: "wrap" } },
						h("button", {
							style: (busy || !dirty) ? S.btn : S.btnPrimary,
							disabled: busy || !dirty,
							onClick: save
						}, busy ? "保存中…" : "保存"),
						h("button", { style: S.btn, disabled: busy, onClick: load }, "重新读取"),
						msg ? h("span", { style: { fontSize: 12, opacity: 0.85, whiteSpace: "pre-wrap" } }, msg) : null));
			}

			function apply(ctx) {
				// 落点 1：输入框旁的按钮
				try {
					ctx.slots.inject("conversation.composer.dock", function () {
						return ctx.slots.register(
							{ name: "conversation.composer.dock", id: "starmap-button", order: 6 },
							StarButton
						);
					});
				} catch (e) {
					/* 没有这个槽位就不显示按钮 */
				}
				// 落点 2：全屏浮层
				try {
					ctx.slots.inject("shell.overlay", function* () {
						yield ctx.slots.register({ name: "shell.overlay", id: "starmap-overlay", order: 1001 }, StarOverlay);
					});
				} catch (e) {
					/* 没有浮层槽位就只留按钮 */
				}
				// 落点 3：设置页「脑袋瓜」（2026-11-09 加）
				try {
					ctx.slots.inject("settings.section", function () {
						return ctx.slots.register(
							{ name: "settings.section", id: "dsh-brain-settings", order: 8, label: function () { return "脑袋瓜"; } },
							BrainSettings
						);
					});
				} catch (e) {
					/* 没有设置页槽位就不显示 */
				}
			}

			return { apply: apply, inject: ["slots"], name: "brain-client" };
		}
	});
})();
