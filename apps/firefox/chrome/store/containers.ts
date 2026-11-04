import type { IdProfil } from "../../../navigateur/src/commun/modele";
import { PROFIL_DEFAUT } from "../../../navigateur/src/commun/modele";

const { ContextualIdentityService } = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");

/** Internal identity name of a login profile's container. */
export const internalName = (id: IdProfil) => `userContextIdInternal.webaios-${id}`;

/**
 * userContextId of a login profile: 0 for the default one, else a private container (invisible to add-ons) created on first use.
 * Not a policy identity: Firefox's enterprise policies (SitePolicies) wipe every policy identity they do not list.
 * shortcut: pushes onto ContextualIdentityService._identities, no public API makes a private non-policy identity; recheck after a Firefox upgrade.
 */
export function containerFor(profile: IdProfil): number {
  if (profile === PROFIL_DEFAUT) return 0;
  const name = internalName(profile);
  const found = ContextualIdentityService.getPrivateIdentity(name);
  if (found) return found.userContextId;
  ContextualIdentityService.ensureDataReady();
  const userContextId = ++ContextualIdentityService._lastUserContextId;
  ContextualIdentityService._identities.push({ userContextId, public: false, name });
  ContextualIdentityService.saveSoon();
  return userContextId;
}

/** userContextId of a login profile's container if it exists (0 for the default one), else null: never creates one. */
export function existingContainer(profile: IdProfil): number | null {
  if (profile === PROFIL_DEFAUT) return 0;
  return ContextualIdentityService.getPrivateIdentity(internalName(profile))?.userContextId ?? null;
}

/** Removes the container of a login profile and wipes its cookies and storage, as removePolicyIdentity does. */
export function removeContainer(profile: IdProfil): void {
  const { _identities: list } = ContextualIdentityService;
  const index = list.findIndex((i: { public: boolean; name: string }) => !i.public && i.name === internalName(profile));
  if (index === -1) return;
  Services.clearData.deleteDataFromOriginAttributesPattern({ userContextId: list[index].userContextId });
  list.splice(index, 1);
  ContextualIdentityService.saveSoon();
}

/**
 * Public `webaios-<id>` identities left by older builds become internal in place (same userContextId, so cookies and storage stay;
 * spike S4), unless the internal name is already taken (then left untouched). shortcut: edits ContextualIdentityService._identities; recheck after a Firefox upgrade.
 */
export function migrateContainers(): void {
  ContextualIdentityService.ensureDataReady();
  let changed = false;
  for (const i of ContextualIdentityService._identities) {
    if (!i.public || !i.name?.startsWith("webaios-")) continue;
    const name = `userContextIdInternal.${i.name}`;
    if (ContextualIdentityService.getPrivateIdentity(name)) continue;
    i.public = false;
    i.name = name;
    delete i.icon;
    delete i.color;
    delete i.l10nId;
    changed = true;
  }
  if (changed) ContextualIdentityService.saveSoon();
}
