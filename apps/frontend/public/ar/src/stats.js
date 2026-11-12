// Performance monitor: frame timing, GPU timer queries, renderer counters,
// on-screen HUD + sparkline, event log, benchmarks and JSON reports.

export const fmtBytes = (b) => {
  if (b == null || Number.isNaN(b)) return 'n/a';
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
};
export const fmtNum = (n) => {
  if (n == null) return 'n/a';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${Math.round(n)}`;
};
const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : NaN;
const avg = (a) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
const CRUMB_KEY = 'glbArLab.crumb';
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// GPU time via EXT_disjoint_timer_query_webgl2. Often unavailable on mobile; reports n/a then.
class GpuTimer {
  constructor(gl) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.free = [];
    this.pending = [];
    this.active = null;
  }

  begin() {
    if (!this.ext || this.active || this.pending.length > 6) return;
    const q = this.free.pop() || this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }

  end() {
    if (!this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  poll() {
    if (!this.ext) return null;
    const gl = this.gl;
    let ms = null;
    while (this.pending.length) {
      const q = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
      this.pending.shift();
      this.free.push(q);
      if (!disjoint) ms = ns / 1e6;
    }
    return ms;
  }
}

export class PerfMonitor {
  constructor({ hud, hudWrap, graph, log, renderer }) {
    this.hudEl = hud;
    this.hudWrap = hudWrap;
    this.graph = graph;
    this.graphCtx = graph.getContext('2d');
    this.logEl = log;
    this.renderer = renderer;
    this.gpu = new GpuTimer(renderer.getContext());

    this.N = 1200; // ring buffer of recent frames
    this.dt = new Float32Array(this.N);
    this.cpu = new Float32Array(this.N);
    this.gpuMs = new Float32Array(this.N);
    this.head = 0;
    this.count = 0;
    this.lastT = null;
    this.pendingDt = null;
    this.cpuStart = 0;
    this.lastGpu = null;
    this.totalFrames = 0;
    this.longFrames = 0;
    this.targetHz = 60;

    this.counters = { calls: 0, triangles: 0, points: 0, lines: 0 };
    this.sections = new Map();
    this.mode = 'compact'; // compact (perf + tracking) | full (every section) | off
    this.logs = [];
    this.bench = null;
    this.benchResults = [];
    this.remoteQueue = [];
    this.remoteEnabled = true;
    this.streamStats = true;
    this.t0 = performance.now();
    this.context = {};

    // Crash breadcrumbs: state is mirrored to localStorage and marked clean on a normal page exit.
    // If the next load finds it still dirty, the tab crashed (or was killed) and we report it.
    this.previousCrash = null;
    try {
      const prev = JSON.parse(localStorage.getItem(CRUMB_KEY) || 'null');
      if (prev && !prev.clean) this.previousCrash = prev;
    } catch { /* storage blocked */ }
    this.persistCrumb();
    addEventListener('pagehide', () => this.persistCrumb(true));
    setInterval(() => this.persistCrumb(), 2000);

    setInterval(() => this.renderHud(), 250);
    setInterval(() => this.flushRemote(), 2000);
    setInterval(() => this.queueStatLine(), 5000);
  }

  // ---------- per-frame hooks ----------

  frameBegin(t) {
    this.cpuStart = performance.now();
    this.pendingDt = this.lastT != null ? t - this.lastT : null;
    this.lastT = t;
  }

  gpuBegin() { this.gpu.begin(); }
  gpuEnd() { this.gpu.end(); }

  frameEnd() {
    const cpu = performance.now() - this.cpuStart;
    const g = this.gpu.poll();
    if (g != null) this.lastGpu = g;
    const r = this.renderer.info.render;
    this.counters.calls = r.calls;
    this.counters.triangles = r.triangles;
    this.counters.points = r.points;
    this.counters.lines = r.lines;

    const dt = this.pendingDt;
    if (dt == null || dt <= 0 || dt > 2000) return;
    const k = this.head;
    this.dt[k] = dt;
    this.cpu[k] = cpu;
    this.gpuMs[k] = g ?? NaN;
    this.head = (k + 1) % this.N;
    this.count = Math.min(this.count + 1, this.N);
    this.totalFrames++;
    if (dt > 1.5 * (1000 / this.targetHz)) this.longFrames++;

    if (this.bench) this.benchFrame(dt, cpu, g);
  }

  // Restart frame timing (e.g. XR timestamps use a different timebase than window rAF).
  resetTiming() {
    this.lastT = null;
    this.pendingDt = null;
    this.count = 0;
    this.longFrames = 0;
  }

  // Frames from the last `windowMs` milliseconds, newest first.
  recent(windowMs) {
    const dts = [], cpus = [], gpus = [];
    let sum = 0;
    for (let i = 0; i < this.count && sum < windowMs; i++) {
      const k = (this.head - 1 - i + this.N) % this.N;
      dts.push(this.dt[k]);
      cpus.push(this.cpu[k]);
      if (!Number.isNaN(this.gpuMs[k])) gpus.push(this.gpuMs[k]);
      sum += this.dt[k];
    }
    return { dts, cpus, gpus, sum };
  }

  live() {
    const one = this.recent(1000);
    const ten = this.recent(10000);
    const s1 = [...one.dts].sort((a, b) => a - b);
    const s10 = [...ten.dts].sort((a, b) => b - a);
    const worst = s10.slice(0, Math.max(1, Math.floor(s10.length * 0.01)));
    return {
      fps: one.sum > 0 ? (one.dts.length * 1000) / one.sum : 0,
      msAvg: avg(one.dts),
      msP95: pct(s1, 0.95),
      msMax: s1.length ? s1[s1.length - 1] : NaN,
      low1: worst.length ? 1000 / avg(worst) : NaN,
      cpuAvg: avg(one.cpus),
      gpuAvg: one.gpus.length ? avg(one.gpus) : null,
    };
  }

  // ---------- sections (key/value groups shown in HUD + reports) ----------

  set(section, values) {
    const cur = this.sections.get(section) || {};
    this.sections.set(section, Object.assign(cur, values));
  }

  clear(section) { this.sections.delete(section); }

  // ---------- HUD ----------

  cycleMode() {
    this.mode = { compact: 'full', full: 'off', off: 'compact' }[this.mode];
    this.hudWrap.classList.toggle('off', this.mode === 'off');
    this.renderHud();
    return this.mode;
  }

  renderHud() {
    if (this.mode === 'off' || !this.hudEl.offsetParent) return;
    const L = this.live();
    const target = 1000 / this.targetHz;
    const cls = L.msAvg <= target * 1.15 ? 'good' : L.msAvg <= target * 1.6 ? 'warn' : 'bad';
    const c = this.counters;
    const mem = this.renderer.info.memory;
    const heap = performance.memory ? fmtBytes(performance.memory.usedJSHeapSize) : 'n/a';
    const gpu = this.gpu.ext ? (L.gpuAvg != null ? `${L.gpuAvg.toFixed(1)} ms` : '…') : 'n/a';

    let html =
      `<span class="big ${cls}">${L.fps.toFixed(1)} fps</span>  <span class="k">target</span> ${this.targetHz} Hz\n` +
      `<span class="k">frame</span> ${L.msAvg.toFixed(1)} <span class="k">p95</span> ${L.msP95.toFixed(1)} <span class="k">max</span> ${L.msMax.toFixed(1)} ms\n` +
      `<span class="k">1% low</span> ${L.low1.toFixed(1)} fps  <span class="k">long</span> ${this.longFrames}\n` +
      `<span class="k">cpu</span> ${L.cpuAvg.toFixed(2)} ms  <span class="k">gpu</span> ${gpu}\n` +
      `<span class="k">draws</span> ${c.calls}  <span class="k">tris</span> ${fmtNum(c.triangles)}  <span class="k">pts</span> ${fmtNum(c.points)}\n` +
      `<span class="k">geom</span> ${mem.geometries} <span class="k">tex</span> ${mem.textures} <span class="k">prog</span> ${this.renderer.info.programs?.length ?? 0} <span class="k">heap</span> ${heap}`;
    if (this.bench) {
      const left = Math.max(0, (this.bench.dur - (performance.now() - this.bench.start)) / 1000);
      html += `\n<span class="warn">● BENCHMARK ${left.toFixed(1)}s left</span>`;
    }
    for (const [name, kv] of this.sections) {
      if (this.mode === 'compact' && name !== 'Tracking') continue;
      html += `\n<span class="h">${esc(name)}</span>`;
      for (const [k, v] of Object.entries(kv)) html += `\n <span class="k">${esc(k)}</span> ${esc(v)}`;
    }
    this.hudEl.innerHTML = html;
    this.drawGraph();
  }

  drawGraph() {
    const ctx = this.graphCtx;
    const W = this.graph.width, H = this.graph.height;
    const maxMs = 50;
    const target = 1000 / this.targetHz;
    ctx.clearRect(0, 0, W, H);
    const n = Math.min(this.count, W);
    for (let i = 0; i < n; i++) {
      const k = (this.head - 1 - i + this.N) % this.N;
      const ms = this.dt[k];
      const h = Math.min(H, (ms / maxMs) * H);
      ctx.fillStyle = ms <= target * 1.15 ? '#4fd1a5' : ms <= target * 1.6 ? '#f2b84b' : '#f2665b';
      ctx.fillRect(W - 1 - i, H - h, 1, h);
    }
    ctx.fillStyle = 'rgba(255,255,255,.35)';
    for (const ms of [16.67, 33.33]) ctx.fillRect(0, H - (ms / maxMs) * H, W, 1);
    ctx.font = '9px monospace';
    ctx.fillText('16.7', 2, H - (16.67 / maxMs) * H - 2);
    ctx.fillText('33.3', 2, H - (33.33 / maxMs) * H - 2);
  }

  // ---------- crash breadcrumbs ----------

  setContext(values) {
    Object.assign(this.context, values);
    this.persistCrumb();
  }

  persistCrumb(clean = false) {
    try {
      const L = this.count ? this.live() : {};
      localStorage.setItem(CRUMB_KEY, JSON.stringify({
        clean,
        time: Date.now(),
        context: this.context,
        live: { fps: L.fps, msAvg: L.msAvg, triangles: this.counters.triangles, calls: this.counters.calls,
          heap: performance.memory?.usedJSHeapSize ?? null },
        logs: this.logs.slice(-30),
      }));
    } catch { /* storage blocked or full */ }
  }

  // ---------- log ----------

  log(msg, level = 'info') {
    const t = ((performance.now() - this.t0) / 1000).toFixed(1);
    const entry = { t: +t, level, msg: String(msg) };
    this.logs.push(entry);
    if (this.logs.length > 500) this.logs.shift();
    (console[level] || console.log)(`[${t}s] ${msg}`);
    const line = document.createElement('div');
    line.className = level;
    line.textContent = `${t}s ${msg}`;
    this.logEl.prepend(line);
    while (this.logEl.childElementCount > 150) this.logEl.lastChild.remove();
    this.remoteQueue.push(entry);
    if (level !== 'info') this.persistCrumb(); // keep the latest warning/error in case the next thing is a crash
  }

  queueStatLine() {
    if (!this.streamStats || this.count === 0) return;
    const L = this.live();
    const c = this.counters;
    this.remoteQueue.push({
      t: +((performance.now() - this.t0) / 1000).toFixed(1), level: 'stat',
      msg: `fps=${L.fps.toFixed(1)} ms=${L.msAvg.toFixed(1)} p95=${L.msP95.toFixed(1)} low1%=${L.low1.toFixed(1)} cpu=${L.cpuAvg.toFixed(2)} gpu=${L.gpuAvg?.toFixed(2) ?? 'n/a'} draws=${c.calls} tris=${c.triangles}` +
        (this.sections.get('Tracking')?.distance ? ` dist=${this.sections.get('Tracking').distance}` : ''),
    });
  }

  // Streams log lines to serve.py so they show up in the PC terminal. Silently stops on static hosts.
  async flushRemote() {
    if (!this.remoteEnabled || !this.remoteQueue.length) return;
    const batch = this.remoteQueue.splice(0);
    try {
      const res = await fetch('api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch) });
      if (!res.ok) throw new Error(res.status);
    } catch {
      this.remoteEnabled = false;
      console.info('Remote log endpoint unavailable; logging locally only.');
    }
  }

  // ---------- benchmark ----------

  startBenchmark(seconds, getMeta, onDone) {
    if (this.bench) return false;
    this.bench = { start: performance.now(), dur: seconds * 1000, dts: [], cpus: [], gpus: [], tris: [], calls: [], samples: {}, getMeta, onDone };
    this.log(`Benchmark started (${seconds}s)`);
    return true;
  }

  sample(name, value) {
    if (!this.bench || value == null || Number.isNaN(value)) return;
    (this.bench.samples[name] ||= []).push(value);
  }

  benchFrame(dt, cpu, gpu) {
    const b = this.bench;
    b.dts.push(dt);
    b.cpus.push(cpu);
    if (gpu != null) b.gpus.push(gpu);
    b.tris.push(this.counters.triangles);
    b.calls.push(this.counters.calls);
    if (performance.now() - b.start >= b.dur) this.finishBenchmark();
  }

  finishBenchmark() {
    const b = this.bench;
    this.bench = null;
    const sorted = [...b.dts].sort((x, y) => x - y);
    const worst = [...sorted].reverse().slice(0, Math.max(1, Math.floor(sorted.length * 0.01)));
    const total = b.dts.reduce((s, v) => s + v, 0);
    const target = 1000 / this.targetHz;
    const samples = {};
    for (const [k, arr] of Object.entries(b.samples)) {
      samples[k] = { min: +Math.min(...arr).toFixed(3), avg: +avg(arr).toFixed(3), max: +Math.max(...arr).toFixed(3) };
    }
    const r = {
      time: new Date().toISOString(),
      frames: b.dts.length,
      seconds: +(total / 1000).toFixed(2),
      fpsAvg: +((b.dts.length * 1000) / total).toFixed(2),
      fps1Low: +(1000 / avg(worst)).toFixed(2),
      fpsMin: +(1000 / sorted[sorted.length - 1]).toFixed(2),
      msP50: +pct(sorted, 0.5).toFixed(2),
      msP95: +pct(sorted, 0.95).toFixed(2),
      msP99: +pct(sorted, 0.99).toFixed(2),
      longFrames: b.dts.filter((d) => d > target * 1.5).length,
      cpuMsAvg: +avg(b.cpus).toFixed(3),
      cpuMsP95: +pct([...b.cpus].sort((x, y) => x - y), 0.95).toFixed(3),
      gpuMsAvg: b.gpus.length ? +avg(b.gpus).toFixed(3) : null,
      trianglesAvg: Math.round(avg(b.tris)),
      drawCallsMax: Math.max(...b.calls),
      targetHz: this.targetHz,
      samples,
      ...b.getMeta?.(),
    };
    this.benchResults.push(r);
    this.log(`Benchmark: ${r.fpsAvg} fps avg, 1% low ${r.fps1Low}, p95 ${r.msP95} ms, cpu ${r.cpuMsAvg} ms, gpu ${r.gpuMsAvg ?? 'n/a'} ms, ${r.longFrames} long frames`);
    b.onDone?.(r);
  }

  // ---------- reports ----------

  buildReport(extra = {}) {
    const recent = this.recent(20000);
    return {
      time: new Date().toISOString(),
      userAgent: navigator.userAgent,
      live: this.live(),
      counters: { ...this.counters },
      memory: { ...this.renderer.info.memory, programs: this.renderer.info.programs?.length ?? 0,
        jsHeap: performance.memory ? performance.memory.usedJSHeapSize : null },
      sections: Object.fromEntries(this.sections),
      benchmarks: this.benchResults,
      frameTimesMs: recent.dts.reverse().map((v) => +v.toFixed(2)),
      log: this.logs,
      ...extra,
    };
  }

  async sendReport(report) {
    const json = JSON.stringify(report, null, 2);
    try {
      const res = await fetch('api/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { file } = await res.json();
      this.log(`Report saved on server: ${file}`);
    } catch (e) {
      this.log(`Report upload failed (${e.message}); downloading instead`, 'warn');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      a.download = `glb-ar-report-${Date.now()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
  }
}
