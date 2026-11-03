// Stand-in for node:net; only isIP is used.
export function isIP(s: string): 0 | 4 | 6 {
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(s)) return 4;
  return s.includes(":") && /^[0-9a-f:.]+$/i.test(s) ? 6 : 0;
}
