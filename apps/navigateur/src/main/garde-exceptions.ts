// Importé en tout premier par index.ts, avant toute dépendance : une exception levée au chargement d'un module
// (bibliothèque d'extensions comprise) ouvrirait sinon une boîte de dialogue native visible.
// Une exception oubliée ne doit ni figer l'app derrière une boîte de dialogue, ni la quitter : on la journalise.
process.on("uncaughtException", (e) => console.error("[webaios] exception non rattrapée :", e));
