import { appendFileSync } from "node:fs";
import type { NotificationWidget } from "@webaios/noyau";

/** Ce que le notifieur demande d'une notification : `Notification` d'Electron, ou une fausse dans les tests. */
export interface NotificationLike {
  on(evenement: "click", f: () => void): void;
  show(): void;
}

/**
 * Le rappel `notifier` du noyau : montre la notification de fin d'une veille (titre = nom du widget, texte = nombre de
 * nouveaux éléments, rien d'autre). Chaque notification montrée est gardée jusqu'à son clic : ramassée avant, son clic
 * serait perdu. Avec `fichierTest` (tests e2e), une ligne JSON `{ titre, texte }` y est ajoutée et rien n'est montré.
 */
export function creerNotifieur(o: {
  creer: (opts: { title: string; body: string }) => NotificationLike;
  auClic: () => void;
  fichierTest?: string;
}): (n: NotificationWidget) => void {
  const montrees = new Set<NotificationLike>();
  return (n) => {
    if (o.fichierTest) {
      appendFileSync(o.fichierTest, JSON.stringify({ titre: n.titre, texte: n.texte }) + "\n");
      return;
    }
    const notification = o.creer({ title: n.titre, body: n.texte });
    montrees.add(notification);
    notification.on("click", () => {
      montrees.delete(notification);
      o.auClic();
    });
    notification.show();
  };
}
