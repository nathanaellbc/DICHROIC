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
      if (!['utf-8', 'utf8', 'unicode-1-1-utf-8'].includes(String(label).trim().toLowerCase())) throw new RangeError('Only UTF-8 is used by the native host');
      this.fatal = !!options.fatal;
      this.ignoreBOM = !!options.ignoreBOM;
    }
    get encoding() { return 'utf-8'; }
    decode(input = new Uint8Array()) {
      const bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
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
