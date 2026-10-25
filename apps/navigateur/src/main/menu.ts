import { app, Menu, type MenuItemConstructorOptions } from "electron";
import type { CommandeOnglet, Panneau, Raccourci } from "../commun/api";
import type { IdFenetre, IdOnglet } from "../commun/modele";

export interface CiblesMenu {
  /** Fenêtre principale au premier plan (ou la seule). */
  fenetreActive(): IdFenetre | undefined;
  ongletActif(fenetreId: IdFenetre): IdOnglet | undefined;
  commande(ongletId: IdOnglet, c: CommandeOnglet): void;
  basculerCompact(fenetreId: IdFenetre): void;
  ouvrirPanneau(fenetreId: IdFenetre, p: Panneau): void;
  raccourci(fenetreId: IdFenetre, r: Raccourci): void;
}

/** Menu de l'application ; ses raccourcis marchent aussi quand une page web a le focus. */
export function installerMenu(c: CiblesMenu): void {
  const surOnglet = (cmd: CommandeOnglet) => () => {
    const f = c.fenetreActive();
    const o = f && c.ongletActif(f);
    if (o) c.commande(o, cmd);
  };
  const versInterface = (r: Raccourci) => () => {
    const f = c.fenetreActive();
    if (f) c.raccourci(f, r);
  };
  const modele: MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    {
      label: "Édition",
      submenu: [
        { role: "undo", label: "Annuler" },
        { role: "redo", label: "Rétablir" },
        { type: "separator" },
        { role: "cut", label: "Couper" },
        { role: "copy", label: "Copier" },
        { role: "paste", label: "Coller" },
        { role: "selectAll", label: "Tout sélectionner" },
        { type: "separator" },
        { id: "rechercher", label: "Rechercher dans la page", accelerator: "CmdOrCtrl+F", click: versInterface("rechercher") },
        { id: "chercher-suivant", label: "Occurrence suivante", accelerator: "CmdOrCtrl+G", click: versInterface("chercherSuivant") },
        { id: "chercher-precedent", label: "Occurrence précédente", accelerator: "CmdOrCtrl+Shift+G", click: versInterface("chercherPrecedent") },
      ],
    },
    {
      label: "Affichage",
      submenu: [
        { id: "zoom-plus", label: "Zoom avant", accelerator: "CmdOrCtrl+Plus", click: surOnglet({ zoom: "plus" }) },
        { label: "Zoom avant", accelerator: "CmdOrCtrl+=", visible: false, acceleratorWorksWhenHidden: true, click: surOnglet({ zoom: "plus" }) },
        { id: "zoom-moins", label: "Zoom arrière", accelerator: "CmdOrCtrl+-", click: surOnglet({ zoom: "moins" }) },
        { id: "zoom-zero", label: "Taille réelle", accelerator: "CmdOrCtrl+0", click: surOnglet({ zoom: "zero" }) },
        { type: "separator" },
        {
          id: "compact",
          label: "Mode compact",
          accelerator: "CmdOrCtrl+Shift+S",
          click: () => {
            const f = c.fenetreActive();
            if (f) c.basculerCompact(f);
          },
        },
        ...(app.isPackaged ? [] : [{ type: "separator" } as const, { role: "toggleDevTools" } as const]),
      ],
    },
    {
      label: "Historique",
      submenu: [
        {
          id: "historique",
          label: "Afficher l'historique",
          accelerator: "CmdOrCtrl+Y",
          click: () => {
            const f = c.fenetreActive();
            if (f) c.ouvrirPanneau(f, "historique");
          },
        },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(modele));
}
