/**
 * 零依赖二维码生成器（字节模式，纠错等级 L，版本 1-5）。
 *
 * 用途：把局域网看板地址渲染成二维码，供手机相机扫描。
 * 只实现到版本 5（最多 106 字节），足够放下 `http://192.168.1.32:8791/?k=...` 这类地址，
 * 也因此每个版本都只有一个纠错块，不需要分块交织。
 *
 * 参考 ISO/IEC 18004。对外导出 qrMatrix / qrSvg / qrAscii。
 */

/** 纠错等级 L 在格式信息里的编码。 */
const EC_BITS_L = 1;

/** 版本 → 数据码字数、纠错码字数、校正图形中心坐标。 */
const VERSIONS = [
  null,
  { data: 19, ec: 7, align: null },
  { data: 34, ec: 10, align: [6, 18] },
  { data: 55, ec: 15, align: [6, 22] },
  { data: 80, ec: 20, align: [6, 26] },
  { data: 108, ec: 26, align: [6, 30] },
];

/** 最多支撑的版本，超过就抛错。 */
export const MAX_VERSION = VERSIONS.length - 1;

/* ------------------------------------------------------------------ 伽罗华域 GF(256) */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
}

/** GF(256) 乘法。 */
function gmul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** 生成多项式 g(x) = ∏(x - α^i)，最高次项系数在前。 */
export function rsGenPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gmul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Reed-Solomon 纠错码字（综合除法取余）。 */
export function rsEncode(data, ecLength) {
  const gen = rsGenPoly(ecLength);
  const work = new Uint8Array(data.length + ecLength);
  work.set(data, 0);
  for (let i = 0; i < data.length; i += 1) {
    const factor = work[i];
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j += 1) work[i + j] ^= gmul(gen[j], factor);
  }
  return work.slice(data.length);
}

/* ------------------------------------------------------------------ 数据编码 */

/** 选最小可用版本；超长直接抛错，调用方自己决定怎么提示。 */
export function pickVersion(byteLength) {
  for (let v = 1; v <= MAX_VERSION; v += 1) {
    if (4 + 8 + byteLength * 8 <= VERSIONS[v].data * 8) return v;
  }
  throw new Error(`二维码内容过长：${byteLength} 字节，最多 ${VERSIONS[MAX_VERSION].data - 2} 字节`);
}

/** 字节模式 + 终止符 + 补位，得到数据码字。 */
export function encodeCodewords(bytes, capacity) {
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const byte of bytes) push(byte, 8);

  const capacityBits = capacity * 8;
  for (let i = 0; i < 4 && bits.length < capacityBits; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const out = new Uint8Array(capacity);
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) value = (value << 1) | bits[i + j];
    out[i / 8] = value;
  }
  const pads = [0xec, 0x11];
  for (let i = bits.length / 8, k = 0; i < capacity; i += 1, k += 1) out[i] = pads[k % 2];
  return out;
}

/* ------------------------------------------------------------------ 掩码与评分 */

/** 掩码公式，i = 行，j = 列。 */
function maskBit(pattern, i, j) {
  switch (pattern) {
    case 0: return (i + j) % 2 === 0;
    case 1: return i % 2 === 0;
    case 2: return j % 3 === 0;
    case 3: return (i + j) % 3 === 0;
    case 4: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    case 5: return ((i * j) % 2) + ((i * j) % 3) === 0;
    case 6: return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
    case 7: return (((i * j) % 3) + ((i + j) % 2)) % 2 === 0;
    default: throw new Error(`未知掩码：${pattern}`);
  }
}

const PENALTY_A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
const PENALTY_B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];

/** 四条掩码评分规则，分数越低越好。 */
export function penalty(modules, size) {
  let score = 0;
  const at = (r, c) => modules[r * size + c];

  for (let r = 0; r < size; r += 1) {
    let run = 1;
    for (let c = 1; c <= size; c += 1) {
      if (c < size && at(r, c) === at(r, c - 1)) run += 1;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
  }
  for (let c = 0; c < size; c += 1) {
    let run = 1;
    for (let r = 1; r <= size; r += 1) {
      if (r < size && at(r, c) === at(r - 1, c)) run += 1;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
  }
  for (let r = 0; r + 1 < size; r += 1) {
    for (let c = 0; c + 1 < size; c += 1) {
      const v = at(r, c);
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) score += 3;
    }
  }
  const window = (get) => {
    for (let start = 0; start + 11 <= size; start += 1) {
      let a = true;
      let b = true;
      for (let k = 0; k < 11; k += 1) {
        const v = get(start + k);
        if (v !== PENALTY_A[k]) a = false;
        if (v !== PENALTY_B[k]) b = false;
      }
      if (a) score += 40;
      if (b) score += 40;
    }
  };
  for (let r = 0; r < size; r += 1) window((k) => at(r, k));
  for (let c = 0; c < size; c += 1) window((k) => at(k, c));

  let dark = 0;
  for (let i = 0; i < modules.length; i += 1) dark += modules[i];
  score += Math.floor(Math.abs((100 * dark) / (size * size) - 50) / 5) * 10;
  return score;
}

/* ------------------------------------------------------------------ 矩阵 */

/** 拼出某个掩码下的完整矩阵。 */
export function buildMatrix(version, codewords, mask) {
  const size = version * 4 + 17;
  const modules = new Uint8Array(size * size);
  const fixed = new Uint8Array(size * size);
  const put = (r, c, value) => {
    modules[r * size + c] = value ? 1 : 0;
    fixed[r * size + c] = 1;
  };

  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const rr = r0 + r;
        const cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const dark = (r >= 0 && r <= 6 && (c === 0 || c === 6))
          || (c >= 0 && c <= 6 && (r === 0 || r === 6))
          || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        put(rr, cc, dark);
      }
    }
  }
  for (let i = 8; i < size - 8; i += 1) {
    put(6, i, i % 2 === 0);
    put(i, 6, i % 2 === 0);
  }
  if (version >= 2) {
    const centers = VERSIONS[version].align;
    for (const cy of centers) {
      for (const cx of centers) {
        if ((cx < 9 && cy < 9) || (cx < 9 && cy > size - 10) || (cx > size - 10 && cy < 9)) continue;
        for (let r = -2; r <= 2; r += 1) {
          for (let c = -2; c <= 2; c += 1) {
            put(cy + r, cx + c, Math.max(Math.abs(r), Math.abs(c)) !== 1);
          }
        }
      }
    }
  }

  const data = (EC_BITS_L << 3) | mask;
  let remainder = data << 10;
  for (let i = 14; i >= 10; i -= 1) if ((remainder >>> i) & 1) remainder ^= 0x537 << (i - 10);
  const format = ((data << 10) | (remainder & 0x3ff)) ^ 0x5412;
  for (let i = 0; i < 15; i += 1) {
    const bit = (format >> i) & 1;
    if (i < 6) put(i, 8, bit);
    else if (i < 8) put(i + 1, 8, bit);
    else put(size - 15 + i, 8, bit);

    if (i < 8) put(8, size - 1 - i, bit);
    else if (i < 9) put(8, 7, bit);
    else put(8, 14 - i, bit);
  }
  put(size - 8, 8, 1);

  let bitIndex = 0;
  let upward = true;
  const totalBits = codewords.length * 8;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (let i = 0; i < size; i += 1) {
      const row = upward ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        const index = row * size + c;
        if (fixed[index]) continue;
        const bit = bitIndex < totalBits
          ? (codewords[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1
          : 0;
        bitIndex += 1;
        modules[index] = maskBit(mask, row, c) ? bit ^ 1 : bit;
      }
    }
    upward = !upward;
  }
  return { size, modules, fixed };
}

/**
 * 生成二维码矩阵。
 * @returns {{ text: string, version: number, size: number, mask: number, modules: Uint8Array }}
 */
export function qrMatrix(text) {
  const value = String(text);
  const bytes = new TextEncoder().encode(value);
  const version = pickVersion(bytes.length);
  const { data: capacity, ec: ecLength } = VERSIONS[version];
  const payload = encodeCodewords(bytes, capacity);
  const ec = rsEncode(payload, ecLength);
  const codewords = new Uint8Array(payload.length + ec.length);
  codewords.set(payload, 0);
  codewords.set(ec, payload.length);

  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = buildMatrix(version, codewords, mask);
    const score = penalty(candidate.modules, candidate.size);
    if (best === null || score < best.score) best = { ...candidate, mask, score };
  }
  return {
    text: value,
    version,
    size: best.size,
    mask: best.mask,
    modules: best.modules,
  };
}

/* ------------------------------------------------------------------ 渲染 */

/** 渲染成 SVG 字符串；白底黑块，便于在任何主题下扫描。 */
export function qrSvg(text, options = {}) {
  const margin = options.margin ?? 4;
  const scale = options.scale ?? 8;
  const dark = options.dark ?? '#000000';
  const light = options.light ?? '#ffffff';
  const qr = qrMatrix(text);
  const box = qr.size + margin * 2;
  const runs = [];
  for (let r = 0; r < qr.size; r += 1) {
    let c = 0;
    while (c < qr.size) {
      if (!qr.modules[r * qr.size + c]) {
        c += 1;
        continue;
      }
      let length = 1;
      while (c + length < qr.size && qr.modules[r * qr.size + c + length]) length += 1;
      runs.push(`M${c + margin} ${r + margin}h${length}v1h-${length}z`);
      c += length;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${box * scale}" height="${box * scale}" viewBox="0 0 ${box} ${box}" shape-rendering="crispEdges" role="img" aria-label="二维码">`
    + `<rect width="${box}" height="${box}" fill="${light}"/>`
    + `<path fill="${dark}" d="${runs.join('')}"/>`
    + '</svg>';
}

/** 渲染成终端里的半块字符画（深色底/浅色底的终端都能扫）。 */
export function qrAscii(text, options = {}) {
  const margin = options.margin ?? 2;
  const qr = qrMatrix(text);
  const box = qr.size + margin * 2;
  const at = (r, c) => {
    if (r < margin || c < margin || r >= box - margin || c >= box - margin) return 0;
    return qr.modules[(r - margin) * qr.size + (c - margin)];
  };
  let out = '';
  let fg = -1;
  let bg = -1;
  for (let r = 0; r < box; r += 2) {
    for (let c = 0; c < box; c += 1) {
      const top = at(r, c) ? 16 : 231;
      const bottom = r + 1 < box && at(r + 1, c) ? 16 : 231;
      if (top !== fg || bottom !== bg) {
        out += `\u001b[38;5;${top};48;5;${bottom}m`;
        fg = top;
        bg = bottom;
      }
      out += '▀';
    }
    out += '\u001b[0m\n';
    fg = -1;
    bg = -1;
  }
  return out;
}
