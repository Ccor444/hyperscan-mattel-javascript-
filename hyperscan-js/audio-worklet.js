// AudioWorklet de saída do HyperScan: roda na thread de áudio (não é interrompida pelo emulador).
// Recebe blocos intercalados (L,R) da thread principal e os toca; reporta o total consumido e os underruns.
class HSOut extends AudioWorkletProcessor {
  constructor() {
    super();
    this.q = []; this.off = 0; this.queued = 0;      // fila de Float32Array intercalados; amostras (frames) pendentes
    this.consumed = 0; this.under = 0;
    this.port.onmessage = e => { this.q.push(e.data); this.queued += e.data.length >> 1; };
  }
  process(inputs, outputs) {
    const out = outputs[0], L = out[0], R = out[1], n = L.length;
    let i = 0;
    while (i < n) {
      if (this.q.length === 0) { for (; i < n; i++) { L[i] = 0; R[i] = 0; } this.under++; break; }   // silêncio por falta de dados: não conta como consumo
      const blk = this.q[0], frames = blk.length >> 1;
      const take = Math.min(n - i, frames - this.off);
      for (let k = 0; k < take; k++) { L[i + k] = blk[2 * (this.off + k)]; R[i + k] = blk[2 * (this.off + k) + 1]; }
      i += take; this.off += take; this.queued -= take; this.consumed += take;   // só frames reais
      if (this.off >= frames) { this.q.shift(); this.off = 0; }
    }
    // informa o consumo a cada bloco: a página usa esse número para decidir quanto emular (colchão real, sem atraso)
    this.port.postMessage({ consumed: this.consumed, under: this.under, queued: this.queued });
    return true;
  }
}
registerProcessor('hs-out', HSOut);
