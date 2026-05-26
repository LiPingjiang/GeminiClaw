// src/utils/strip-tool-xml.ts

export function stripToolXml(text: string): string {
  if (!text) return text;
  const tags = ["tool_call", "tool_response", "tool_thinking"];
  let result = text;
  for (const tag of tags) {
    let out = "";
    let i = 0;
    const open = `<${tag}>`;
    const close = `</${tag}>`;
    while (i < result.length) {
      const s = result.indexOf(open, i);
      if (s === -1) {
        out += result.slice(i);
        break;
      }
      out += result.slice(i, s);
      const e = result.indexOf(close, s);
      if (e === -1) {
        i = s + open.length;
        continue;
      }
      i = e + close.length;
    }
    result = out;
  }
  return result.trim();
}
