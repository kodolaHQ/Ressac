/** The effective lab: stored on, and AI on (off, AI keeps `lab` as stored). */
export const labOn = (s: { aiEnabled: boolean; lab: boolean | null }): boolean => s.aiEnabled && s.lab === true;
