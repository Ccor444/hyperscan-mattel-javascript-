// Carregador do núcleo WASM do HyperScan. API próxima à do src/hyperscan.js (JS puro):
//   const hs = await HyperScan.create(biosBytes, { fastBoot, idleSkip, fastPaths }, wasmUrlOuBytes?);
//   hs.insertDisc(bytes); hs.run(n); hs.renderTo(imageData); hs.setPad(0, {in0,in1,ax,ay}); hs.uart; hs.error ...
// Funciona no navegador e no Node (>= 18). Só precisa do arquivo hyperscan.wasm ao lado deste módulo.
// A UART/erros são bytes (latin1), como String.fromCharCode no JS puro
const dec = { decode(b) { let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return s; } };

async function loadWasm(src) {
  let bytes = src;
  if (!bytes) {
    const url = new URL('./hyperscan.wasm', import.meta.url);
    if (url.protocol === 'file:') { const fs = await import('node:fs/promises'); bytes = await fs.readFile(url); }
    else bytes = await fetch(url);
  } else if (typeof bytes === 'string') bytes = await fetch(bytes);
  let mod;
  // imports mínimos (WASI): o núcleo não usa arquivos nem relógio; qualquer import desconhecido vira função vazia
  const stub = new Proxy({}, { get: (_, k) => (k === 'fd_write' ? () => 0 : () => 0) });
  const envImp = new Proxy({}, { get: (_, k) => (k === 'hs_jit_sync' ? () => (HyperScan._cur ? HyperScan._cur._jitSync() : 0) : () => 0) });
  const imports = { wasi_snapshot_preview1: stub, env: envImp };
  if (typeof Response !== 'undefined' && bytes instanceof Response) mod = await WebAssembly.instantiateStreaming(bytes, imports).catch(async () => WebAssembly.instantiate(await bytes.arrayBuffer(), imports));
  else mod = await WebAssembly.instantiate(bytes, imports);
  const inst = mod.instance || mod;
  if (inst.exports._initialize) inst.exports._initialize();
  return inst.exports;
}

export class HyperScan {
  static async create(biosBytes, opts = {}, wasmSrc) {
    const x = await loadWasm(wasmSrc);
    return new HyperScan(x, biosBytes, opts);
  }
  constructor(x, biosBytes, opts = {}) {
    this.x = x;
    const bios = biosBytes instanceof Uint8Array ? biosBytes : new Uint8Array(biosBytes);
    const p = x.hs_malloc(bios.length);
    this.u8().set(bios, p);
    this.h = x.hs_create(p, bios.length, opts.fastBoot !== false, opts.idleSkip !== false, opts.fastPaths !== false);
    x.hs_free(p);
    this._img = null;
    // JIT para WebAssembly (blocos quentes da CPU); opts.jit = false desliga, opts.jitThreshold ajusta o limiar
    this._jitBusy = null;
    this._jitOn = opts.jit !== false && !!x.__indirect_function_table;
    x.hs_jit_config(this.h, this._jitOn ? 1 : 0, opts.jitThreshold || 20, opts.jitSync !== false ? 1 : 0);
  }
  u8() { return new Uint8Array(this.x.memory.buffer); }   // recriado a cada uso: memory.grow invalida as views
  str(pf, lf) { const n = this.x[lf](this.h); return n ? dec.decode(this.u8().subarray(this.x[pf](this.h), this.x[pf](this.h) + n)) : ''; }

  insertDisc(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const p = this.x.hs_disc_buffer(this.h, b.length);   // buffer da imagem dentro do WASM: uma única cópia
    this.u8().set(b, p);
    this.x.hs_disc_commit(this.h);
  }
  reset() { this.x.hs_reset(this.h); }
  run(n) {
    const prev = HyperScan._cur; HyperScan._cur = this;
    try { this.x.hs_run(this.h, n); } finally { HyperScan._cur = prev; }
    if (this._jitOn) this._jitPoll();
  }

  // Compilação síncrona dentro do hs_run (chamada pelo import hs_jit_sync). Devolve 1 se instalou; 0 se o ambiente não permite
  // compilar síncrono (ex.: thread principal do Chrome limita a 4 KB) — nesse caso o caminho assíncrono assume.
  _canSync() { return typeof WorkerGlobalScope !== 'undefined' || typeof window === 'undefined'; }
  _jitSync() {
    const x = this.x, h = this.h;
    const len = x.hs_jit_pending_len(h);
    if (!len) return 1;
    const ptr = x.hs_jit_pending_ptr(h), nb = x.hs_jit_pending_blocks(h);
    const bytes = this.u8().slice(ptr, ptr + len);
    // thread principal do Chrome só compila síncrono módulos de até 4 KB; maiores seguem pelo caminho assíncrono
    if (len > 4096 && typeof window !== 'undefined' && typeof WorkerGlobalScope === 'undefined') return 0;
    let mod;
    try { mod = new WebAssembly.Module(bytes); } catch (e) { return 0; }
    this._jitInstall(mod, nb);
    return 1;
  }
  _jitInstall(mod, nb) {
    const x = this.x, h = this.h;
    const inst = new WebAssembly.Instance(mod, { env: { mem: x.memory, rd: x.hs_jit_rd, wr: x.hs_jit_wr, inv: x.hs_jit_inv, interp: x.hs_jit_interp } });
    const tbl = x.__indirect_function_table;
    for (let i = 0; i < nb; i++) {
      let idx = x.hs_jit_free_slot(h);               // reaproveita slot de bloco descartado
      if (!idx) idx = tbl.grow(1);
      tbl.set(idx, inst.exports['b' + i]);
      x.hs_jit_install(h, i, idx);
    }
    x.hs_jit_ack(h);
  }

  // Se o núcleo tem um módulo de blocos pronto, compila de forma assíncrona e instala na tabela de funções.
  _jitPoll() {
    const x = this.x, h = this.h;
    if (this._jitBusy) return;
    const len = x.hs_jit_pending_len(h);
    if (!len) return;
    // Node/Worker: compila e instala já (um módulo com todos os blocos traduzidos neste run); thread principal: assíncrono
    if (this._canSync() && this._jitSync()) return;
    const ptr = x.hs_jit_pending_ptr(h), nb = x.hs_jit_pending_blocks(h);
    const bytes = this.u8().slice(ptr, ptr + len);
    this._jitBusy = WebAssembly.compile(bytes).then(mod => {
      if (!this.h) return;
      this._jitInstall(mod, nb);
    }).catch(e => {
      if (this.h) x.hs_jit_fail(h);
      this._jitOn = false;
      if (typeof console !== 'undefined') console.warn('JIT desligado:', e && e.message);
    }).finally(() => { this._jitBusy = null; });
  }
  // Espera a compilação em andamento (útil em testes: torna o momento da instalação determinístico).
  async jitWait() { while (this._jitBusy) await this._jitBusy; this._jitPoll(); while (this._jitBusy) await this._jitBusy; }
  jitStats() {
    const x = this.x, h = this.h;
    return { blocks: x.hs_jit_stat(h, 0), instrs: x.hs_jit_stat(h, 1), modules: x.hs_jit_stat(h, 2), installed: x.hs_jit_stat(h, 3), invalidations: x.hs_jit_stat(h, 4), enabled: !!x.hs_jit_stat(h, 5), jitInstrs: x.hs_jit_stat(h, 7), jitCalls: x.hs_jit_stat(h, 8) };
  }
  // blocos mais pesados desde o último jitTopReset(): [{pc, weight (instruções), n}]
  jitTop(k = 6) {
    const o = [];
    for (let i = 0; i < k; i++) { const pc = this.x.hs_jit_top(this.h, i, 0); if (pc < 0) break; o.push({ pc: pc >>> 0, weight: this.x.hs_jit_top(this.h, i, 1), n: this.x.hs_jit_top(this.h, i, 2) }); }
    return o;
  }
  jitTopReset() { this.x.hs_jit_top_reset(this.h); }
  jitIo() { return this.x.hs_jit_stat(this.h, 11); }
  jitFallbacks(max = 20) {
    const o = [];
    for (let i = 0; i < max; i++) { const k = this.x.hs_jit_fallback(this.h, i, 0); if (k < 0) break; o.push({ key: '0x' + k.toString(16), count: this.x.hs_jit_fallback(this.h, i, 1) }); }
    return o;
  }
  screenSize() { return [this.x.hs_screen_w(this.h), this.x.hs_screen_h(this.h)]; }
  // Desenha o quadro atual em imageData (RGBA, screenSize()).
  renderTo(imageData) {
    const [w, h] = this.screenSize(), p = this.x.hs_render(this.h);
    imageData.data.set(this.u8().subarray(p, p + w * h * 4));
    return true;
  }
  setPad(port, { in0 = 0, in1 = 0, ax = 0x7f, ay = 0x7f } = {}) { this.x.hs_set_pad(this.h, port ? 1 : 0, in0, in1, ax, ay); }
  insertCard(set = 5, num = 1) { this.x.hs_insert_card(this.h, set, num); }
  removeCard() { this.x.hs_remove_card(this.h); }

  get pc() { return this.x.hs_pc(this.h) >>> 0; }
  get cycles() { return this.x.hs_cycles(this.h); }
  get frames() { return this.x.hs_frames(this.h); }
  reg(i) { return this.x.hs_reg(this.h, i); }
  get error() { return this.str('hs_error_ptr', 'hs_error_len') || null; }
  get uart() { return this.str('hs_uart_ptr', 'hs_uart_len'); }
  get disc() { return this.x.hs_has_disc(this.h) ? { volumeId: this.str('hs_disc_volume_ptr', 'hs_disc_volume_len'), sectors: this.x.hs_disc_sectors(this.h) } : null; }
  get cdhle() { return this.x.hs_cdhle_active(this.h) ? { reads: this.x.hs_cd_reads(this.h), bytes: this.x.hs_cd_bytes(this.h) } : null; }

  // ---- áudio: quadros estéreo intercalados (L,R,...) em um Float32Array novo (pode ser transferido ao AudioWorklet) ----
  audioBuffered() { return this.x.hs_audio_buffered(this.h); }
  pullAudio(n, ratio = 1) {
    if (this.x.hs_audio_pull(this.h, n, ratio) <= 0) return new Float32Array(n * 2);
    const p = this.x.hs_audio_ptr(this.h);
    return new Float32Array(this.x.memory.buffer.slice(p, p + n * 8));
  }

  // ---- save state: binário do núcleo + gzip (CompressionStream no navegador / zlib no Node) ----
  async saveState() {
    const n = this.x.hs_state_save(this.h), p = this.x.hs_state_ptr(this.h);
    const raw = this.u8().slice(p, p + n);
    this.x.hs_state_free(this.h);
    return gzip(raw);
  }
  async loadState(bytes) {
    const raw = await gunzip(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    const p = this.x.hs_malloc(raw.length);
    this.u8().set(raw, p);
    const ok = this.x.hs_state_load(this.h, p, raw.length);
    this.x.hs_free(p);
    if (!ok) throw new Error(this.str('hs_state_error_ptr', 'hs_state_error_len') || 'save state inválido');
  }
  destroy() { if (this.h) { this.x.hs_destroy(this.h); this.h = 0; } }
}

async function gzip(bytes) {
  if (typeof CompressionStream !== 'undefined') {
    const cs = new CompressionStream('gzip'), w = cs.writable.getWriter(); w.write(bytes).catch(() => {}); w.close().catch(() => {});
    return new Uint8Array(await new Response(cs.readable).arrayBuffer());
  }
  const z = await import('node:zlib'); return new Uint8Array(z.gzipSync(bytes));
}
async function gunzip(bytes) {
  if (typeof DecompressionStream !== 'undefined') {
    const ds = new DecompressionStream('gzip'), w = ds.writable.getWriter(); w.write(bytes).catch(() => {}); w.close().catch(() => {});
    return new Uint8Array(await new Response(ds.readable).arrayBuffer());
  }
  const z = await import('node:zlib'); return new Uint8Array(z.gunzipSync(bytes));
}
