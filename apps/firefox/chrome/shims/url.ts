// Stand-in for node:url; only domainToASCII is used (punycode by the URL parser, "" for an invalid name, as Node).
export function domainToASCII(domain: string): string {
  try {
    return new URL(`http://${domain}/`).hostname;
  } catch {
    return "";
  }
}
