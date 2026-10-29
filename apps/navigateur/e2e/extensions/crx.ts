import { createHash, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { crc32 } from "node:zlib";

/**
 * Constructeur de CRX3 pour les tests (vitest et e2e) : jamais le vrai Chrome Web Store. Le zip est stocké sans
 * compression, l'en-tête protobuf (`CrxFileHeader`) est écrit à la main, la signature suit celle de Chromium :
 * RSA-SHA256 sur `"CRX3 SignedData\0"` + longueur de `signed_header_data` (4 octets LE) + `signed_header_data` + archive.
 */
export function construireCrx(
  dossierExtension: string,
  o: { cle?: KeyObject; signatureFausse?: boolean } = {},
): { crx: Buffer; id: string; cle: KeyObject } {
  const cle = o.cle ?? generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const publique = createPublicKey(cle).export({ type: "spki", format: "der" });
  const empreinte = createHash("sha256").update(publique).digest().subarray(0, 16);
  const id = [...empreinte.toString("hex")].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");

  const archive = zip(dossierExtension);
  const donneesSignees = champ(1, empreinte); // SignedData { crx_id }
  const taille = Buffer.alloc(4);
  taille.writeUInt32LE(donneesSignees.length, 0);
  const signe = Buffer.concat([Buffer.from("CRX3 SignedData\0", "utf8"), taille, donneesSignees, archive]);
  const signature = sign("sha256", signe, cle);
  if (o.signatureFausse) signature.writeUInt8(signature.readUInt8(signature.length - 1) ^ 0xff, signature.length - 1);

  const preuve = Buffer.concat([champ(1, publique), champ(2, signature)]); // AsymmetricKeyProof
  const entete = Buffer.concat([champ(2, preuve), champ(10000, donneesSignees)]); // CrxFileHeader
  const debut = Buffer.alloc(12);
  debut.write("Cr24", 0, "utf8");
  debut.writeUInt32LE(3, 4);
  debut.writeUInt32LE(entete.length, 8);
  return { crx: Buffer.concat([debut, entete, archive]), id, cle };
}

function varint(n: number): Buffer {
  const octets: number[] = [];
  while (n >= 0x80) {
    octets.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  octets.push(n);
  return Buffer.from(octets);
}

/** Champ protobuf de type « bytes » (wire type 2). */
function champ(numero: number, valeur: Buffer): Buffer {
  return Buffer.concat([varint(numero * 8 + 2), varint(valeur.length), valeur]);
}

function fichiers(dossier: string): string[] {
  return readdirSync(dossier, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

/** Zip minimal, entrées stockées (méthode 0). */
function zip(dossier: string): Buffer {
  const locaux: Buffer[] = [];
  const centraux: Buffer[] = [];
  let decalage = 0;
  for (const chemin of fichiers(dossier)) {
    const nom = Buffer.from(relative(dossier, chemin).split(sep).join("/"), "utf8");
    const donnees = readFileSync(chemin);
    const crc = crc32(donnees);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // noms en UTF-8
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(donnees.length, 18);
    local.writeUInt32LE(donnees.length, 22);
    local.writeUInt16LE(nom.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(donnees.length, 20);
    central.writeUInt32LE(donnees.length, 24);
    central.writeUInt16LE(nom.length, 28);
    central.writeUInt32LE(decalage, 42);
    locaux.push(local, nom, donnees);
    centraux.push(central, nom);
    decalage += local.length + nom.length + donnees.length;
  }
  const repertoire = Buffer.concat(centraux);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(centraux.length / 2, 8);
  fin.writeUInt16LE(centraux.length / 2, 10);
  fin.writeUInt32LE(repertoire.length, 12);
  fin.writeUInt32LE(decalage, 16);
  return Buffer.concat([...locaux, repertoire, fin]);
}
