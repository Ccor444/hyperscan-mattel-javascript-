// Interface com o microcontrolador do servo de CD (0x88060000), deduzida do driver do BIOS (a00336b0 / a0033730):
//   +0x04 ADDR (12 bits)   +0x08 DATA (byte)   +0x0c CTRL: escrever 0 = escrever DATA em reg[ADDR]; escrever 1 = ler reg[ADDR] para DATA.
//   O driver faz polling de CTRL enquanto vale 1 (ocupado); aqui toda transação conclui na hora.
// Por cima disso há um protocolo de comandos (strings "SCMD:...") em registradores do servo; o modelo evolui conforme o BIOS exige.
export class Servo {
  constructor() {
    this.reg = new Uint8Array(0x1000);
    this.addr = 0; this.data = 0; this.ctrl = 0;
    this.cpu = null;                 // preenchido pela máquina (usado para distinguir quem está lendo)
    this.r79 = { 0xa002de34: 0x20 }; // regras por endereço de retorno (lr) do driver: valor lido em reg 0x79 (a002de34: CAV-on, bit7 limpo)
    this.reg[0x79] = 0xa0;   // bit5: pronto (a0030450), bit7: foco travado/FOK (a003102c)
    this.other = new Map();
    this.log = []; this.logMax = 400; this.trace = false;
    this.hooks = { read: null, write: null };   // hooks(addr, value) => valor opcional
    // Memórias do DSP do servo carregadas pelo BIOS (mailbox 0x500..0x505, status 0x506, resultado 0x507..0x509):
    //   0x500=endereço alto, 0x501=endereço baixo, 0x502..0x504=dado (IM 24 bits / PM 16 bits), 0x505=comando:
    //   0x02 escreve IM, 0x03 lê IM, 0x12 escreve PM, 0x13 lê PM.
    this.im = new Uint32Array(0x10000); this.pm = new Uint32Array(0x10000);
  }
  mailbox(cmd) {
    const r = this.reg, a = (r[0x500] << 8) | r[0x501];
    switch (cmd) {
      case 0x02: this.im[a] = r[0x502] | r[0x503] << 8 | r[0x504] << 16; break;
      case 0x12: this.pm[a] = r[0x502] | r[0x503] << 8; break;
      case 0x03: { const v = this.im[a]; r[0x507] = v & 0xff; r[0x508] = (v >> 8) & 0xff; r[0x509] = (v >> 16) & 0xff; break; }
      case 0x13: { const v = this.pm[a]; r[0x507] = v & 0xff; r[0x508] = (v >> 8) & 0xff; r[0x509] = 0; break; }
    }
  }
  // Comando do uP do servo: parâmetros em 0x409.. e disparo em 0x40d. Por enquanto só registramos (HLE vem depois).
  command(v) {
    const r = this.reg;
    this.cmdLog = this.cmdLog || [];
    if (this.cmdLog.length < 200) this.cmdLog.push(`cmd 0x40d=${v.toString(16)} p409=${r[0x409].toString(16)} p40a=${r[0x40a].toString(16)} p40b=${r[0x40b].toString(16)} p40c=${r[0x40c].toString(16)} p40e=${r[0x40e].toString(16)}`);
  }
  note(s) { if (this.trace && this.log.length < this.logMax) this.log.push(s); }
  read(off) {
    switch (off) {
      case 0x04: return this.addr;
      case 0x08: return this.data;
      case 0x0c: return this.ctrl;
    }
    const v = this.other.get(off) ?? 0;
    this.note(`R other +${off.toString(16)} -> ${v.toString(16)}`);
    return v;
  }
  write(off, v) {
    switch (off) {
      case 0x04: this.addr = v & 0xfff; return;
      case 0x08: this.data = v & 0xff; return;
      case 0x0c: {
        if ((v & 0xff) === 0) {                                   // escrita
          const old = this.reg[this.addr];
          let val = this.data;
          if (this.hooks.write) { const r = this.hooks.write(this.addr, val, this); if (r !== undefined) val = r; }
          this.reg[this.addr] = val;
          if (this.addr === 0x505) this.mailbox(val);
          if (this.addr === 0x40d && (val & 0x80)) { this.command(val); val &= 0x3f; this.reg[this.addr] = val; }   // comando concluído na hora: bit7 (busy) zera
          this.note(`W reg[${this.addr.toString(16)}] = ${val.toString(16)} (era ${old.toString(16)})`);
        } else if ((v & 0xff) === 1) {                            // leitura
          let val = this.reg[this.addr];
          if (this.addr === 0x79 && this.cpu) { const lr = this.cpu.r[3] >>> 0; if (this.r79[lr] !== undefined) val = this.r79[lr]; }
          if (this.addr === 0x7d && this.reg[0x30] === 2) val = 0x30;   // medição FE_P2P (pico a pico do erro de foco): disco presente
          if (this.hooks.read) { const r = this.hooks.read(this.addr, val, this); if (r !== undefined) val = r; }
          this.data = val;
          this.note(`R reg[${this.addr.toString(16)}] -> ${val.toString(16)}`);
        }
        this.ctrl = 0; return;
      }
    }
    this.other.set(off, v); this.note(`W other +${off.toString(16)} = ${v.toString(16)}`);
  }
}
