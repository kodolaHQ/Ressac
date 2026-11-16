/**
 * The `min-max` range of RESSAC_CONTAINER_PORTS, else `CONTAINER_PORTS_FALLBACK`. Pure: the kernel and the chrome's page
 * guard parse the variable with this one function, so a bad value never puts them on different ranges.
 */
export const CONTAINER_PORTS_FALLBACK: [number, number] = [5280, 5299];

export function portRange(raw: string | undefined): [number, number] {
  const m = /^(\d{4,5})-(\d{4,5})$/.exec(raw ?? "");
  const [min, max] = m ? [Number(m[1]), Number(m[2])] : [0, 0];
  return min >= 1024 && max <= 65535 && min <= max ? [min, max] : CONTAINER_PORTS_FALLBACK;
}
