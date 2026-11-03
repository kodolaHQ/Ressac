// Stand-in for node:crypto inside Firefox system modules (Web Crypto is a global there).
export const randomUUID = (): string => crypto.randomUUID();
