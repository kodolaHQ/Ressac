import type { IconName } from "./icons";

/**
 * The space icons offered in the space modal. A space still stores the emoji (no data change); the interface draws its
 * line icon. Texts: the label ids. An emoji not in this list (typed before the grid, imported) shows as itself.
 */
export const SPACE_ICONS: [emoji: string, label: string, icon: IconName][] = [
  ["🏠", "sidebar-emoji-home", "home"], ["💼", "sidebar-emoji-work", "briefcase"], ["🎓", "sidebar-emoji-school", "graduation-cap"], ["📚", "sidebar-emoji-reading", "book-open"],
  ["✏️", "sidebar-emoji-writing", "pencil"], ["💻", "sidebar-emoji-code", "code"], ["🧪", "sidebar-emoji-science", "flask-conical"], ["💡", "sidebar-emoji-ideas", "lightbulb"],
  ["🎮", "sidebar-emoji-games", "gamepad-2"], ["🎵", "sidebar-emoji-music", "music"], ["🎬", "sidebar-emoji-movies", "clapperboard"], ["📺", "sidebar-emoji-tv-shows", "tv"],
  ["📷", "sidebar-emoji-photo", "photo"], ["🎨", "sidebar-emoji-art", "palette"], ["🧶", "sidebar-emoji-crafts", "scissors"], ["🎲", "sidebar-emoji-board-games", "dices"],
  ["✈️", "sidebar-emoji-travel", "plane"], ["🗺️", "sidebar-emoji-map", "map"], ["🏖️", "sidebar-emoji-holidays", "sun"], ["🚗", "sidebar-emoji-car", "car"],
  ["🛒", "sidebar-emoji-groceries", "shopping-cart"], ["🛍️", "sidebar-emoji-shopping", "shopping-bag"], ["🍳", "sidebar-emoji-cooking", "chef-hat"], ["☕", "sidebar-emoji-coffee", "coffee"],
  ["💰", "sidebar-emoji-money", "wallet"], ["📈", "sidebar-emoji-stocks", "trending-up"], ["🏦", "sidebar-emoji-bank", "landmark"], ["🧾", "sidebar-emoji-bills", "receipt"],
  ["📅", "sidebar-emoji-calendar", "calendar"], ["📌", "sidebar-emoji-projects", "pin"], ["📁", "sidebar-emoji-folder", "folder"], ["📰", "sidebar-emoji-news", "newspaper"],
  ["❤️", "sidebar-emoji-health", "heart"], ["🏃", "sidebar-emoji-sport", "activity"], ["🧘", "sidebar-emoji-wellbeing", "flower-2"], ["🌱", "sidebar-emoji-garden", "sprout"],
  ["🐾", "sidebar-emoji-pets", "paw-print"], ["👪", "sidebar-emoji-family", "users"], ["👶", "sidebar-emoji-baby", "baby"], ["🎁", "sidebar-emoji-gifts", "gift"],
  ["⚽", "sidebar-emoji-football", "trophy"], ["🚀", "sidebar-emoji-side-project", "rocket"], ["🔧", "sidebar-emoji-diy", "wrench"], ["🏡", "sidebar-emoji-real-estate", "building-2"],
  ["🌍", "sidebar-emoji-world", "globe"], ["⭐", "sidebar-emoji-favorites", "star"], ["🔒", "sidebar-emoji-private", "lock"], ["🧳", "sidebar-emoji-commuting", "train-front"],
];

const BY_EMOJI = new Map(SPACE_ICONS.map(([emoji, , icon]) => [emoji, icon]));
/** The line icon drawn for a space's emoji, if it has one. */
export const spaceIcon = (emoji: string): IconName | undefined => BY_EMOJI.get(emoji);
