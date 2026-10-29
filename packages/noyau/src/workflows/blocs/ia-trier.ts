import { z } from "zod";
import { champsParElementSeulement, Gabarit, ParametresParElement, type DefinitionBloc } from "./communs.js";

// ia.trier note toujours élément par élément : `parElement` n'est pas un paramètre.
const { parElement: _parElement, ...parametresCommuns } = ParametresParElement;

export const definition: DefinitionBloc = {
  type: "ia.trier",
  libelle: "Trier avec Kev",
  famille: "IA",
  description: "Note chaque élément avec Kev et garde ceux qui passent le seuil.",
  entree: "requise",
  champs: [
    { nom: "question", libelle: "Question", aide: "Ce que Kev doit juger, par exemple « Est-ce intéressant ? ».", requis: true, defaut: "Est-ce intéressant ?", genre: "gabarit" },
    { nom: "texte", libelle: "Texte à juger", aide: "Les {chemins} sont remplacés par les valeurs de l'élément.", requis: true, defaut: "{titre}", genre: "gabarit" },
    { nom: "seuil", libelle: "Seuil", requis: false, defaut: 0.5, genre: "nombre", min: 0, max: 1 },
    { nom: "champ", libelle: "Champ de la note", requis: false, defaut: "p", genre: "texte" },
    // ia.trier note toujours élément par élément : les champs communs ne portent pas la marque « seulement par élément ».
    ...champsParElementSeulement().map(({ parElementSeulement: _marque, ...c }) => c),
  ],
  parElement: "toujours",
  chaine: false,
  parametres: z
    .object({
      question: Gabarit,
      texte: Gabarit,
      seuil: z.number().min(0).max(1).default(0.5),
      champ: z.string().min(1).max(40).default("p"),
      ...parametresCommuns,
    })
    .strict(),
};
