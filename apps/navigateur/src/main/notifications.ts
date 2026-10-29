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
 * serait perdu. Avec `fichierTest` (tests e2e), une ligne JSON `{ titre, texte }` y est ajoutée et rien n'est montré ;
 * en mode invisible sans `fichierTest`, rien n'est montré non plus : aucun e2e ne doit faire apparaître une vraie notification.
 */
export function creerNotifieur(o: {
  creer: (opts: { title: string; body: string }) => NotificationLike;
  auClic: () => void;
  fichierTest?: string;
  /** Mode invisible (e2e) : sans `fichierTest`, rien n'est jamais montré. */
  invisible?: boolean;
}): (n: NotificationWidget) => void {
  const montrees = new Set<NotificationLike>();
  return (n) => {
    if (o.fichierTest) {
      appendFileSync(o.fichierTest, JSON.stringify({ titre: n.titre, texte: n.texte }) + "\n");
      return;
    }
    if (o.invisible) return;
    const notification = o.creer({ title: n.titre, body: n.texte });
    montrees.add(notification);
    notification.on("click", () => {
      montrees.delete(notification);
      o.auClic();
    });
    notification.show();
  };
}
