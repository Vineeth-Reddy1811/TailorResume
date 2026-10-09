function paragraphStyleId(paragraphXml: string): string | null {
  return paragraphXml.match(/<w:pStyle\b[^>]*\bw:val="([^"]+)"/)?.[1] ?? null;
}

function paragraphStyleHasNumbering(styleId: string, stylesXml: string, visited = new Set<string>()): boolean {
  if (visited.has(styleId)) return false;
  visited.add(styleId);
  if (/^List(?:Paragraph|Bullet|Number)/i.test(styleId)) return true;

  const escapedStyleId = styleId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const styleXml = stylesXml.match(new RegExp(`<w:style\\b(?=[^>]*\\bw:styleId="${escapedStyleId}")[\\s\\S]*?<\\/w:style>`))?.[0];
  if (!styleXml) return false;
  if (/<w:numPr\b[\s\S]*?<\/w:numPr>/.test(styleXml)) return true;

  const parentStyleId = styleXml.match(/<w:basedOn\b[^>]*\bw:val="([^"]+)"/)?.[1];
  return parentStyleId ? paragraphStyleHasNumbering(parentStyleId, stylesXml, visited) : false;
}

export function isBulletParagraph(paragraphXml: string, stylesXml = ""): boolean {
  if (/<w:numPr\b[\s\S]*?<\/w:numPr>/.test(paragraphXml)) return true;
  const styleId = paragraphStyleId(paragraphXml);
  return styleId ? paragraphStyleHasNumbering(styleId, stylesXml) : false;
}
