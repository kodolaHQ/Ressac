import { t } from "../../i18n.svelte";
import { plainTitle } from "./markdown";

const LABEL_TYPES = new Set(["nom", "adresse", "carte", "iban", "tel", "email", "code", "id", "cle", "secu", "motdepasse", "date", "masque"]);
/** A chip's words for a label's kind: « nom masqué », « IBAN masqué »… */
export const maskedName = (type: string): string => t(LABEL_TYPES.has(type) ? `chat-masked-${type}` : "chat-masked-masque");
/** A discussion's title as shown: its labels as words, « Sans titre » when empty. */
export const chatTitle = (title: string | undefined): string => (title && plainTitle(title, maskedName)) || t("chat-untitled");
