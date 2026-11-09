import fs from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { DEFAULT_PROFILE, type BrowserState } from "../../shared/model";
import { initialState } from "./initial-state";

const FILE = "session.json";

const FavoriteSchema = z.object({ id: z.string(), url: z.string(), titre: z.string(), favicon: z.string().nullable() });

const SpaceV1Schema = z.object({ id: z.string(), nom: z.string(), icone: z.string(), epingles: z.array(FavoriteSchema) });

/** The fields common to versions 1 and 2. */
const CommonSchema = z
  .object({
    essentiels: z.array(FavoriteSchema),
    onglets: z.record(
      z.string(),
      z.object({
        id: z.string(),
        fenetreId: z.string(),
        espaceId: z.string(),
        url: z.string(),
        titre: z.string(),
        favicon: z.string().nullable(),
        lien: z.object({ type: z.enum(["essentiel", "epingle"]), id: z.string() }).nullable(),
        ouvertParAgent: z.boolean(),
        zoom: z.number(),
      }),
    ),
    fenetres: z
      .array(
        z.object({
          id: z.string(),
          espaceActif: z.string(),
          ordre: z.record(z.string(), z.array(z.string())),
          actif: z.record(z.string(), z.string().nullable()),
          compact: z.boolean(),
          panneauAgentOuvert: z.boolean(),
          fermesRecemment: z.array(z.object({ url: z.string(), espaceId: z.string() })),
          cadre: z.object({ x: z.number(), y: z.number(), largeur: z.number(), hauteur: z.number() }).nullable().default(null),
        }),
      )
      .min(1),
    reglages: z.object({ moteur: z.enum(["google", "duckduckgo", "qwant"]), profilAgent: z.string().min(1).default("claude"),
      largeurPanneauAgent: z.number().default(420),
    }),
  });

/** Version 1: before private spaces and login profiles. */
const SchemaV1 = CommonSchema.extend({ version: z.literal(1), espaces: z.array(SpaceV1Schema).min(1) });
const SchemaV2 = CommonSchema.extend({
  version: z.literal(2),
  espaces: z.array(SpaceV1Schema.extend({ prive: z.boolean(), profil: z.string().min(1) })).min(1),
  profils: z.array(z.object({ id: z.string().min(1) })),
});
const SchemaSession = z.discriminatedUnion("version", [SchemaV1, SchemaV2]);

/** Reads a saved session, whatever its version, as version 2. */
function enV2(lu: z.infer<typeof SchemaSession>): z.infer<typeof SchemaV2> {
  if (lu.version === 2) {
    // A login profile used by a space is always listed: otherwise it would be taken for a profile to erase.
    const missing = [...new Set(lu.espaces.map((e) => e.profil))].filter((id) => !lu.profils.some((p) => p.id === id));
    return missing.length ? { ...lu, profils: [...lu.profils, ...missing.map((id) => ({ id }))] } : lu;
  }
  // The earlier spaces stay visible to the agent, on the always-used partition: no login is lost.
  return { ...lu, version: 2, espaces: lu.espaces.map((e) => ({ ...e, prive: false, profil: DEFAULT_PROFILE })), profils: [{ id: DEFAULT_PROFILE }] };
}

/** A tab's volatile fields are not saved: they restart from their default value. */
const VOLATILE = { chargement: false, peutReculer: false, peutAvancer: false, plante: false, erreur: null };

/** Sets the session file aside under a unique name: the next save will not overwrite it. Returns that name. */
async function setAside(path: string, reason: "corrompu" | "illisible"): Promise<string | null> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (let i = 0; ; i++) {
    const name = `${path}.${timestamp}${i ? `-${i}` : ""}.${reason}`;
    try {
      await fs.access(name);
    } catch {
      return fs.rename(path, name).then(
        () => name,
        (e) => (console.error(`[session] impossible de garder ${path} de côté :`, e), null),
      );
    }
  }
}

/** `garde` receives the name under which an unreadable session was set aside, to tell the user. */
export async function chargerSession(dossier: string, kept?: (path: string) => void): Promise<BrowserState> {
  const path = join(dossier, FILE);
  let text: string;
  try {
    text = await fs.readFile(path, "utf8");
  } catch (e) {
    // Absent: first launch. Otherwise (permissions…), keep it rather than overwrite it at the next save.
    const name = (e as NodeJS.ErrnoException).code !== "ENOENT" && (await setAside(path, "illisible"));
    if (name) kept?.(name);
    return initialState();
  }
  try {
    const lu = enV2(SchemaSession.parse(JSON.parse(text)));
    return {
      ...lu,
      onglets: Object.fromEntries(Object.entries(lu.onglets).map(([id, o]) => [id, { ...o, ...VOLATILE }])),
    };
  } catch {
    const name = await setAside(path, "corrompu");
    if (name) kept?.(name);
    return initialState();
  }
}

/** Saves the session at most once per `delaiMs`, atomically (temporary file + rename). */
export class SessionRecorder {
  private enAttente: BrowserState | null = null;
  private minuterie: NodeJS.Timeout | undefined;
  /** Chained writes, never simultaneous. */
  private ecriture: Promise<void> = Promise.resolve();
  private numero = 0;

  constructor(
    private readonly dossier: string,
    private readonly delaiMs = 500,
  ) {}

  planifier(state: BrowserState): void {
    this.enAttente = state;
    this.minuterie ??= setTimeout(() => void this.vider(), this.delaiMs);
  }

  /** Writes the pending state; always waits for the end of the writes in progress (the app's exit depends on it). */
  vider(): Promise<void> {
    clearTimeout(this.minuterie);
    this.minuterie = undefined;
    const state = this.enAttente;
    this.enAttente = null;
    if (state) {
      this.ecriture = this.ecriture
        .then(() => this.ecrire(state))
        .catch((e) => {
          console.error("[session] écriture impossible :", e);
          // Retried at the next write or at exit, unless a more recent state is already there.
          this.enAttente ??= state;
        });
    }
    return this.ecriture;
  }

  private async ecrire(state: BrowserState): Promise<void> {
    const tabs = Object.fromEntries(
      Object.entries(state.onglets).map(([id, { chargement: load, peutReculer: canGoBack, peutAvancer: canAdvance, plante: crashes, erreur: error, ...rest }]) => [id, rest]),
    );
    const target = join(this.dossier, FILE);
    const temp = `${target}.${process.pid}.${++this.numero}.tmp`;
    await fs.mkdir(this.dossier, { recursive: true });
    try {
      const file = await fs.open(temp, "w");
      try {
        await file.writeFile(JSON.stringify({ ...state, onglets: tabs }, null, 2));
        await file.sync(); // on disk before the rename: a power cut does not leave an empty file
      } finally {
        await file.close();
      }
      await fs.rename(temp, target);
    } catch (e) {
      await fs.rm(temp, { force: true });
      throw e;
    }
  }
}
