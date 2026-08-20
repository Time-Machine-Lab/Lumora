import { inflateSync } from 'node:zlib';

export interface RgbaPng {
  width: number;
  height: number;
  data: Buffer;
}

/** 取 (x, y) 像素的 RGBA（x/y 为设备像素坐标，从 0 起） */
export function pngPixel(png: RgbaPng, x: number, y: number): [number, number, number, number] {
  const index = (y * png.width + x) * 4;
  return [png.data[index]!, png.data[index + 1]!, png.data[index + 2]!, png.data[index + 3]!];
}

/**
 * 依赖零的 PNG 解码（Playwright 截图：RGBA8、非隔行，filter 五种类型全支持）。
 * 用于逐像素验证 letterbox 黑边等渲染结果。
 */
export function decodePng(buf: Buffer): RgbaPng {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  if (![0, 2, 4, 6].includes(colorType) || bitDepth !== 8 || interlace !== 0) {
    throw new Error(`unsupported png: colorType=${colorType} bitDepth=${bitDepth} interlace=${interlace}`);
  }
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(width * 4 * height);
  let prev: Buffer | null = null;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const outLine = Buffer.allocUnsafe(stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? outLine[x - bpp]! : 0;
      const b = prev ? prev[x]! : 0;
      const c = prev && x >= bpp ? prev[x - bpp]! : 0;
      let v = line[x]!;
      switch (filter) {
        case 0:
          break;
        case 1:
          v += a;
          break;
        case 2:
          v += b;
          break;
        case 3:
          v += (a + b) >> 1;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          throw new Error(`bad filter ${filter}`);
      }
      outLine[x] = v & 0xff;
    }
    // 展开为 RGBA（0=灰、2=RGB、4=灰+alpha、6=RGBA）
    const row = rgba.subarray(y * width * 4, (y + 1) * width * 4);
    for (let x = 0; x < width; x += 1) {
      const r = outLine[x * bpp]!;
      const g = bpp >= 3 ? outLine[x * bpp + 1]! : r;
      const b = bpp >= 3 ? outLine[x * bpp + 2]! : r;
      row[x * 4] = r;
      row[x * 4 + 1] = g;
      row[x * 4 + 2] = b;
      row[x * 4 + 3] = bpp === 4 ? outLine[x * bpp + 3]! : bpp === 2 ? outLine[x * bpp + 1]! : 255;
    }
    prev = outLine;
  }
  return { width, height, data: rgba };
}
