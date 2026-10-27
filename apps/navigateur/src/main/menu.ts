import { app, Menu, type MenuItemConstructorOptions } from "electron";
import type { Action, CommandeOnglet, Panneau, Raccourci } from "../commun/api";
import type { EtatNavigateur, IdFenetre, IdOnglet, MoteurRecherche } from "../commun/modele";
import { versNieme, versVoisin } from "./raccourcis";

export interface CiblesMenu {
  /** Fenêtre principale au premier plan (ou la première si aucune n'a le focus) ; undefined si une popup a le focus. */
  fenetreActive(): IdFenetre | undefined;
  /** Ferme la popup au premier plan, s'il y en a une ; vrai si c'est le cas. */
  fermerPopup(): boolean;
  oublierAutorisations(fenetreId: IdFenetre): void;
  etat(): EtatNavigateur;
  agir(a: Action): void;
  commande(ongletId: IdOnglet, c: CommandeOnglet): void;
  ouvrirPanneau(fenetreId: IdFenetre, p: Panneau): void;
  /** Raccourci destiné à l'interface de la fenêtre (qui reçoit le focus). */
  raccourci(fenetreId: IdFenetre, r: Raccourci): void;
  fermerFenetre(fenetreId: IdFenetre): void;
  /** Ferme un onglet en laissant la page demander confirmation. */
  fermerOnglet(ongletId: IdOnglet): void;
  /** Plus aucune fenêtre ouverte (macOS) : rouvre celle(s) de l'état ; vrai si c'est le cas. */
  rouvrirFenetres(): boolean;
  /** Outils de développement de l'interface elle-même (développement seulement). */
  outilsInterface(fenetreId: IdFenetre): void;
  /** Agit sur la fenêtre d'application au premier plan, s'il y en a une ; vrai si c'est le cas. */
  surApplication(action: "recharger" | "outils" | "fermer"): boolean;
}

/** Menu de l'application ; ses raccourcis marchent aussi quand une page web a le focus. Chaque entrée a un id (tests). */
export function installerMenu(c: CiblesMenu): void {
  const dansFenetre = (faire: (f: IdFenetre) => void) => () => {
    const f = c.fenetreActive();
    if (f) faire(f);
  };
  const ongletActif = (f: IdFenetre) => {
    const fen = c.etat().fenetres.find((x) => x.id === f);
    return fen?.actif[fen.espaceActif] ?? undefined;
  };
  const surOnglet = (cmd: CommandeOnglet) =>
    dansFenetre((f) => {
      const o = ongletActif(f);
      if (o) c.commande(o, cmd);
    });
  const agirSi = (calcul: (f: IdFenetre) => Action | null) =>
    dansFenetre((f) => {
      const a = calcul(f);
      if (a) c.agir(a);
    });
  /** ⌘R, ⌥⌘I et ⌘W visent la fenêtre d'application au premier plan avant la fenêtre principale. */
  const appliOu = (action: "recharger" | "outils" | "fermer", sinon: () => void) => () => {
    if (!c.surApplication(action)) sinon();
  };
  const entree = (id: string, label: string, accelerator: string | undefined, click: () => void, extra: Partial<MenuItemConstructorOptions> = {}) =>
    ({ id, label, accelerator, click, ...extra }) satisfies MenuItemConstructorOptions;

  const moteurs: [MoteurRecherche, string][] = [
    ["google", "Google"],
    ["duckduckgo", "DuckDuckGo"],
    ["qwant", "Qwant"],
  ];
  const moteurActuel = c.etat().reglages.moteur;
  const modele: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about", label: `À propos de ${app.name}` },
        { type: "separator" },
        {
          label: "Moteur de recherche",
          submenu: moteurs.map(([id, label]) =>
            entree(`moteur-${id}`, label, undefined, () => c.agir({ type: "choisirMoteur", moteur: id }), { type: "radio", checked: id === moteurActuel }),
          ),
        },
        { type: "separator" },
        { role: "services", label: "Services" },
        { type: "separator" },
        { role: "hide", label: `Masquer ${app.name}` },
        { role: "hideOthers", label: "Masquer les autres" },
        { role: "unhide", label: "Tout afficher" },
        { type: "separator" },
        { role: "quit", label: `Quitter ${app.name}` },
      ],
    },
    {
      label: "Fichier",
      submenu: [
        entree("nouvel-onglet", "Nouvel onglet", "CmdOrCtrl+T", dansFenetre((f) => {
          c.agir({ type: "afficherPageVide", fenetreId: f });
          c.raccourci(f, "adresse");
        })),
        entree("nouvelle-fenetre", "Nouvelle fenêtre", "CmdOrCtrl+N", () => {
          if (c.rouvrirFenetres()) return;
          const f = c.fenetreActive();
          const espaceId = c.etat().fenetres.find((x) => x.id === f)?.espaceActif;
          c.agir({ type: "ouvrirFenetre", ...(espaceId ? { espaceId } : {}) });
        }),
        entree("rouvrir-onglet", "Rouvrir l'onglet fermé", "CmdOrCtrl+Shift+T", dansFenetre((f) => c.agir({ type: "rouvrirOngletFerme", fenetreId: f }))),
        { type: "separator" },
        entree("fermer-onglet", "Fermer l'onglet", "CmdOrCtrl+W", () => {
          if (c.surApplication("fermer") || c.fermerPopup()) return;
          const f = c.fenetreActive();
          if (!f) return;
          const o = ongletActif(f);
          if (o) c.fermerOnglet(o);
          // Page vide : ⌘W ferme la fenêtre, seulement si aucun de ses espaces n'a d'onglet.
          else if (!Object.values(c.etat().onglets).some((x) => x.fenetreId === f)) c.fermerFenetre(f);
        }),
        entree("fermer-fenetre", "Fermer la fenêtre", "CmdOrCtrl+Shift+W", () => {
          if (!c.fermerPopup()) dansFenetre((f) => c.fermerFenetre(f))();
        }),
      ],
    },
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
        entree("rechercher", "Rechercher dans la page", "CmdOrCtrl+F", dansFenetre((f) => c.raccourci(f, "rechercher"))),
        entree("chercher-suivant", "Occurrence suivante", "CmdOrCtrl+G", dansFenetre((f) => c.raccourci(f, "chercherSuivant"))),
        entree("chercher-precedent", "Occurrence précédente", "CmdOrCtrl+Shift+G", dansFenetre((f) => c.raccourci(f, "chercherPrecedent"))),
      ],
    },
    {
      label: "Affichage",
      submenu: [
        entree("adresse", "Barre d'adresse", "CmdOrCtrl+L", dansFenetre((f) => c.raccourci(f, "adresse"))),
        entree("recharger", "Recharger", "CmdOrCtrl+R", appliOu("recharger", surOnglet("recharger"))),
        entree("recharger-sans-cache", "Recharger sans le cache", "CmdOrCtrl+Shift+R", surOnglet("rechargerSansCache")),
        { type: "separator" },
        entree("zoom-plus", "Zoom avant", "CmdOrCtrl+Plus", surOnglet({ zoom: "plus" })),
        entree("zoom-plus-egal", "Zoom avant", "CmdOrCtrl+=", surOnglet({ zoom: "plus" }), { visible: false, acceleratorWorksWhenHidden: true }),
        entree("zoom-moins", "Zoom arrière", "CmdOrCtrl+-", surOnglet({ zoom: "moins" })),
        entree("zoom-zero", "Taille réelle", "CmdOrCtrl+0", surOnglet({ zoom: "zero" })),
        { type: "separator" },
        entree("compact", "Mode compact", "CmdOrCtrl+Shift+S", dansFenetre((f) => c.agir({ type: "basculerCompact", fenetreId: f }))),
        entree(
          "panneau-agent",
          "Panneau agent",
          "CmdOrCtrl+J",
          dansFenetre((f) => {
            c.agir({ type: "basculerPanneauAgent", fenetreId: f });
            // Ouvert depuis une page web : le clavier doit quitter la page pour le terminal.
            if (c.etat().fenetres.find((x) => x.id === f)?.panneauAgentOuvert) c.raccourci(f, "agent");
          }),
        ),
        entree("applications", "Applications", "CmdOrCtrl+Shift+A", dansFenetre((f) => c.agir({ type: "ouvrirApplications", fenetreId: f }))),
        { type: "separator" },
        entree("outils-page", "Outils de développement de la page", "Alt+CmdOrCtrl+I", appliOu("outils", surOnglet("outils"))),
        ...(app.isPackaged ? [] : [entree("outils-interface", "Outils de développement de l'interface", undefined, dansFenetre((f) => c.outilsInterface(f)))]),
      ],
    },
    {
      label: "Navigation",
      submenu: [
        entree("oublier-autorisations", "Oublier les autorisations de ce site", undefined, dansFenetre((f) => c.oublierAutorisations(f))),
        { type: "separator" },
        entree("reculer", "Reculer", "CmdOrCtrl+[", surOnglet("reculer")),
        entree("avancer", "Avancer", "CmdOrCtrl+]", surOnglet("avancer")),
        { type: "separator" },
        entree("onglet-suivant", "Onglet suivant", "Ctrl+Tab", agirSi((f) => versVoisin(c.etat(), f, 1))),
        entree("onglet-precedent", "Onglet précédent", "Ctrl+Shift+Tab", agirSi((f) => versVoisin(c.etat(), f, -1))),
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) =>
          entree(`onglet-${n}`, n === 9 ? "Dernier onglet" : `Onglet ${n}`, `CmdOrCtrl+${n}`, agirSi((f) => versNieme(c.etat(), f, n))),
        ),
        { type: "separator" },
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) =>
          entree(`espace-${n}`, `Espace ${n}`, `Ctrl+${n}`, agirSi((f) => {
            const espace = c.etat().espaces[n - 1];
            return espace ? { type: "activerEspace", fenetreId: f, id: espace.id } : null;
          })),
        ),
      ],
    },
    {
      label: "Historique",
      submenu: [
        entree("historique", "Afficher l'historique", "CmdOrCtrl+Y", dansFenetre((f) => c.ouvrirPanneau(f, "historique"))),
        entree("telechargements", "Téléchargements", "CmdOrCtrl+Shift+J", dansFenetre((f) => c.ouvrirPanneau(f, "telechargements"))),
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(modele));
}
