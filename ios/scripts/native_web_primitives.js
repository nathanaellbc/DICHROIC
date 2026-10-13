// JavaScriptCore intentionally has no DOM. These UTF-8 primitives cover the
// canonical host's manifest/ICC text while keeping photography out of a WebView.
if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = class TextEncoder {
    get encoding() { return 'utf-8'; }
    encode(input = '') {
      const bytes = [];
      for (const character of String(input)) {
        let code = character.codePointAt(0);
        if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
        if (code < 0x80) bytes.push(code);
        else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
        else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
        else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
      }
      return Uint8Array.from(bytes);
    }
  };
}
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = class TextDecoder {
    constructor(label = 'utf-8', options = {}) {
      const encoding = String(label).trim().toLowerCase();
      this.latin = ['latin1', 'iso-8859-1', 'windows-1252', 'ascii', 'us-ascii'].includes(encoding);
      if (!this.latin && !['utf-8', 'utf8', 'unicode-1-1-utf-8'].includes(encoding)) throw new RangeError('Unsupported native text encoding');
      this.fatal = !!options.fatal;
      this.ignoreBOM = !!options.ignoreBOM;
    }
    get encoding() { return this.latin ? 'windows-1252' : 'utf-8'; }
    decode(input = new Uint8Array()) {
      const bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
      if (this.latin) {
        // WHATWG latin1 aliases windows-1252, including its control-range map.
        const controls = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178];
        let text = '';
        for (const byte of bytes) text += String.fromCharCode(byte >= 0x80 && byte <= 0x9f ? controls[byte - 0x80] : byte);
        return text;
      }
      let text = '', i = 0;
      const invalid = () => { if (this.fatal) throw new TypeError('Invalid UTF-8'); text += '\ufffd'; };
      while (i < bytes.length) {
        const first = bytes[i++];
        if (first < 0x80) { text += String.fromCharCode(first); continue; }
        const count = first >= 0xc2 && first <= 0xdf ? 1 : first <= 0xef && first >= 0xe0 ? 2 : first <= 0xf4 && first >= 0xf0 ? 3 : 0;
        if (!count) { invalid(); continue; }
        let code = first & (0x7f >> count), valid = true;
        for (let n = 0; n < count; n++) {
          const value = bytes[i];
          const lower = n === 0 && first === 0xe0 ? 0xa0 : n === 0 && first === 0xf0 ? 0x90 : 0x80;
          const upper = n === 0 && first === 0xed ? 0x9f : n === 0 && first === 0xf4 ? 0x8f : 0xbf;
          if (value === undefined || value < lower || value > upper) { valid = false; break; }
          i++; code = (code << 6) | (value & 63);
        }
        if (valid) text += String.fromCodePoint(code); else invalid();
      }
      return !this.ignoreBOM && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    }
  };
}
