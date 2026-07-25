// UTF-8-aware base64 codec for xterm's ClipboardAddon (OSC 52 copy/paste).
//
// The addon's bundled codec uses btoa/atob, which treat the payload as Latin-1
// (one char per byte). Multi-byte characters (CJK, accented Latin, box-drawing)
// then get double-UTF-8-encoded on copy and pasted back as mojibake, and
// non-Latin selections throw on read. Routing through TextEncoder/TextDecoder
// treats the payload as the real UTF-8 byte stream, matching the OSC 52 spec
// and native terminals (kitty, alacritty). See xterm #4839.
export class Utf8Base64 {
  encodeText(data) {
    const bytes = new TextEncoder().encode(data);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  decodeText(data) {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    // fatal: throw on malformed base64 or non-UTF-8 bytes rather than writing
    // replacement characters to the clipboard; the addon catches and clears,
    // matching kitty/alacritty's strict decode.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
}
