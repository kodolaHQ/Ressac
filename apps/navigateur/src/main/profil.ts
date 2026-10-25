import { app } from "electron";

/** Dossier du profil : WEBAIOS_PROFIL (tests) ou le dossier de données de l'app. */
export function cheminProfil(): string {
  return process.env.WEBAIOS_PROFIL ?? app.getPath("userData");
}
