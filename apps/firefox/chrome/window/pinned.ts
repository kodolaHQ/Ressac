/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const PINNED_PREF = "webaios.extensions.pinned";

/** The pinned add-on ids from the pref's JSON; anything unreadable is []. */
export function parsePinned(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : [];
  } catch {
    return [];
  }
}

/** No duplicate, order kept, new ids last. */
export function setPinned(list: string[], id: string, pinned: boolean): string[] {
  if (!pinned) return list.filter((x) => x !== id);
  return list.includes(id) ? list : [...list, id];
}
